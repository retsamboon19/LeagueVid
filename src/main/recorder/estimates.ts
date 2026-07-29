import type { RecordingSettings } from '../../shared/types'
import { effectiveScaleHeight, type CaptureTarget } from './ffmpegArgs'

// Estimates how much bitrate -- and therefore how much disk -- a configuration
// will use.
//
// Pure, and honest about being an estimate. In bitrate mode the answer is
// exact, because that is what the number means. In quality mode there is no
// exact answer: constant-quality encoding spends bits where the picture needs
// them, and a 40-minute game of mostly-static minimap and shop screens costs
// far less than 40 minutes of teamfights. So the quality-mode figure is
// modelled from resolution, framerate and the quality value, and is presented
// as an approximation rather than a promise.

/** Bits per pixel per frame at the reference quality, for H.264. */
const REFERENCE_BPP = 0.09

/** The quality value the reference figure was calibrated at (cq/crf 21). */
const REFERENCE_QUALITY = 21

/**
 * How much each step of quality changes the bitrate.
 *
 * Roughly 12% per step, which is the usual rule of thumb for x264/NVENC: six
 * steps up or down about halves or doubles the rate.
 */
const QUALITY_STEP_FACTOR = 1.12

export interface EstimateInput {
  settings: RecordingSettings
  target: CaptureTarget
}

/** Output pixel dimensions after any scaling. */
export function outputDimensions(input: EstimateInput): { width: number; height: number } {
  const scaleHeight = effectiveScaleHeight(input.settings, input.target)
  if (scaleHeight == null) {
    return { width: input.target.width, height: input.target.height }
  }
  const aspect = input.target.width / input.target.height
  // Width is rounded to an even number, as the scale filter's -2 does.
  const width = Math.round((scaleHeight * aspect) / 2) * 2
  return { width, height: scaleHeight }
}

/**
 * Estimated video bitrate in kbps.
 *
 * Exact in bitrate mode. In quality mode, modelled from pixels per second and
 * the quality offset -- see the module note on why no exact answer exists.
 */
export function estimateVideoBitrateKbps(input: EstimateInput): number {
  const { settings } = input
  if (settings.rateControl === 'bitrate') return settings.bitrateKbps

  const { width, height } = outputDimensions(input)
  const pixelsPerSecond = width * height * settings.framerate

  // Lower quality numbers mean better quality and more bits.
  const qualityOffset = REFERENCE_QUALITY - settings.quality
  const qualityFactor = Math.pow(QUALITY_STEP_FACTOR, qualityOffset)

  const bitsPerSecond = pixelsPerSecond * REFERENCE_BPP * qualityFactor
  return Math.round(bitsPerSecond / 1000)
}

/** Audio adds a fixed cost per track. */
export function audioBitrateKbps(trackCount: number): number {
  return trackCount * 160
}

export function estimateTotalBitrateKbps(input: EstimateInput, audioTrackCount = 0): number {
  return estimateVideoBitrateKbps(input) + audioBitrateKbps(audioTrackCount)
}

export function bytesPerHour(totalKbps: number): number {
  // kbps -> bytes/hour: 1000 bits per kbit, 8 bits per byte, 3600 s per hour.
  return Math.round((totalKbps * 1000 * 3600) / 8)
}

export function gigabytesPerHour(totalKbps: number): number {
  return bytesPerHour(totalKbps) / 1024 ** 3
}

/** '~7.2 GB per hour' -- what the settings screen shows. */
export function formatStorageEstimate(input: EstimateInput, audioTrackCount = 0): string {
  const gb = gigabytesPerHour(estimateTotalBitrateKbps(input, audioTrackCount))
  if (gb < 1) return `~${Math.round(gb * 1024)} MB per hour`
  return `~${gb.toFixed(1)} GB per hour`
}

/**
 * Free space required before a recording may start.
 *
 * An hour of footage plus 20% headroom, floored at 5 GB. The headroom is not
 * arbitrary: remuxing writes the MP4 while the Matroska file still exists, so
 * peak usage is briefly close to double the recording -- checking only for the
 * recording itself would let a session start that cannot finish.
 */
export const MIN_FREE_BYTES_FLOOR = 5 * 1024 ** 3

export function requiredFreeBytes(input: EstimateInput, audioTrackCount = 0): number {
  const hourly = bytesPerHour(estimateTotalBitrateKbps(input, audioTrackCount))
  return Math.max(MIN_FREE_BYTES_FLOOR, Math.round(hourly * 1.2))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${bytes} bytes`
}
