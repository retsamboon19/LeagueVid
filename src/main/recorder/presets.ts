import type { RecorderProgress, RecordingFramerate, RecordingSettings } from '../../shared/types'
import { FRAMERATE_OPTIONS } from '../../shared/types'
import { ADVICE_FLOOR_KBPS, outputHeightFor, recommendedBitrateKbps } from '../../shared/bitrateAdvice'
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
 * Bitrate as a fraction of the recommendation for the output size.
 *
 * On a hardware encoder every tier records at the same resolution and a
 * playable framerate (see buildQualityPresets), so bitrate is what separates
 * them. That is deliberate: it is the only axis where "smaller" is actually
 * cheaper to produce here, and the only one a viewer can trade away without
 * the footage becoming useless for review.
 */
const BITRATE_FACTOR: Record<Exclude<QualityPresetName, 'custom'>, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1
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
 * Two corrections after a round of real recordings came back choppy:
 *
 * Scaling is not a saving, it is the most expensive thing this pipeline can do.
 * The bundled ffmpeg has no working CUDA filters -- scale_cuda fails outright
 * with "Function not implemented" -- so any resolutionScale other than 'native'
 * means ddagrab -> hwdownload -> swscale -> encoder, a full GPU-to-system-memory
 * round trip on every single frame. A 720p tier therefore *drops more frames*
 * than a native one, which is the exact opposite of what a preset called "Low"
 * promises. Measured on real sessions at 720p30: 4% of frames dropped on one and
 * 18% on another, against 0 for native capture. So every tier stays native
 * wherever a hardware encoder is available.
 *
 * And 30fps is not a "modest" setting, it is a broken one. Recording a game
 * running at 240fps down to 30 reads as a slideshow on playback -- it was
 * reported as looking like roughly one frame per second. Framerate is also the
 * one axis that cannot be recovered later: bitrate buys sharpness back, nothing
 * buys back motion that was never sampled. 60 is the floor wherever the panel
 * and the encoder allow it.
 */
export function buildQualityPresets(context: PresetContext): QualityPreset[] {
  const { displayHeight, refreshHz, hasHardwareEncoder } = context

  // Software encoding is the one case that genuinely needs modest settings: it
  // spends CPU the game also wants, so it eats the scaling round trip to keep
  // the pixel count down.
  const scale: RecordingSettings['resolutionScale'] = hasHardwareEncoder
    ? 'native'
    : displayHeight <= 1080
      ? '720p'
      : '1080p'

  const cap = hasHardwareEncoder ? 240 : 60
  const refreshCap = refreshHz && refreshHz > 0 ? Math.min(refreshHz, cap) : cap

  const highFps = pickFramerate(Math.min(120, refreshCap))
  const mediumFps = pickFramerate(Math.min(60, refreshCap))
  // Also 60 on hardware: the cheapest tier should still produce watchable
  // motion. Only software encoding, which cannot sustain it, falls to 30.
  const lowFps = pickFramerate(Math.min(hasHardwareEncoder ? 60 : 30, refreshCap))

  return [
    buildPreset({
      name: 'low',
      label: 'Low',
      scale,
      fps: lowFps,
      quality: 26,
      context,
      note: 'Smallest files. Softer in teamfights, but the motion is all there.'
    }),
    buildPreset({
      name: 'medium',
      label: 'Medium',
      scale,
      fps: mediumFps,
      quality: 23,
      context,
      note: 'Sharp and smooth enough for mechanics, at a sensible size.'
    }),
    buildPreset({
      name: 'high',
      label: 'High',
      scale,
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
  name: Exclude<QualityPresetName, 'custom'>
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
  const bitrate = tierBitrateKbps(
    recommendedBitrateKbps(width, height, input.fps),
    BITRATE_FACTOR[input.name]
  )

  return {
    name: input.name,
    label: input.label,
    summary: `${height}p ${input.fps}fps · ${formatMbps(bitrate)} Mbps`,
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

/**
 * kbps as Mbps for the card, keeping the half-step when there is one. Rounding
 * 9500 to "10 Mbps" would have the three cards claim bitrates the recorder does
 * not use, which is how a picker stops being trustworthy.
 */
function formatMbps(kbps: number): string {
  const mbps = kbps / 1000
  return Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1)
}

/**
 * Scales the recommended bitrate down for a tier, rounded to something a
 * settings screen can show without implying false precision, and never below
 * the floor where the recording stops being worth keeping.
 */
function tierBitrateKbps(recommended: number, factor: number): number {
  const scaled = recommended * factor
  const rounded = scaled >= 10_000 ? Math.round(scaled / 1000) * 1000 : Math.round(scaled / 500) * 500
  return Math.max(ADVICE_FLOOR_KBPS, rounded)
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
  /**
   * Whether the tested configuration scaled, i.e. resolutionScale != 'native'.
   *
   * Needed because the advice changes sign on it: in this pipeline scaling adds
   * a per-frame GPU-to-system-memory round trip, so a scaled capture that is
   * dropping frames should be told to go *up* to native, not further down.
   */
  scaled: boolean
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
  // Scaling first, and upwards, because it is the one change that costs nothing
  // to make and gets both faster and sharper. Any resolution other than Native
  // downloads every frame out of the GPU into system memory before the encoder
  // can touch it, so a scaled capture that drops frames is usually being limited
  // by the scaling rather than by the pixel count.
  if (measurement.scaled) {
    return {
      recommendation:
        'Set the resolution to Native. Scaling copies every frame out of the GPU and back, which costs more than the extra pixels do -- Native is both faster here and sharper.',
      suggestedPreset: null
    }
  }

  // Only then framerate, and not below 60: 30fps footage of a game running far
  // above it is a slideshow, and no amount of sharpness makes up for motion that
  // was never sampled.
  if (measurement.targetFps > 60) {
    return {
      recommendation: `Try 60 fps instead of ${measurement.targetFps}. That is still smooth to review, and roughly halves the work.`,
      suggestedPreset: 'medium'
    }
  }

  if (dropRatio > 0.1) {
    return {
      recommendation:
        'Lower the bitrate, or pick the Low preset. At native resolution and 60 fps the encoder is the constraint, not the capture.',
      suggestedPreset: 'low'
    }
  }

  return {
    recommendation:
      'Try the Low preset -- this configuration is close to what this machine will sustain.',
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
  error: string | null = null,
  scaled = false
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
    scaled,
    error
  }
}
