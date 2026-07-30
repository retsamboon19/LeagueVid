import { describe, expect, it } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/types'
import {
  QUALITY_PRESETS,
  applyPreset,
  buildQualityPresets,
  assessPreflight,
  detectPreset,
  measurementFromProgress,
  type PreflightMeasurement
} from './presets'

function settings(overrides: Partial<RecordingSettings> = {}): RecordingSettings {
  return { ...DEFAULT_RECORDING_SETTINGS, ...overrides }
}

function measurement(overrides: Partial<PreflightMeasurement> = {}): PreflightMeasurement {
  return {
    frames: 600,
    droppedFrames: 0,
    duplicateFrames: 0,
    averageFps: 60,
    speed: 1.0,
    sizeBytes: 50 * 1024 ** 2,
    durationSeconds: 10,
    targetFps: 60,
    scaled: false,
    error: null,
    ...overrides
  }
}

describe('presets', () => {
  it('offers low, medium and high', () => {
    expect(QUALITY_PRESETS.map((p) => p.name)).toEqual(['low', 'medium', 'high'])
  })

  it('gets heavier from low to high on every axis', () => {
    const [low, medium, high] = QUALITY_PRESETS

    expect(low.values.framerate).toBeLessThanOrEqual(medium.values.framerate)
    expect(medium.values.framerate).toBeLessThanOrEqual(high.values.framerate)

    expect(low.values.bitrateKbps).toBeLessThan(high.values.bitrateKbps)

    // Lower quality numbers mean better quality, so this ordering is inverted.
    expect(high.values.quality).toBeLessThan(medium.values.quality)
    expect(medium.values.quality).toBeLessThan(low.values.quality)
  })

  // Fixed tiers were the original mistake: "High = 1080p60 at 8 Mbps" is
  // generous on a laptop and insulting on a 1440p 240Hz desktop with an RTX
  // card. Presets are now derived from the machine they'll run on.
  describe('adapting to the machine', () => {
    const HIGH_END = {
      displayWidth: 2560,
      displayHeight: 1440,
      refreshHz: 239,
      hasHardwareEncoder: true
    }

    it('uses native resolution and high framerate on capable hardware', () => {
      const [, , high] = buildQualityPresets(HIGH_END)

      expect(high.values.resolutionScale).toBe('native')
      expect(high.values.framerate).toBe(120)
    })

    // Scaling is not free here: the bundled ffmpeg has no working CUDA device
    // (scale_cuda fails with "Function not implemented"), so it means a
    // hwdownload round trip through system memory on every frame. Real sessions
    // recorded at 720p30 dropped 4% and 18% of their frames where native capture
    // drops none. A scaled "Low" tier is therefore heavier than a native "High"
    // one, so no tier scales when the encoder is hardware.
    it('never scales when the encoder is hardware, not even on the cheapest tier', () => {
      for (const preset of buildQualityPresets(HIGH_END)) {
        expect(preset.values.resolutionScale, preset.name).toBe('native')
      }
    })

    // 30fps of a game running at 240 was reported as looking like roughly one
    // frame per second. Framerate is the one axis nothing recovers later, so the
    // cheap tier gives up bitrate instead.
    it('keeps a watchable framerate on the low tier', () => {
      const [low] = buildQualityPresets(HIGH_END)
      expect(low.values.framerate).toBe(60)
    })

    // With resolution and framerate no longer varying on capable hardware,
    // bitrate is what separates the tiers -- and it has to actually differ, or
    // the picker offers three identical buttons.
    it('separates the tiers by bitrate when they share a resolution', () => {
      const [low, medium, high] = buildQualityPresets(HIGH_END)
      expect(low.values.bitrateKbps).toBeLessThan(medium.values.bitrateKbps)
      expect(medium.values.bitrateKbps).toBeLessThan(high.values.bitrateKbps)
    })

    it('gives a 1440p 240Hz display a bitrate that suits it', () => {
      const [, , high] = buildQualityPresets(HIGH_END)
      // Not the 8 Mbps the first version of this file used for its top preset.
      expect(high.values.bitrateKbps).toBeGreaterThan(20_000)
    })

    it('never exceeds the display refresh rate', () => {
      const sixtyHz = { ...HIGH_END, refreshHz: 60 }
      for (const preset of buildQualityPresets(sixtyHz)) {
        expect(preset.values.framerate, preset.name).toBeLessThanOrEqual(60)
      }
    })

    // Software encoding is the one case that genuinely needs modest settings,
    // because it spends CPU the game also wants.
    it('holds back when only software encoding is available', () => {
      const presets = buildQualityPresets({ ...HIGH_END, hasHardwareEncoder: false })

      for (const preset of presets) {
        expect(preset.values.resolutionScale, preset.name).not.toBe('native')
        expect(preset.values.framerate, preset.name).toBeLessThanOrEqual(60)
      }
    })

    it('does not upscale a modest display', () => {
      const laptop = {
        displayWidth: 1366,
        displayHeight: 768,
        refreshHz: 60,
        hasHardwareEncoder: true
      }
      for (const preset of buildQualityPresets(laptop)) {
        // 720p or native, never a request for more pixels than the panel has.
        expect(['native', '720p', '1080p'], preset.name).toContain(
          preset.values.resolutionScale
        )
      }
    })

    it('describes each preset with the resolution, framerate and bitrate', () => {
      for (const preset of buildQualityPresets(HIGH_END)) {
        expect(preset.summary, preset.name).toMatch(/\d+p \d+fps/)
        expect(preset.summary, preset.name).toContain('Mbps')
      }
    })
  })

  // The presets show a bitrate in the UI, so they have to actually use it --
  // otherwise the number on screen describes nothing.
  it('uses the bitrate the picker displays', () => {
    for (const preset of QUALITY_PRESETS) {
      expect(preset.values.rateControl, preset.name).toBe('bitrate')
    }
  })

  it('gives every preset a one-line spec for the card', () => {
    for (const preset of QUALITY_PRESETS) {
      expect(preset.summary, preset.name).toMatch(/\d+p \d+fps/)
    }
  })

  it('applies a preset over existing settings without touching unrelated fields', () => {
    const before = settings({
      micDeviceName: 'HyperX',
      micVolume: 60,
      outputDir: 'H:\\vods'
    })
    const after = applyPreset(before, 'low')

    // The fallback presets assume a hardware encoder on a 1080p60 display, so
    // even Low records natively at the panel's own rate and saves size on
    // bitrate instead.
    expect(after.framerate).toBe(60)
    expect(after.resolutionScale).toBe('native')
    // A quality preset must not quietly reset someone's audio or output folder.
    expect(after.micDeviceName).toBe('HyperX')
    expect(after.micVolume).toBe(60)
    expect(after.outputDir).toBe('H:\\vods')
  })

  it('leaves settings alone for an unknown preset', () => {
    const before = settings()
    expect(applyPreset(before, 'custom')).toBe(before)
  })

  describe('detectPreset', () => {
    it('recognises each preset', () => {
      for (const preset of QUALITY_PRESETS) {
        expect(detectPreset(applyPreset(settings(), preset.name))).toBe(preset.name)
      }
    })

    // Compared field by field rather than stored, so hand-editing one value
    // stops claiming to be a preset that no longer describes the recording.
    it('reports custom once a value is hand-edited', () => {
      const tweaked = { ...applyPreset(settings(), 'high'), quality: 18 }
      expect(detectPreset(tweaked)).toBe('custom')
    })
  })
})

