import { describe, expect, it } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/types'
import {
  MIN_FREE_BYTES_FLOOR,
  bytesPerHour,
  estimateTotalBitrateKbps,
  estimateVideoBitrateKbps,
  formatBytes,
  formatStorageEstimate,
  gigabytesPerHour,
  outputDimensions,
  requiredFreeBytes
} from './estimates'
import type { CaptureTarget } from './ffmpegArgs'

const TARGET_1440: CaptureTarget = { outputIdx: 0, width: 2560, height: 1440, isHdr: false }
const TARGET_1080: CaptureTarget = { outputIdx: 0, width: 1920, height: 1080, isHdr: false }

function settings(overrides: Partial<RecordingSettings> = {}): RecordingSettings {
  return { ...DEFAULT_RECORDING_SETTINGS, ...overrides }
}

describe('outputDimensions', () => {
  it('is the display size at native scale', () => {
    expect(outputDimensions({ settings: settings(), target: TARGET_1440 })).toEqual({
      width: 2560,
      height: 1440
    })
  })

  it('preserves aspect ratio when scaling down', () => {
    expect(
      outputDimensions({ settings: settings({ resolutionScale: '1080p' }), target: TARGET_1440 })
    ).toEqual({ width: 1920, height: 1080 })
  })

  it('keeps the width even, as H.264 requires', () => {
    const odd: CaptureTarget = { outputIdx: 0, width: 2559, height: 1440, isHdr: false }
    const { width } = outputDimensions({
      settings: settings({ resolutionScale: '720p' }),
      target: odd
    })
    expect(width % 2).toBe(0)
  })

  it('does not upscale', () => {
    expect(
      outputDimensions({ settings: settings({ resolutionScale: '1440p' }), target: TARGET_1080 })
    ).toEqual({ width: 1920, height: 1080 })
  })
})

describe('estimateVideoBitrateKbps', () => {
  // In bitrate mode the number is not an estimate at all -- it's the setting.
  it('returns the configured bitrate exactly in bitrate mode', () => {
    const input = { settings: settings({ rateControl: 'bitrate', bitrateKbps: 25000 }), target: TARGET_1440 }
    expect(estimateVideoBitrateKbps(input)).toBe(25000)
  })

  it('scales with pixel count', () => {
    const at1440 = estimateVideoBitrateKbps({ settings: settings(), target: TARGET_1440 })
    const at1080 = estimateVideoBitrateKbps({
      settings: settings({ resolutionScale: '1080p' }),
      target: TARGET_1440
    })
    expect(at1440).toBeGreaterThan(at1080)
    // 1440p is about 1.78x the pixels of 1080p.
    expect(at1440 / at1080).toBeCloseTo((2560 * 1440) / (1920 * 1080), 1)
  })

  it('scales with framerate', () => {
    const at60 = estimateVideoBitrateKbps({ settings: settings({ framerate: 60 }), target: TARGET_1440 })
    const at30 = estimateVideoBitrateKbps({ settings: settings({ framerate: 30 }), target: TARGET_1440 })
    expect(at60 / at30).toBeCloseTo(2, 1)
  })

  // Lower quality numbers mean better quality and more bits, which is the
  // opposite of what the word "quality" suggests to most people -- worth
  // pinning so a future refactor doesn't invert it.
  it('produces more bitrate for a lower quality number', () => {
    const better = estimateVideoBitrateKbps({ settings: settings({ quality: 15 }), target: TARGET_1440 })
    const worse = estimateVideoBitrateKbps({ settings: settings({ quality: 30 }), target: TARGET_1440 })
    expect(better).toBeGreaterThan(worse)
  })

  it('lands in a plausible range for 1440p60 at default quality', () => {
    const kbps = estimateVideoBitrateKbps({ settings: settings(), target: TARGET_1440 })
    // Sanity band: NVENC at cq 21 for 1440p60 is tens of Mbps, not hundreds.
    expect(kbps).toBeGreaterThan(10_000)
    expect(kbps).toBeLessThan(60_000)
  })
})

describe('audio and totals', () => {
  it('adds a fixed cost per audio track', () => {
    const input = { settings: settings(), target: TARGET_1440 }
    const video = estimateVideoBitrateKbps(input)
    expect(estimateTotalBitrateKbps(input, 0)).toBe(video)
    expect(estimateTotalBitrateKbps(input, 1)).toBe(video + 160)
    expect(estimateTotalBitrateKbps(input, 2)).toBe(video + 320)
  })
})

describe('bytesPerHour', () => {
  it('converts kbps to bytes per hour', () => {
    // 8000 kbps = 1 MB/s = 3600 MB/hour.
    expect(bytesPerHour(8000)).toBe(3600 * 1000 * 1000)
  })

  it('agrees with the gigabyte helper', () => {
    expect(gigabytesPerHour(8000)).toBeCloseTo(bytesPerHour(8000) / 1024 ** 3, 6)
  })
})

describe('requiredFreeBytes', () => {
  // The headroom is not arbitrary: remuxing writes the MP4 while the Matroska
  // file still exists, so peak usage is briefly close to double. Checking only
  // for the recording would let a session start that cannot finish.
  it('asks for an hour of footage plus headroom', () => {
    const input = { settings: settings({ rateControl: 'bitrate', bitrateKbps: 40000 }), target: TARGET_1440 }
    const hourly = bytesPerHour(40000)
    expect(requiredFreeBytes(input)).toBe(Math.round(hourly * 1.2))
  })

  it('never asks for less than the floor', () => {
    const input = {
      settings: settings({ rateControl: 'bitrate', bitrateKbps: 1000, resolutionScale: '720p' }),
      target: TARGET_1080
    }
    expect(requiredFreeBytes(input)).toBe(MIN_FREE_BYTES_FLOOR)
  })
})

describe('formatting', () => {
  it('describes storage per hour', () => {
    const text = formatStorageEstimate({ settings: settings(), target: TARGET_1440 })
    expect(text).toMatch(/^~\d+(\.\d)? GB per hour$/)
  })

  it('uses megabytes for very light configurations', () => {
    const text = formatStorageEstimate({
      settings: settings({ rateControl: 'bitrate', bitrateKbps: 1000 }),
      target: TARGET_1080
    })
    expect(text).toContain('MB per hour')
  })

  it('formats byte counts at sensible units', () => {
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(formatBytes(300 * 1024 ** 2)).toBe('300 MB')
    expect(formatBytes(512)).toBe('512 bytes')
  })
})
