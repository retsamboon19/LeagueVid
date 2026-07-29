import type { RecordingSettings } from '../../shared/types'
import type { RecorderProgress } from '../../shared/types'
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
  description: string
  /** Applied over the current settings. */
  values: Pick<
    RecordingSettings,
    'resolutionScale' | 'framerate' | 'rateControl' | 'quality' | 'keyframeIntervalSeconds'
  >
}

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    name: 'low',
    label: 'Low',
    description: '1080p at 30fps. Smallest files, least load -- a safe choice on older hardware.',
    values: {
      resolutionScale: '1080p',
      framerate: 30,
      rateControl: 'quality',
      quality: 26,
      keyframeIntervalSeconds: 1
    }
  },
  {
    name: 'medium',
    label: 'Medium',
    description: '1080p at 60fps. Smooth enough to review mechanics, still modest on disk.',
    values: {
      resolutionScale: '1080p',
      framerate: 60,
      rateControl: 'quality',
      quality: 23,
      keyframeIntervalSeconds: 1
    }
  },
  {
    name: 'high',
    label: 'High',
    description: 'Native resolution at 60fps. Sharpest, and the heaviest on disk.',
    values: {
      resolutionScale: 'native',
      framerate: 60,
      rateControl: 'quality',
      quality: 21,
      keyframeIntervalSeconds: 1
    }
  }
]

export function findPreset(name: QualityPresetName): QualityPreset | undefined {
  return QUALITY_PRESETS.find((preset) => preset.name === name)
}

export function applyPreset(
  settings: RecordingSettings,
  name: QualityPresetName
): RecordingSettings {
  const preset = findPreset(name)
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
export function detectPreset(settings: RecordingSettings): QualityPresetName {
  for (const preset of QUALITY_PRESETS) {
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
