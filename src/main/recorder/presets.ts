import type { RecorderProgress, RecordingFramerate, RecordingSettings } from '../../shared/types'
import { FRAMERATE_OPTIONS } from '../../shared/types'
import { outputHeightFor, recommendedBitrateKbps } from '../../shared/bitrateAdvice'
import { assessCaptureHealth } from './progressParser'

// Quality presets, and the logic that reads a preflight result.
//
// Pure, so the recommendations can be tested against known measurements rather
// than by recording until something looks wrong.
//
// The preset values assume a working hardware encoder, which is what capability
// probing found on this machine (NVENC H.264, passing in 285ms). On a machine
// where only libx264 passes, high is genuinely too much and the recommendation
// logic below is what says so -- rather than the presets pretending otherwise.

export type QualityPresetName = 'low' | 'medium' | 'high' | 'custom'

export interface QualityPreset {
  name: QualityPresetName
  label: string
  /** One-line spec, e.g. 'Efficient - 720p 30fps'. */
  summary: string
  description: string
  /** Applied over the current settings. */
  values: Pick<
    RecordingSettings,
    | 'resolutionScale'
    | 'framerate'
    | 'rateControl'
    | 'bitrateKbps'
    | 'quality'
    | 'keyframeIntervalSeconds'
  >
}

export interface PresetContext {
  /** Physical height of the display being captured. */
  displayHeight: number
  displayWidth: number
  /** Refresh rate, when known. */
  refreshHz: number | null
  /** Whether a hardware encoder passed probing. */
  hasHardwareEncoder: boolean
}

/**
 * Presets built for the machine they'll run on.
 *
 * Fixed tiers were the wrong idea. "High = 1080p60 at 8 Mbps" is generous on a
 * laptop and insulting on a 1440p 240Hz desktop with an RTX card, and the first
 * version of this file shipped the second case -- which is exactly the complaint
 * it earned. Resolution, framerate and bitrate are now derived from the display
 * and from whether a hardware encoder actually works here.
 *
 * The other correction: on capable hardware the presets prefer *native*
 * resolution. Scaling is not free in this pipeline -- the bundled ffmpeg has no
 * working CUDA device, so scaling means a hwdownload round trip through system
 * memory. Measured on a 1440p display, native capture dropped 0 frames while the
 * scaled path dropped 1 and duplicated 35. Native is both faster and sharper;
 * bitrate is the right lever for file size.
 */
export function buildQualityPresets(context: PresetContext): QualityPreset[] {
  const { displayHeight, refreshHz, hasHardwareEncoder } = context

  // Software encoding is the one case that genuinely needs modest settings: it
  // spends CPU the game also wants.
  const topScale: RecordingSettings['resolutionScale'] = hasHardwareEncoder ? 'native' : '1080p'
  const cap = hasHardwareEncoder ? 240 : 60
  const refreshCap = refreshHz && refreshHz > 0 ? Math.min(refreshHz, cap) : cap

  const highFps = pickFramerate(Math.min(120, refreshCap))
  const mediumFps = pickFramerate(Math.min(60, refreshCap))
  const lowFps = pickFramerate(Math.min(30, refreshCap))

  return [
    buildPreset({
      name: 'low',
      label: 'Low',
      scale: displayHeight <= 1080 ? '720p' : '1080p',
      fps: lowFps,
      quality: 26,
      context,
      note: 'Smallest files and the least load. Enough to review positioning and decisions.'
    }),
    buildPreset({
      name: 'medium',
      label: 'Medium',
      scale: hasHardwareEncoder && displayHeight <= 1440 ? 'native' : '1080p',
      fps: mediumFps,
      quality: 23,
      context,
      note: 'Sharp and smooth enough for mechanics, at a sensible size.'
    }),
    buildPreset({
      name: 'high',
      label: 'High',
      scale: topScale,
      fps: highFps,
      quality: 21,
      context,
      note: hasHardwareEncoder
        ? 'Native resolution at high framerate. No scaling, so no capture overhead at all.'
        : 'As much as software encoding can sustain without stealing frames from the game.'
    })
  ]
}

