import { app, shell, BrowserWindow, protocol, powerSaveBlocker, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb, flushPersist } from './db'
import { registerRiotHandlers } from './riot/ipc'
import { registerDbHandlers } from './db/ipc'
import { registerVideoHandlers } from './video/ipc'
import { registerMediaProtocol } from './video/mediaProtocol'
import { registerDDragonHandlers } from './ddragon/ipc'
import { registerRecorderHandlers } from './recorder/ipc'
import { startBackfillService, stopBackfillService } from './riot/backfillService'
import { recoverInterruptedRecordings } from './recorder/orphanRecovery'
import {
  currentSessionCompletion,
  getRecorderState,
  hasActiveCapture,
  initRecorderService,
  onRecorderStateChange,
  saveReplay,
  startRecording,
  stopRecording
} from './recorder/recorderService'
import { startAutoRecording, stopAutoRecording, currentCaptureTarget } from './recorder/autoRecorderHost'
import { getEncoderCapabilitiesCache, getRecordingSettings } from './db/repository'
import { createRecorderTray, destroyRecorderTray, launchedHidden, refreshTray } from './tray'
import { shutdownForQuit } from './recorder/shutdown'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'leaguevid-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

// A second launch must not start a second recorder: two ffmpeg processes
// duplicating the same display would halve the available encoder throughput and
// produce two half-broken files. The first instance takes the lock and every
// later launch just focuses it.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

/** Set once quitting has genuinely been requested, so 'close' stops hiding. */
let isQuitting = false

/** Held while recording, so Windows doesn't sleep mid-game. */
let powerSaveBlockerId: number | null = null

function createWindow(options: { show?: boolean } = {}): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow = window

  window.on('ready-to-show', () => {
    // Launched by the login item: stay out of the way. The tray is how the user
    // gets to the window, and showing it unasked on every boot would be the
    // fastest way to get the login item switched off again.
    if (options.show !== false) window.show()
  })

  // Closing hides rather than destroys, so games keep being recorded after the
  // user has "closed" the app. Only a real quit gets through.
  window.on('close', (event) => {
    if (isQuitting) return
    if (!getRecordingSettings().enabled) return
    event.preventDefault()
    window.hide()
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // Windows is shutting down, restarting, or logging the user out.
  //
  // There is no time to remux here, so this is a best-effort graceful stop:
  // writing 'q' to ffmpeg means the Matroska file still gets its index and the
  // next launch can recover it, where being hard-killed by the OS would leave
  // it truncated. This is a BrowserWindow event rather than an app one.
  window.on('session-end', () => {
    isQuitting = true
    if (hasActiveCapture()) void stopRecording('Windows is shutting down')
    flushPersist()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ show: true })
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Keeps the machine awake while recording.
 *
 * A game keeps Windows awake by itself, but the post-game stop delay and the
 * remux can run after the user has walked away -- and a sleep mid-remux is how
 * a recording ends up as an orphaned Matroska file.
 */
function syncPowerSaveBlocker(recording: boolean): void {
  if (recording && powerSaveBlockerId == null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    return
  }
  if (!recording && powerSaveBlockerId != null) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId)
    powerSaveBlockerId = null
  }
}

/**
 * Binds the replay-save hotkey.
 *
 * A global shortcut is the only kind that works here: the point of a replay
 * buffer is pressing a key while the game has focus, so an in-app shortcut would
 * never fire. Registration can legitimately fail when another program already
 * owns the combination, which is reported rather than thrown -- a taken hotkey
 * should not stop the app from starting.
 */
function registerReplayHotkey(): void {
  const hotkey = getRecordingSettings().replayHotkey
  globalShortcut.unregisterAll()
  if (!hotkey) return

  try {
    const registered = globalShortcut.register(hotkey, () => {
      saveReplay()
        .then((result) => console.log(`[recorder] replay saved: ${result.outputPath}`))
        .catch((err) => console.error(`[recorder] replay save failed: ${err.message}`))
    })
    if (!registered) {
      console.warn(`[recorder] the hotkey ${hotkey} is already in use by another program`)
    }
  } catch (err) {
    console.warn(`[recorder] could not register ${hotkey}: ${(err as Error).message}`)
  }
}

