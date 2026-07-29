import { describe, expect, it } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/types'
import {
  QUALITY_PRESETS,
  applyPreset,
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
    averageFps: 60,
    speed: 1.0,
    sizeBytes: 50 * 1024 ** 2,
    durationSeconds: 10,
    targetFps: 60,
    error: null,
    ...overrides
  }
}

describe('presets', () => {
  it('offers low, medium and high', () => {
    expect(QUALITY_PRESETS.map((p) => p.name)).toEqual(['low', 'medium', 'high'])
  })

  it('gets heavier from low to high', () => {
    const [low, medium, high] = QUALITY_PRESETS
    expect(low.values.framerate).toBeLessThanOrEqual(medium.values.framerate)
    // Lower quality numbers mean better quality.
    expect(high.values.quality).toBeLessThan(low.values.quality)
    expect(high.values.resolutionScale).toBe('native')
  })

  it('applies a preset over existing settings without touching unrelated fields', () => {
    const before = settings({ micDeviceName: 'HyperX', outputDir: 'H:\\vods' })
    const after = applyPreset(before, 'low')

    expect(after.framerate).toBe(30)
    expect(after.resolutionScale).toBe('1080p')
    // Untouched.
    expect(after.micDeviceName).toBe('HyperX')
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

  // "Try lower settings" is not actionable. Framerate is reduced before
  // resolution because a sharp 30fps VOD reviews better than a soft 60fps one.
  it('recommends dropping framerate first', () => {
    const verdict = assessPreflight(measurement({ targetFps: 60, droppedFrames: 100 }))
    expect(verdict.recommendation).toContain('30 fps')
    expect(verdict.suggestedPreset).toBe('low')
  })

  it('recommends dropping resolution once framerate is already low', () => {
    const verdict = assessPreflight(
      measurement({ targetFps: 30, averageFps: 30, droppedFrames: 200 })
    )
    expect(verdict.recommendation).toContain('lower resolution')
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
