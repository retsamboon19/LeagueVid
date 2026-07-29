import { describe, expect, it } from 'vitest'
import {
  MAX_BITRATE_KBPS,
  MAX_MIN_KEEP_MINUTES,
  MIN_BITRATE_KBPS,
  clampBitrateKbps,
  clampMinKeepMinutes,
  describeMinKeep,
  msToMinutes,
  minutesToMs
} from './recordingBounds'

describe('clampBitrateKbps', () => {
  it('accepts a sensible value unchanged', () => {
    expect(clampBitrateKbps(8000)).toEqual({ value: 8000, adjusted: false, note: null })
  })

  it('accepts a value nobody would pick from a list', () => {
    expect(clampBitrateKbps(7350).value).toBe(7350)
  })

  it('rounds a fractional entry', () => {
    expect(clampBitrateKbps(4500.7).value).toBe(4501)
  })

  // A text field lets someone type 5 as easily as 5000, and the result would be
  // a recording too blocky to learn anything from.
  it('raises a value below the floor and says why', () => {
    const result = clampBitrateKbps(50)
    expect(result.value).toBe(MIN_BITRATE_KBPS)
    expect(result.adjusted).toBe(true)
    expect(result.note).toContain('too blocky')
  })

  it('rejects zero and negatives', () => {
    expect(clampBitrateKbps(0).value).toBe(MIN_BITRATE_KBPS)
    expect(clampBitrateKbps(-4000).value).toBe(MIN_BITRATE_KBPS)
  })

  // The expensive typo: an extra zero fills a drive in an afternoon.
  it('caps a value above the ceiling and names the cost', () => {
    const result = clampBitrateKbps(800_000)
    expect(result.value).toBe(MAX_BITRATE_KBPS)
    expect(result.note).toContain('GB per hour')
  })

  it('survives a field that was cleared or holds text', () => {
    expect(clampBitrateKbps(Number.NaN).value).toBe(MIN_BITRATE_KBPS)
    expect(clampBitrateKbps(Number.POSITIVE_INFINITY).value).toBe(MIN_BITRATE_KBPS)
  })

  it('keeps the exact boundary values', () => {
    expect(clampBitrateKbps(MIN_BITRATE_KBPS).adjusted).toBe(false)
    expect(clampBitrateKbps(MAX_BITRATE_KBPS).adjusted).toBe(false)
  })
})

describe('clampMinKeepMinutes', () => {
  it('accepts a normal value', () => {
    expect(clampMinKeepMinutes(4)).toEqual({ value: 4, adjusted: false, note: null })
  })

  // Zero is a real choice: keep everything, including the 40-second remake.
  it('treats zero as keep everything', () => {
    expect(clampMinKeepMinutes(0)).toEqual({ value: 0, adjusted: false, note: null })
  })

  it('rounds to quarter minutes rather than pretending to finer precision', () => {
    expect(clampMinKeepMinutes(3.6).value).toBe(3.5)
    expect(clampMinKeepMinutes(2.1).value).toBe(2)
  })

  it('turns a negative or unparseable entry into keep everything', () => {
    expect(clampMinKeepMinutes(-5).value).toBe(0)
    expect(clampMinKeepMinutes(Number.NaN).value).toBe(0)
  })

  // Past 15 minutes this stops discarding remakes and starts discarding games
  // the user actually played -- silently, which is the problem.
  it('caps the rule before it starts deleting real games', () => {
    const result = clampMinKeepMinutes(45)
    expect(result.value).toBe(MAX_MIN_KEEP_MINUTES)
    expect(result.note).toContain('discarding real games')
    expect(result.note).toContain('storage limit')
  })
})

describe('minute conversion', () => {
  it('round-trips whole minutes', () => {
    expect(msToMinutes(minutesToMs(4))).toBe(4)
  })

  it('round-trips quarter minutes', () => {
    expect(msToMinutes(minutesToMs(3.75))).toBe(3.75)
  })

  it('converts to milliseconds the recorder can compare against', () => {
    expect(minutesToMs(4)).toBe(240_000)
    expect(minutesToMs(0.5)).toBe(30_000)
  })
})

describe('describeMinKeep', () => {
  it('says plainly when nothing is discarded', () => {
    expect(describeMinKeep(0)).toContain('kept')
    expect(describeMinKeep(0)).not.toContain('deleted')
  })

  it('explains the remake reasoning behind the default', () => {
    const text = describeMinKeep(4 * 60 * 1000)
    expect(text).toContain('4 min')
    expect(text).toContain('Remakes are called at 3 minutes')
  })

  it('reads naturally for sub-minute and mixed values', () => {
    expect(describeMinKeep(45_000)).toContain('45s')
    expect(describeMinKeep(90_000)).toContain('1 min 30s')
  })
})