describe('assessPreflight', () => {
  it('passes a clean measurement', () => {
    const verdict = assessPreflight(measurement())
    expect(verdict.ok).toBe(true)
    expect(verdict.recommendation).toBeNull()
    expect(verdict.headline).toContain('comfortable')
  })

  it('reports what it measured either way', () => {
    const verdict = assessPreflight(measurement())
    expect(verdict.details.join(' ')).toContain('600 frames')
    expect(verdict.details.join(' ')).toContain('GB per hour')
  })

  // The observed ddagrab failure: every flag accepted, the display opened, no
  // frames produced. It looks identical to "recording is broken" unless it is
  // named precisely.
  it('names the no-frames case specifically', () => {
    const verdict = assessPreflight(measurement({ frames: 0, averageFps: 0, sizeBytes: 0 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.headline).toContain('No frames')
    expect(verdict.details.join(' ')).toContain('asleep or inactive')
    expect(verdict.recommendation).toContain('monitor selection')
  })

  it('reports an ffmpeg failure as a failure, not a poor result', () => {
    const verdict = assessPreflight(measurement({ error: 'Unknown encoder h264_qsv' }))
    expect(verdict.ok).toBe(false)
    expect(verdict.details).toContain('Unknown encoder h264_qsv')
    expect(verdict.recommendation).toBeNull()
  })

  it('fails a measurement that dropped frames', () => {
    const verdict = assessPreflight(measurement({ droppedFrames: 60 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.details.join(' ')).toContain('Dropping frames')
  })

  it('fails a measurement that fell behind real time', () => {
    const verdict = assessPreflight(measurement({ speed: 0.7 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.details.join(' ')).toContain('slower than real time')
  })

  it('fails a measurement that missed the target framerate', () => {
    const verdict = assessPreflight(measurement({ averageFps: 40, frames: 400 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.details.join(' ')).toContain('% of the target framerate')
  })

  // "Try lower settings" is not actionable, and in this pipeline the obvious
  // lower setting is the wrong one: scaling adds a GPU-to-system-memory round
  // trip per frame, so a scaled capture that drops frames should go *up* to
  // native rather than further down.
  it('recommends going up to native resolution when the test was scaled', () => {
    const verdict = assessPreflight(
      measurement({ scaled: true, targetFps: 60, droppedFrames: 100 })
    )
    expect(verdict.recommendation).toContain('Native')
    // Not a preset: every preset is already native on hardware, and dropping a
    // tier would not address the scaling.
    expect(verdict.suggestedPreset).toBeNull()
  })

  it('recommends dropping framerate only above 60', () => {
    const verdict = assessPreflight(
      measurement({ targetFps: 120, averageFps: 120, frames: 1200, droppedFrames: 100 })
    )
    expect(verdict.recommendation).toContain('60 fps')
    expect(verdict.suggestedPreset).toBe('medium')
  })

  // Never 30: a slideshow is not a fix for a stutter.
  it('reaches for bitrate rather than framerate at 60', () => {
    const verdict = assessPreflight(
      measurement({ targetFps: 60, averageFps: 60, droppedFrames: 200 })
    )
    expect(verdict.recommendation).toContain('bitrate')
    expect(verdict.recommendation).not.toContain('30 fps')
  })

  it('tolerates a small shortfall rather than nagging', () => {
    // 58 of 60 fps, no drops -- fine in practice.
    const verdict = assessPreflight(measurement({ averageFps: 58, frames: 580 }))
    expect(verdict.ok).toBe(true)
  })
})

describe('measurementFromProgress', () => {
  it('derives the average framerate from frames over output time', () => {
    const result = measurementFromProgress(
      {
        frame: 300,
        // ffmpeg's fps field is instantaneous and can read anything at the end
        // of a run; the average is what the verdict should judge.
        fps: 12,
        totalSizeBytes: 1024,
        outTimeMs: 5000,
        dropFrames: 2,
        dupFrames: 0,
        speed: 1.0,
        ended: true
      },
      60
    )

    expect(result.averageFps).toBe(60)
    expect(result.droppedFrames).toBe(2)
    expect(result.durationSeconds).toBe(5)
    expect(result.targetFps).toBe(60)
  })

  it('produces a zero measurement when nothing was captured', () => {
    const result = measurementFromProgress(null, 60)
    expect(result.frames).toBe(0)
    expect(result.averageFps).toBe(0)
    expect(assessPreflight(result).headline).toContain('No frames')
  })

  it('carries an error through', () => {
    expect(measurementFromProgress(null, 60, 'spawn failed').error).toBe('spawn failed')
  })
})
