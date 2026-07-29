import { ipcMain, screen } from 'electron'
import type {
  CaptureDisplay,
  EncoderCapabilities,
  RecordingLinkState,
  RecordingSettings
} from '../../shared/types'
import {
  bumpRecordingLinkAttempt,
  getEncoderCapabilitiesCache,
  getRecordingSettings,
  listPendingLinkRecordings,
  listRecordings,
  saveEncoderCapabilitiesCache,
  saveRecordingSettings,
  updateRecording
} from '../db/repository'
import { listAudioDevices } from './audioDevices'
import { mapDisplaysToOutputs, resolveCaptureDisplay } from './displays'
import { applyLaunchAtLogin } from '../tray'
import { resolveAudioInputs } from './autoRecorderHost'
import { probeEncoders } from './encoderCapabilities'
import { estimateTotalBitrateKbps, formatStorageEstimate, gigabytesPerHour } from './estimates'
import type { CaptureTarget } from './ffmpegArgs'
import { runPreflightTest } from './preflight'
import {
  QUALITY_PRESETS,
  applyPreset,
  detectPreset,
  type QualityPresetName
} from './presets'
import { getDiskUsage, previewRetentionSweep, runRetentionSweep } from './retentionService'
import { ffmpegBinaryPath } from './ffmpegBinary'
import {
  getRecorderState,
  hasActiveCapture,
  saveReplay,
  setRecordingEnabled,
  startRecording,
  stopRecording
} from './recorderService'

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
    // Applied here rather than at startup so the OS registration always matches
    // what the user last chose, including after they turn it off.
    applyLaunchAtLogin(settings.launchAtLogin)
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
  ipcMain.handle('recorder:listDisplays', () => currentDisplays())

  ipcMain.handle('recorder:listAudioDevices', () => listAudioDevices(ffmpegBinaryPath()))

  // Pull equivalent of the recorder:state push. A renderer that mounts
  // mid-recording has missed every push so far; without this it would show an
  // idle recorder until something happened to change.
  ipcMain.handle('recorder:getState', () => getRecorderState())

  // Pull equivalent of recorder:progress -- the latest sample lives on the
  // state snapshot, so a late-mounting renderer gets the current fps and size
  // rather than waiting up to a second for the next push.
  ipcMain.handle('recorder:getProgress', () => getRecorderState().progress)

  ipcMain.handle('recorder:setEnabled', (_e, enabled: boolean) => {
    // Persisted as well as applied, so the setting survives a restart.
    saveRecordingSettings({ ...getRecordingSettings(), enabled })
    return setRecordingEnabled(enabled)
  })

  ipcMain.handle('recorder:startManual', async () => {
    const settings = getRecordingSettings()
    const displays = currentDisplays()
    const resolved = resolveCaptureDisplay(displays, settings.displayId)

    if (!resolved) {
      throw new Error('No display was found to record.')
    }

    return startRecording({
      manual: true,
      target: {
        outputIdx: resolved.display.outputIdx,
        width: resolved.display.width,
        height: resolved.display.height,
        // HDR detection needs a Windows API Electron doesn't expose; until the
        // preflight test can tell us, assume SDR. ddagrab is given
        // allow_fallback=1 either way, so an HDR display still captures.
        isHdr: false
      },
      fallbackEncoder: getEncoderCapabilitiesCache()?.chosen ?? 'libx264',
      audioInputs: await resolveAudioInputs()
    })
  })

  ipcMain.handle('recorder:stopManual', () => stopRecording('Stopped by hand'))

  // Saves the last N seconds from the ring the capture is already writing. The
  // recording carries on: pressing this after a good play must not risk the
  // rest of the game.
  ipcMain.handle('recorder:saveReplay', () => saveReplay())

  // --- Linking queue ---
  // Recordings finish whether or not a window is open, so the queue is drained
  // from the renderer on mount rather than only in response to a push.
  ipcMain.handle('recorder:getPendingLinks', () => listPendingLinkRecordings())

  ipcMain.handle(
    'recorder:setLinkState',
    (_e, input: { recordingId: number; state: RecordingLinkState }) =>
      updateRecording(input.recordingId, { linkState: input.state })
  )

  ipcMain.handle('recorder:bumpLinkAttempt', (_e, recordingId: number) =>
    bumpRecordingLinkAttempt(recordingId)
  )

  ipcMain.handle('recorder:listRecordings', () => listRecordings())

  // --- Quality presets and preflight ---

  ipcMain.handle('recorder:applyPreset', (_e, preset: QualityPresetName) => {
    const next = applyPreset(getRecordingSettings(), preset)
    saveRecordingSettings(next)
    return next
  })

  ipcMain.handle('recorder:getPresets', () => ({
    presets: QUALITY_PRESETS,
    active: detectPreset(getRecordingSettings())
  }))

  // What the current configuration is expected to cost. Modelled, not measured
  // -- which is why the preflight test exists alongside it.
  ipcMain.handle('recorder:estimateBitrate', () => {
    const settings = getRecordingSettings()
    const target = captureTargetForSettings(settings)
    if (!target) return null

    const audioTracks = audioTrackCount(settings)
    return {
      totalKbps: estimateTotalBitrateKbps({ settings, target }, audioTracks),
      gbPerHour: gigabytesPerHour(estimateTotalBitrateKbps({ settings, target }, audioTracks)),
      summary: formatStorageEstimate({ settings, target }, audioTracks)
    }
  })

  // --- Disk usage and retention ---

  ipcMain.handle('recorder:getDiskUsage', () => getDiskUsage())

  // The dry run. Deliberately a separate channel from the sweep so that
  // previewing can never be mistaken for performing.
  ipcMain.handle('recorder:previewRetentionSweep', () => previewRetentionSweep())

  ipcMain.handle('recorder:runRetentionSweep', () => runRetentionSweep())

  // Records for real, briefly, and reports what happened. Refuses to run while
  // a genuine recording is in progress: two captures of the same display would
  // contend for the encoder and mismeasure both.
  ipcMain.handle('recorder:runPreflightTest', async () => {
    if (hasActiveCapture()) {
      throw new Error('A recording is already running. Stop it before running the test.')
    }

    const settings = getRecordingSettings()
    const target = captureTargetForSettings(settings)
    if (!target) throw new Error('No display was found to record.')

    return runPreflightTest({
      settings,
      target,
      audioInputs: [],
      fallbackEncoder: getEncoderCapabilitiesCache()?.chosen ?? 'libx264'
    })
  })
}

/** The display the current settings would capture, as a capture target. */
function captureTargetForSettings(settings: RecordingSettings): CaptureTarget | null {
  const resolved = resolveCaptureDisplay(currentDisplays(), settings.displayId)
  if (!resolved) return null
  return {
    outputIdx: resolved.display.outputIdx,
    width: resolved.display.width,
    height: resolved.display.height,
    isHdr: false
  }
}

function audioTrackCount(settings: RecordingSettings): number {
  let count = settings.micDeviceName ? 1 : 0
  if (settings.desktopAudioDeviceName || settings.useLoopbackBridge) count += 1
  return count
}

function currentDisplays(): CaptureDisplay[] {
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
}