async function startManualRecording(): Promise<void> {
  const target = currentCaptureTarget()
  if (!target) return
  await startRecording({
    manual: true,
    target,
    fallbackEncoder: getEncoderCapabilitiesCache()?.chosen ?? 'libx264'
  })
}

app.on('second-instance', () => {
  showMainWindow()
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return

  electronApp.setAppUserModelId('com.leaguevid.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize the (WASM) SQLite database before wiring up DB IPC handlers.
  await initDb()

  registerMediaProtocol()
  registerRiotHandlers()
  registerDbHandlers()
  registerVideoHandlers()
  registerDDragonHandlers()

  // Reads the persisted enabled flag, so the recorder's reported state matches
  // the setting from the moment the first window opens.
  initRecorderService()
  registerRecorderHandlers()

  // The tray tooltip and menu follow the recorder, and the power-save blocker
  // is held for exactly as long as a session is in flight.
  onRecorderStateChange((state) => {
    refreshTray(state)
    syncPowerSaveBlocker(
      state.phase === 'starting' || state.phase === 'recording' || state.phase === 'stopping'
    )
  })

  registerReplayHotkey()

  createRecorderTray({
    onShowWindow: showMainWindow,
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    onStartManual: startManualRecording
  })

  // Watches for a League game and records it. The watcher runs regardless of
  // whether recording is enabled -- it's a 2-second loopback request -- and the
  // enabled check happens when a game is actually found, so toggling the
  // setting takes effect without a restart.
  startAutoRecording()

  // Continuously warms the local Riot match/timeline cache in the
  // background (lowest priority -- never competes with user-triggered
  // requests) so linking videos later hits the cache instead of the API.
  startBackfillService()

  // A recording session left mid-flight by a crash or a forced quit still has
  // its Matroska file on disk -- that's why sessions are recorded as Matroska.
  // Repair and import it before the window opens, so the library shows the
  // finished recording rather than nothing at all. Deliberately not awaited:
  // remuxing a long recording takes seconds, and the UI shouldn't wait.
  recoverInterruptedRecordings()
    .then((outcomes) => {
      for (const outcome of outcomes) {
        console.log(`[recorder] recovered ${outcome.recordingId}: ${outcome.result} -- ${outcome.note}`)
      }
    })
    .catch((err) => console.error('[recorder] recovery failed', err))

  createWindow({ show: !launchedHidden() })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ show: true })
    else showMainWindow()
  })
})

// Quitting while recording must not leave a half-written file behind, so the
// quit is deferred until the session has been stopped, converted and imported.
// Bounded: a wedged encoder must not make the app unquittable, because a user
// who can't close a program kills it -- which skips this path entirely.
let shutdownInProgress = false

app.on('before-quit', (event) => {
  isQuitting = true

  if (hasActiveCapture() && !shutdownInProgress) {
    event.preventDefault()
    shutdownInProgress = true

    shutdownForQuit({
      isCapturing: hasActiveCapture,
      stopCapture: async () => {
        await stopRecording('Closing LeagueVid')
      },
      sessionCompletion: currentSessionCompletion,
      onStep: (step) => console.log(`[recorder] quit: ${step}`)
    })
      .catch((err) => console.error('[recorder] shutdown failed', err))
      .finally(() => {
        flushPersist()
        app.quit()
      })
    return
  }

  // Writes are debounced, so anything still queued has to be flushed before
  // the process goes away or the last few changes would be lost.
  flushPersist()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopBackfillService()
  stopAutoRecording()
  destroyRecorderTray()
  syncPowerSaveBlocker(false)
})

// Deliberately does NOT quit. Closing the window is how someone puts LeagueVid
// in the background, and quitting there would mean the next game goes
// unrecorded -- which is the whole point of having a tray.
app.on('window-all-closed', () => {
  flushPersist()
})

// Recording is the reason the app can outlive its window, so the state is worth
// logging at exit for anyone diagnosing a missing recording.
app.on('quit', () => {
  const state = getRecorderState()
  if (state.phase !== 'idle' && state.phase !== 'disabled') {
    console.log(`[recorder] quit while ${state.phase}: ${state.detail ?? ''}`)
  }
})
