import { describe, expect, it } from 'vitest'
import type { RecordingRow } from '../../../shared/types'
import {
  RECORDED_LINK_BACKOFF_MS,
  bestRecordingFit,
  hasExhaustedRetries,
  measuredSyncOffsetMs,
  nextRetryDelayMs,
  recordingStartMs
} from './autoLinkVideo'

function recording(overrides: Partial<RecordingRow> = {}): RecordingRow {
  return {
    id: 1,
    video_id: 10,
    temp_path: 'H:\\rec\\session.mkv',
    final_path: null,
    state: 'complete',
    started_at: 1_700_000_000_000,
    first_frame_ms: null,
    ended_at: null,
    game_start_ms: null,
    match_id_hint: 'EUW1_123',
    platform: 'euw1',
    puuid: 'p',
    queue_id: 420,
    champion_name: 'Yorick',
    live_events: null,
    link_state: 'pending',
    link_attempts: 0,
    settings_json: '{}',
    ffmpeg_error: null,
    dropped_frames: null,
    avg_fps: null,
    size_bytes: null,
    created_at: 1_700_000_000_000,
    ...overrides
  }
}

describe('recordingStartMs', () => {
  // ffmpeg spends a few hundred milliseconds opening the display and the
  // encoder. Anchoring to the spawn instead of the first frame would shift
  // every bookmark on the recording by that much.
  it('prefers the first frame over the spawn time', () => {
    const row = recording({ started_at: 1000, first_frame_ms: 1450 })
    expect(recordingStartMs(row)).toBe(1450)
  })

  it('falls back to the spawn time when no frame time was recorded', () => {
    expect(recordingStartMs(recording({ started_at: 1000, first_frame_ms: null }))).toBe(1000)
  })
})

describe('measuredSyncOffsetMs', () => {
  // video_time = game_time + offset. Both terms are known here, which is the
  // entire point: no filename parsing, no overlap search, no guessing whether
  // a timestamp means the start or the end of the recording.
  it('is the gap between game start and first frame', () => {
    const row = recording({ first_frame_ms: 1_700_000_060_000 })
    // Recording began 60s after the game clock started.
    expect(measuredSyncOffsetMs(1_700_000_000_000, row)).toBe(-60_000)
  })

  it('is positive when recording began before the game clock', () => {
    const row = recording({ first_frame_ms: 1_700_000_000_000 })
    // Capture was already running 5s before the clock started ticking.
    expect(measuredSyncOffsetMs(1_700_000_005_000, row)).toBe(5000)
  })

  it('places a bookmark correctly for a mid-game kill', () => {
    // Recording started 30s into the game; a kill at 8:00 of game time.
    const row = recording({ first_frame_ms: 1_700_000_030_000 })
    const offset = measuredSyncOffsetMs(1_700_000_000_000, row)
    const killAtGameMs = 8 * 60 * 1000

    // Video position = game time + offset = 8:00 - 0:30 = 7:30.
    expect(killAtGameMs + offset).toBe(7 * 60 * 1000 + 30 * 1000)
  })

  // The failure this replaces: the search path infers the recording start from
  // a filename, and when it guesses wrong by a whole game length every
  // bookmark lands at or before 0:00. A measured offset cannot do that.
  it('cannot produce the whole-game-negative shift the filename path can', () => {
    const row = recording({ first_frame_ms: 1_700_000_030_000 })
    const offset = measuredSyncOffsetMs(1_700_000_000_000, row)

    // Every event in a 30-minute game lands at a sane video position.
    for (let minute = 1; minute <= 30; minute++) {
      expect(minute * 60_000 + offset).toBeGreaterThan(0)
    }
  })
})

describe('the retry schedule', () => {
  // Riot's match-v5 does not publish a match the instant it ends; the lag runs
  // from seconds to minutes. A first failure is the normal case, not an error.
  it('starts soon and backs off', () => {
    expect(RECORDED_LINK_BACKOFF_MS[0]).toBe(10_000)
    for (let i = 1; i < RECORDED_LINK_BACKOFF_MS.length; i++) {
      expect(RECORDED_LINK_BACKOFF_MS[i]).toBeGreaterThan(RECORDED_LINK_BACKOFF_MS[i - 1])
    }
  })

  it('covers several minutes in total', () => {
    const total = RECORDED_LINK_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBeGreaterThanOrEqual(8 * 60 * 1000)
  })

  it('returns the delay for each attempt in order', () => {
    expect(nextRetryDelayMs(0)).toBe(10_000)
    expect(nextRetryDelayMs(1)).toBe(30_000)
    expect(nextRetryDelayMs(4)).toBe(300_000)
  })

  it('returns null past the end of the schedule', () => {
    expect(nextRetryDelayMs(RECORDED_LINK_BACKOFF_MS.length)).toBeNull()
    expect(nextRetryDelayMs(99)).toBeNull()
  })

  it('reports exhaustion only after every attempt has been used', () => {
    expect(hasExhaustedRetries(0)).toBe(false)
    expect(hasExhaustedRetries(RECORDED_LINK_BACKOFF_MS.length - 1)).toBe(false)
    expect(hasExhaustedRetries(RECORDED_LINK_BACKOFF_MS.length)).toBe(true)
  })
})

describe('the search fallback still behaves', () => {
  // The recorded path bypasses this, but a custom game or an unpublished match
  // falls back to it, so it must keep working.
  it('scores an overlapping recording window', () => {
    const fit = bestRecordingFit(
      { gameStartTimestamp: 1000, gameEndTimestamp: 100_000 },
      { recorded_at: 1000, duration_ms: 99_000 }
    )
    expect(fit?.overlapMs).toBeGreaterThan(0)
  })

  it('rejects a match that does not overlap the recording at all', () => {
    const fit = bestRecordingFit(
      { gameStartTimestamp: 1000, gameEndTimestamp: 100_000 },
      { recorded_at: 10_000_000, duration_ms: 60_000 }
    )
    expect(fit?.overlapMs).toBeLessThanOrEqual(0)
  })
})