function buildPreset(input: {
  name: QualityPresetName
  label: string
  scale: RecordingSettings['resolutionScale']
  fps: RecordingFramerate
  quality: number
  context: PresetContext
  note: string
}): QualityPreset {
  const height = outputHeightFor(input.scale, input.context.displayHeight)
  const aspect = input.context.displayWidth / input.context.displayHeight
  const width = Math.round((height * aspect) / 2) * 2
  const bitrate = recommendedBitrateKbps(width, height, input.fps)

  return {
    name: input.name,
    label: input.label,
    summary: `${height}p ${input.fps}fps · ${Math.round(bitrate / 1000)} Mbps`,
    description: input.note,
    values: {
      resolutionScale: input.scale,
      framerate: input.fps,
      rateControl: 'bitrate',
      bitrateKbps: bitrate,
      quality: input.quality,
      keyframeIntervalSeconds: 1
    }
  }
}

/** Nearest offered framerate at or below a ceiling. */
function pickFramerate(ceiling: number): RecordingFramerate {
  const usable = FRAMERATE_OPTIONS.filter((fps) => fps <= ceiling)
  return usable.length > 0 ? (usable[usable.length - 1] as RecordingFramerate) : 30
}

/**
 * Fallback presets for when no display information is available.
 *
 * Only reached if the display list can't be read, which in practice means
 * something is already badly wrong. 1080p60 is the safe middle.
 */
export const QUALITY_PRESETS: QualityPreset[] = buildQualityPresets({
  displayWidth: 1920,
  displayHeight: 1080,
  refreshHz: 60,
  hasHardwareEncoder: true
})

export function findPreset(
  name: QualityPresetName,
  presets: QualityPreset[] = QUALITY_PRESETS
): QualityPreset | undefined {
  return presets.find((preset) => preset.name === name)
}

export function applyPreset(
  settings: RecordingSettings,
  name: QualityPresetName,
  presets: QualityPreset[] = QUALITY_PRESETS
): RecordingSettings {
  const preset = findPreset(name, presets)
  if (!preset) return settings
  return { ...settings, ...preset.values }
}

/**
 * Which preset the current settings correspond to, or 'custom'.
 *
 * Compared field by field rather than stored, so hand-editing a value shows as
 * custom instead of leaving a preset button highlighted that no longer
 * describes what will be recorded.
 */
export function detectPreset(
  settings: RecordingSettings,
  presets: QualityPreset[] = QUALITY_PRESETS
): QualityPresetName {
  for (const preset of presets) {
    const matches = Object.entries(preset.values).every(
      ([key, value]) => settings[key as keyof typeof preset.values] === value
    )
    if (matches) return preset.name
  }
  return 'custom'
}

export interface PreflightMeasurement {
  /** Frames the encoder actually produced. */
  frames: number
  /** Frames the pipeline threw away. */
  droppedFrames: number
  /** Average encode rate over the test. */
  averageFps: number
  /** Processing speed against real time. */
  speed: number
  sizeBytes: number
  /** Seconds of footage produced. */
  durationSeconds: number
  /** Target framerate, for comparison. */
  targetFps: number
  /** Set when ffmpeg failed rather than produced a poor result. */
  error: string | null
}

export interface PreflightVerdict {
  ok: boolean
  headline: string
  details: string[]
  /** A concrete setting to change, when there is one worth suggesting. */
  recommendation: string | null
  /** Suggested preset to drop to, when applicable. */
  suggestedPreset: QualityPresetName | null
}

/** Below this fraction of the target framerate, capture isn't keeping up. */
const FPS_SHORTFALL_RATIO = 0.9

/**
 * Reads a preflight measurement.
 *
 * The recommendations step down one axis at a time and name it, because "try
 * lower settings" is not actionable. Framerate is reduced before resolution:
 * for reviewing a VOD, a sharp 30fps image is more useful than a soft 60fps one,
 * and halving the framerate roughly halves the load.
 */
