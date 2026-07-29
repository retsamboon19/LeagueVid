import { describe, expect, it } from 'vitest'
import {
  ADVICE_CEILING_KBPS,
  ADVICE_FLOOR_KBPS,
  exceedsRefreshRate,
  outputHeightFor,
  recommendedBitrateKbps
} from './bitrateAdvice'

describe('recommendedBitrateKbps', () => {
  // The reference points this heuristic is calibrated against. The first set of
  // presets used 4000 kbps at 720p30 and 8000 at 1080p60, which is roughly half
  // what game footage needs and looked exactly as bad as that implies.
  it('lands near known-good figures for game footage', () => {
    expect(recommendedBitrateKbps(1920, 1080, 30)).toBeGreaterThanOrEqual(5000)
    expect(recommendedBitrateKbps(1920, 1080, 30)).toBeLessThanOrEqual(8000)

    expect(recommendedBitrateKbps(1920, 1080, 60)).toBeGreaterThanOrEqual(8000)
    expect(recommendedBitrateKbps(1920, 1080, 60)).toBeLessThanOrEqual(14000)

    expect(recommendedBitrateKbps(2560, 1440, 60)).toBeGreaterThanOrEqual(16000)
    expect(recommendedBitrateKbps(2560, 1440, 60)).toBeLessThanOrEqual(30000)
  })

  it('scales with pixel count', () => {
    const at720 = recommendedBitrateKbps(1280, 720, 60)
    const at1080 = recommendedBitrateKbps(1920, 1080, 60)
    const at1440 = recommendedBitrateKbps(2560, 1440, 60)

    expect(at1080).toBeGreaterThan(at720)
    expect(at1440).toBeGreaterThan(at1080)
  })

  // Doubling framerate does not double the information: consecutive frames are
  // more similar, so prediction gets more efficient. Treating it as linear is
  // what produces absurd figures at 120fps.
  it('scales sublinearly with framerate', () => {
    const at30 = recommendedBitrateKbps(1920, 1080, 30)
    const at60 = recommendedBitrateKbps(1920, 1080, 60)
    const at120 = recommendedBitrateKbps(1920, 1080, 120)

    expect(at60).toBeGreaterThan(at30)
    expect(at60 / at30).toBeLessThan(2)
    expect(at120 / at60).toBeLessThan(2)
  })

  it('rounds to figures a person would recognise', () => {
    const high = recommendedBitrateKbps(2560, 1440, 60)
    expect(high % 1000).toBe(0)

    const low = recommendedBitrateKbps(854, 480, 30)
    expect(low % 500).toBe(0)
  })

  it('stays within its own bounds', () => {
    expect(recommendedBitrateKbps(160, 120, 10)).toBe(ADVICE_FLOOR_KBPS)
    expect(recommendedBitrateKbps(7680, 4320, 240)).toBe(ADVICE_CEILING_KBPS)
  })

  it('survives nonsense input', () => {
    expect(recommendedBitrateKbps(0, 0, 0)).toBe(ADVICE_FLOOR_KBPS)
    expect(recommendedBitrateKbps(-1920, 1080, 60)).toBe(ADVICE_FLOOR_KBPS)
  })
})

describe('outputHeightFor', () => {
  it('returns the display height for native', () => {
    expect(outputHeightFor('native', 1440)).toBe(1440)
  })

  it('returns the requested height when the display is taller', () => {
    expect(outputHeightFor('1080p', 1440)).toBe(1080)
    expect(outputHeightFor('720p', 1440)).toBe(720)
  })

  // Asking a 1080p display for 1440p should record 1080p, not spend bitrate on
  // invented pixels.
  it('never upscales', () => {
    expect(outputHeightFor('1440p', 1080)).toBe(1080)
    expect(outputHeightFor('1080p', 720)).toBe(720)
  })
})

describe('exceedsRefreshRate', () => {
  // Measured on a 239Hz panel: capturing an idle desktop at 120fps produced 340
  // duplicate frames out of 738. Not an error, but not worth the bitrate.
  it('flags a framerate above the display', () => {
    expect(exceedsRefreshRate(120, 60)).toBe(true)
    expect(exceedsRefreshRate(240, 144)).toBe(true)
  })

  it('allows anything at or below the refresh rate', () => {
    expect(exceedsRefreshRate(60, 60)).toBe(false)
    expect(exceedsRefreshRate(120, 144)).toBe(false)
  })

  // A 239Hz panel should not flag the 240 option over one hertz.
  it('tolerates the odd reported refresh rates real panels have', () => {
    expect(exceedsRefreshRate(240, 239)).toBe(false)
    expect(exceedsRefreshRate(144, 143)).toBe(false)
  })

  it('flags nothing when the refresh rate is unknown', () => {
    expect(exceedsRefreshRate(240, null)).toBe(false)
    expect(exceedsRefreshRate(240, 0)).toBe(false)
  })
})
