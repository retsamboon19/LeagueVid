import { ipcMain, screen } from 'electron'
import type { EncoderCapabilities, RecordingSettings } from '../../shared/types'
import {
  getEncoderCapabilitiesCache,
  getRecordingSettings,
  saveEncoderCapabilitiesCache,
  saveRecordingSettings
} from '../db/repository'
import { listAudioDevices } from './audioDevices'
import { mapDisplaysToOutputs } from './displays'
import { probeEncoders } from './encoderCapabilities'
import { ffmpegBinaryPath } from './ffmpegBinary'

// The recorder's IPC surface. Pull-only for now, matching every other
// channel in the app; the push side (recorder:state, recorder:progress) is
// introduced with the state machine, along with a pull equivalent for each
// pushed channel so a renderer mounting mid-recording can ask what's
// happening instead of waiting for the next update.

/**
 * In-flight probe, if any. Probing spawns a child per candidate and takes
 * seconds, so two renderers asking at once -- or a user clicking re-detect
 * twice -- must share one run rather than starting competing probes. Parallel
 * hardware encoder inits can contend and produce false negatives.
 */
let probeInFlight: Promise<EncoderCapabilities> | null = null

async function runProbe(): Promise<EncoderCapabilities> {
  if (probeInFlight) return probeInFlight

  probeInFlight = probeEncoders(ffmpegBinaryPath())
    .then((capabilities) => {
      saveEncoderCapabilitiesCache(capabilities)
      return capabilities
    })
    .finally(() => {
      probeInFlight = null
    })

  return probeInFlight
}

export function registerRecorderHandlers(): void {
  ipcMain.handle('recorder:getSettings', () => getRecordingSettings())

  ipcMain.handle('recorder:saveSettings', (_e, settings: RecordingSettings) => {
    saveRecordingSettings(settings)
    // Echoed back rather than returning void: the stored row is merged over
    // the current defaults on read, so what the renderer gets back is the
    // configuration that will actually be used, not just what it sent.
    return getRecordingSettings()
  })

  // Cached result if there is one, otherwise probe now. First call after
  // install pays the cost; every later launch reads the row.
  ipcMain.handle('recorder:getCapabilities', async () => {
    return getEncoderCapabilitiesCache() ?? (await runProbe())
  })

  // Explicit re-detect, for a new GPU or a driver update.
  ipcMain.handle('recorder:refreshCapabilities', () => runProbe())

  // Monitors, mapped onto the ddagrab output index that (probably) captures
  // each one. Read live rather than cached: a display can be plugged in
  // between opening Settings and starting a game.
  ipcMain.handle('recorder:listDisplays', () => {
    return mapDisplaysToOutputs(
      screen.getAllDisplays().map((d) => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        internal: d.internal,
        label: d.label,
        rotation: d.rotation
      })),
      screen.getPrimaryDisplay().id
    )
  })

  ipcMain.handle('recorder:listAudioDevices', () => listAudioDevices(ffmpegBinaryPath()))
}