export function assessPreflight(measurement: PreflightMeasurement): PreflightVerdict {
  if (measurement.error) {
    return {
      ok: false,
      headline: "The test recording didn't complete.",
      details: [measurement.error],
      recommendation: null,
      suggestedPreset: null
    }
  }

  // A test that produced nothing at all is the ddagrab-with-no-frames case:
  // every flag accepted, the display opened, and no output. Worth naming
  // precisely, because it looks identical to "recording is broken".
  if (measurement.frames === 0) {
    return {
      ok: false,
      headline: 'No frames were captured at all.',
      details: [
        'The capture started but the display produced no images.',
        'This usually means the monitor is asleep or inactive, another program has exclusive control of it, or the wrong monitor is selected.'
      ],
      recommendation: 'Check the monitor selection, and make sure the screen is awake.',
      suggestedPreset: null
    }
  }

  const details: string[] = []
  const dropRatio = measurement.droppedFrames / measurement.frames
  const fpsRatio = measurement.averageFps / measurement.targetFps

  details.push(
    `Captured ${measurement.frames} frames in ${measurement.durationSeconds.toFixed(1)}s ` +
      `(${measurement.averageFps.toFixed(1)} fps against a ${measurement.targetFps} fps target).`
  )
  details.push(
    `Wrote ${(measurement.sizeBytes / 1024 ** 2).toFixed(1)} MB, ` +
      `about ${estimateGbPerHour(measurement).toFixed(1)} GB per hour at this rate.`
  )

  const health = assessCaptureHealth({
    frame: measurement.frames,
    fps: measurement.averageFps,
    totalSizeBytes: measurement.sizeBytes,
    outTimeMs: measurement.durationSeconds * 1000,
    dropFrames: measurement.droppedFrames,
    dupFrames: 0,
    speed: measurement.speed,
    ended: true
  })

  const struggling = !health.healthy || fpsRatio < FPS_SHORTFALL_RATIO

  if (!struggling) {
    return {
      ok: true,
      headline: 'These settings look comfortable on this machine.',
      details,
      recommendation: null,
      suggestedPreset: null
    }
  }

  for (const reason of health.reasons) details.push(reason)
  if (fpsRatio < FPS_SHORTFALL_RATIO) {
    details.push(
      `Only reached ${Math.round(fpsRatio * 100)}% of the target framerate.`
    )
  }

  return {
    ok: false,
    headline: 'These settings are more than this machine can sustain.',
    details,
    ...suggestion(measurement, dropRatio),
  }
}

function suggestion(
  measurement: PreflightMeasurement,
  dropRatio: number
): { recommendation: string; suggestedPreset: QualityPresetName | null } {
  // Framerate first: a sharp 30fps VOD reviews better than a soft 60fps one,
  // and halving the framerate roughly halves the load.
  if (measurement.targetFps > 30) {
    return {
      recommendation: `Try 30 fps instead of ${measurement.targetFps}. That roughly halves the work with no loss of sharpness.`,
      suggestedPreset: 'low'
    }
  }

  if (dropRatio > 0.1) {
    return {
      recommendation:
        'Try a lower resolution. At 30 fps and still dropping this many frames, the pixel count is the constraint.',
      suggestedPreset: 'low'
    }
  }

  return {
    recommendation:
      'Try the Low preset, or a lower quality value -- this configuration is close to the limit here.',
    suggestedPreset: 'low'
  }
}

function estimateGbPerHour(measurement: PreflightMeasurement): number {
  if (measurement.durationSeconds <= 0) return 0
  const bytesPerSecond = measurement.sizeBytes / measurement.durationSeconds
  return (bytesPerSecond * 3600) / 1024 ** 3
}

/** Derives a measurement from the final progress sample of a test recording. */
export function measurementFromProgress(
  sample: RecorderProgress | null,
  targetFps: number,
  error: string | null = null
): PreflightMeasurement {
  const durationSeconds = (sample?.outTimeMs ?? 0) / 1000
  return {
    frames: sample?.frame ?? 0,
    droppedFrames: sample?.dropFrames ?? 0,
    // ffmpeg's fps field is instantaneous; over a short test the average is
    // better derived from frames over elapsed output time.
    averageFps: durationSeconds > 0 ? (sample?.frame ?? 0) / durationSeconds : 0,
    speed: sample?.speed ?? 0,
    sizeBytes: sample?.totalSizeBytes ?? 0,
    durationSeconds,
    targetFps,
    error
  }
}
