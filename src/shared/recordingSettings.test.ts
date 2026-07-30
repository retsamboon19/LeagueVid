import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECORDING_SETTINGS,
  NATIVE_CAPTURE_FLOOR_KBPS,
  RECORDING_SETTINGS_VERSION,
  migrateRecordingSettings,
  parseRecordingSettings
} from './types'

describe('parseRecordingSettings', () => {
  it('returns the defaults when there is no stored row', () => {
    expect(parseRecordingSettings(null)).toEqual(DEFAULT_RECORDING_SETTINGS)
    expect(parseRecordingSettings(undefined)).toEqual(DEFAULT_RECORDING_SETTINGS)
    expect(parseRecordingSettings('')).toEqual(DEFAULT_RECORDING_SETTINGS)
  })

  it('does not hand back the shared defaults object', () => {
    const parsed = parseRecordingSettings(null)
    parsed.framerate = 30
    expect(DEFAULT_RECORDING_SETTINGS.framerate).toBe(60)
  })

  it('keeps stored values over the defaults', () => {
    // Carries the current version, so this exercises the merge on its own
    // rather than the migration below.
    const stored = JSON.stringify({
      settingsVersion: RECORDING_SETTINGS_VERSION,
      enabled: true,
      framerate: 30,
      encoder: 'h264_nvenc'
    })
    const parsed = parseRecordingSettings(stored)
    expect(parsed.enabled).toBe(true)
    expect(parsed.framerate).toBe(30)
    expect(parsed.encoder).toBe('h264_nvenc')
  })

  // The reason merge-on-read exists: a row written before a field was added
  // must not leave that field undefined, or every consumer needs its own
  // fallback.
  it('fills in fields a stored row predates', () => {
    const parsed = parseRecordingSettings(JSON.stringify({ enabled: true }))
    expect(parsed.resolutionScale).toBe(DEFAULT_RECORDING_SETTINGS.resolutionScale)
    expect(parsed.minKeepDurationMs).toBe(DEFAULT_RECORDING_SETTINGS.minKeepDurationMs)
    expect(parsed.retentionEnabled).toBe(false)
  })

  it('preserves explicit nulls, which are meaningful here', () => {
    // null outputDir/displayId/encoder mean "use the default", which is not
    // the same as "field missing" -- both resolve to null, but the stored
    // null must survive the merge rather than being replaced.
    const parsed = parseRecordingSettings(
      JSON.stringify({ outputDir: null, displayId: null, encoder: null })
    )
    expect(parsed.outputDir).toBeNull()
    expect(parsed.displayId).toBeNull()
    expect(parsed.encoder).toBeNull()
  })

  it('falls back to the defaults on unparseable JSON', () => {
    expect(parseRecordingSettings('{ not json')).toEqual(DEFAULT_RECORDING_SETTINGS)
  })

  it('falls back to the defaults on JSON that is not an object', () => {
    expect(parseRecordingSettings('[1,2,3]')).toEqual(DEFAULT_RECORDING_SETTINGS)
    expect(parseRecordingSettings('42')).toEqual(DEFAULT_RECORDING_SETTINGS)
    expect(parseRecordingSettings('null')).toEqual(DEFAULT_RECORDING_SETTINGS)
    expect(parseRecordingSettings('"nope"')).toEqual(DEFAULT_RECORDING_SETTINGS)
  })
})

describe('DEFAULT_RECORDING_SETTINGS', () => {
  it('does not record or delete anything until the user opts in', () => {
    expect(DEFAULT_RECORDING_SETTINGS.enabled).toBe(false)
    expect(DEFAULT_RECORDING_SETTINGS.retentionEnabled).toBe(false)
    expect(DEFAULT_RECORDING_SETTINGS.replayBufferEnabled).toBe(false)
  })

  it('defaults to native capture, which keeps frames on the GPU', () => {
    expect(DEFAULT_RECORDING_SETTINGS.resolutionScale).toBe('native')
  })
})

describe('migrateRecordingSettings', () => {
  // The exact row found on the machine that reported the stuttering: the old
  // "low" preset, written before the preset floor was raised, and never
  // revisited because presets are only applied when the user clicks one.
  const legacyRow = {
    enabled: false,
    resolutionScale: '720p',
    framerate: 30,
    rateControl: 'bitrate',
    bitrateKbps: 3000,
    quality: 26
  }

  it('moves a legacy scaled capture to native', () => {
    const parsed = parseRecordingSettings(JSON.stringify(legacyRow))
    expect(parsed.resolutionScale).toBe('native')
  })

  it('raises a legacy sub-60 framerate to 60', () => {
    expect(parseRecordingSettings(JSON.stringify(legacyRow)).framerate).toBe(60)
  })

  it('raises a 720p bitrate to something native capture can use', () => {
    expect(parseRecordingSettings(JSON.stringify(legacyRow)).bitrateKbps).toBe(
      NATIVE_CAPTURE_FLOOR_KBPS
    )
  })

  it('stamps the row so the correction is applied exactly once', () => {
    const parsed = parseRecordingSettings(JSON.stringify(legacyRow))
    expect(parsed.settingsVersion).toBe(RECORDING_SETTINGS_VERSION)
    // Second pass is a no-op: the point of versioning rather than clamping.
    expect(migrateRecordingSettings(parsed)).toEqual(parsed)
  })

  // The migration corrects an old default, it does not impose a policy. Someone
  // who picks 720p30 afterwards is choosing it, and must keep it.
  it('leaves a current row alone even when it scales at 30fps', () => {
    const chosen = parseRecordingSettings(
      JSON.stringify({
        ...legacyRow,
        settingsVersion: RECORDING_SETTINGS_VERSION
      })
    )
    expect(chosen.resolutionScale).toBe('720p')
    expect(chosen.framerate).toBe(30)
    expect(chosen.bitrateKbps).toBe(3000)
  })

  it('does not lower a framerate or bitrate that was already generous', () => {
    const parsed = parseRecordingSettings(
      JSON.stringify({ ...legacyRow, framerate: 144, bitrateKbps: 60000 })
    )
    expect(parsed.framerate).toBe(144)
    expect(parsed.bitrateKbps).toBe(60000)
  })
})
