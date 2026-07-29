import { ipcMain } from 'electron'
import type { RecordingSettings } from '../../shared/types'
import { getRecordingSettings, saveRecordingSettings } from '../db/repository'

// The recorder's IPC surface. Pull-only for now, matching every other
// channel in the app; the push side (recorder:state, recorder:progress) is
// introduced with the state machine, along with a pull equivalent for each
// pushed channel so a renderer mounting mid-recording can ask what's
// happening instead of waiting for the next update.
export function registerRecorderHandlers(): void {
  ipcMain.handle('recorder:getSettings', () => getRecordingSettings())

  ipcMain.handle('recorder:saveSettings', (_e, settings: RecordingSettings) => {
    saveRecordingSettings(settings)
    // Echoed back rather than returning void: the stored row is merged over
    // the current defaults on read, so what the renderer gets back is the
    // configuration that will actually be used, not just what it sent.
    return getRecordingSettings()
  })
}
