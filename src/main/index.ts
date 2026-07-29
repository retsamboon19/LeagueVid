import { app, shell, BrowserWindow, protocol } from 'electron'
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
import { initRecorderService } from './recorder/recorderService'

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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
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

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Writes are debounced, so anything still queued has to be flushed before
// the process goes away or the last few changes would be lost.
app.on('before-quit', () => {
  flushPersist()
})

app.on('window-all-closed', () => {
  stopBackfillService()
  flushPersist()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
