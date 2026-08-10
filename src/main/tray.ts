import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import type { RecorderStateSnapshot } from '../shared/types'
import { getRecordingSettings, saveRecordingSettings } from './db/repository'
import {
  getRecorderState,
  isReplayBufferActive,
  saveReplay,
  setRecordingEnabled,
  stopRecording
} from './recorder/recorderService'
import { describePhase } from './recorder/recorderState'

// The tray icon, which is what makes LeagueVid useful with its window closed.
//
// The tooltip carries the recorder's actual state rather than just the app name:
// with the window hidden, this is the only place the user can find out whether a
// game is being recorded, and "is it recording right now" is the one question
// this feature must always be able to answer.

let tray: Tray | null = null
let showWindow: (() => void) | null = null
let requestQuit: (() => void) | null = null
let startManualCapture: (() => Promise<void>) | null = null

export interface TrayHooks {
  onShowWindow: () => void
  onQuit: () => void
  /** Resolves the display and settings, then starts a manual recording. */
  onStartManual: () => Promise<void>
}

/**
 * Loads the tray image.
 *
 * Falls back to an empty image rather than throwing: a missing icon file should
 * cost a nice-looking tray entry, not the whole background-mode feature. An
 * empty nativeImage still produces a clickable tray item on Windows.
 */
function trayImage(): Electron.NativeImage {
  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(process.resourcesPath, 'icon.png')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const image = nativeImage.createFromPath(candidate)
      if (!image.isEmpty()) return image.resize({ width: 16, height: 16 })
    }
  }
  return nativeImage.createEmpty()
}

export function createRecorderTray(hooks: TrayHooks): void {
  if (tray) return

  showWindow = hooks.onShowWindow
  requestQuit = hooks.onQuit
  startManualCapture = hooks.onStartManual

  tray = new Tray(trayImage())
  tray.setToolTip('LeagueVid')
  // Clicking the icon reopens the window, which is what people expect from a
  // tray app and avoids making the menu the only way back in.
  tray.on('click', () => showWindow?.())

  refreshTray(getRecorderState())
}

export function destroyRecorderTray(): void {
  tray?.destroy()
  tray = null
}

/** Rebuilds the menu and tooltip for the current state. */
export function refreshTray(state: RecorderStateSnapshot): void {
  if (!tray) return

  const settings = getRecordingSettings()
  const canStop = state.phase === 'recording' || state.phase === 'starting'
  const busy =
    canStop ||
    state.phase === 'arming' ||
    state.phase === 'stopping' ||
    state.phase === 'remuxing' ||
    state.phase === 'finalizing'

  tray.setToolTip(`LeagueVid — ${describePhase(state)}`)

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open LeagueVid', click: () => showWindow?.() },
      { type: 'separator' },
      {
        label: 'Record games automatically',
        type: 'checkbox',
        checked: settings.enabled,
        click: (item) => {
          saveRecordingSettings({ ...getRecordingSettings(), enabled: item.checked })
          refreshTray(setRecordingEnabled(item.checked))
        }
      },
      {
        label: 'Save replay',
        // Only meaningful while the ring is being written; the buffer cannot be
        // switched on mid-recording because it's part of the same encode.
        enabled: isReplayBufferActive(),
        click: () => {
          saveReplay().catch((err) => console.error('[recorder] replay save failed', err))
        }
      },
      {
        label: canStop ? 'Stop recording' : 'Record now',
        // Disabled during remux/finalize: starting then would race the session
        // that's still being written.
        enabled: canStop || !busy,
        click: () => {
          if (canStop) void stopRecording('Stopped from the tray')
          else void startManualCapture?.()
        }
      },
      { type: 'separator' },
      { label: 'Quit LeagueVid', click: () => requestQuit?.() }
    ])
  )
}
