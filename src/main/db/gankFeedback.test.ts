import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { closeDb, initDb } from './index'
import * as repo from './repository'

// Covers the gank_feedback table: the migration creating it, and the
// upsert/clear/read cycle behind the accurate/wrong buttons in the stats panel.
//
// Runs against a scratch database file. initDb only reaches for Electron when no
// path is given, so passing one keeps this a plain Node test.
//
// The scoping cases matter more than they look: verdicts are keyed on
// (match_id, participant_id, timestamp_ms) rather than a row id, because gank
// stats are recomputed from cached timelines on every panel open and have no
// stable id. If that key were wrong, one verdict would silently overwrite
// another and the tuning data would be quietly corrupt.

const dbPath = join(tmpdir(), `leaguevid-gank-feedback-test-${process.pid}.db`)

const MATCH = 'SG2_TEST_GANK'
const ME = 4
const AT = 312_000

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initDb(dbPath)
})

afterAll(() => {
  closeDb()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('gank feedback storage', () => {
  it('starts with no verdicts', () => {
    expect(repo.listGankFeedback(MATCH, ME)).toEqual([])
  })

  it('stores a verdict with its context', () => {
    repo.setGankFeedback({
      matchId: MATCH,
      participantId: ME,
      timestampMs: AT,
      outcome: 'survived',
      gankerParticipantIds: [7, 9],
      verdict: 'accurate'
    })

    const rows = repo.listGankFeedback(MATCH, ME)
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('accurate')
    expect(rows[0].outcome).toBe('survived')
    expect(rows[0].timestamp_ms).toBe(AT)
    // Kept so a verdict stays interpretable even if retuning stops detecting
    // this gank at all.
    expect(rows[0].ganker_ids).toBe('[7,9]')
  })

  it('replaces the verdict instead of adding a contradictory row', () => {
    repo.setGankFeedback({
      matchId: MATCH,
      participantId: ME,
      timestampMs: AT,
      outcome: 'survived',
      gankerParticipantIds: [7, 9],
      verdict: 'wrong'
    })

    const rows = repo.listGankFeedback(MATCH, ME)
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('wrong')
  })

  it('treats a different timestamp as a different gank', () => {
    repo.setGankFeedback({
      matchId: MATCH,
      participantId: ME,
      timestampMs: 480_000,
      outcome: 'died',
      gankerParticipantIds: [7],
      verdict: 'accurate'
    })
    expect(repo.listGankFeedback(MATCH, ME)).toHaveLength(2)
  })

  it('scopes verdicts per participant within the same match', () => {
    repo.setGankFeedback({
      matchId: MATCH,
      participantId: 5,
      timestampMs: AT,
      outcome: 'survived',
      gankerParticipantIds: [8],
      verdict: 'accurate'
    })

    // Same match, same timestamp, different player -- must not collide.
    expect(repo.listGankFeedback(MATCH, 5)).toHaveLength(1)
    expect(repo.listGankFeedback(MATCH, ME)).toHaveLength(2)
  })

  it('returns verdicts oldest first', () => {
    const times = repo.listGankFeedback(MATCH, ME).map((r) => r.timestamp_ms)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('summarises verdicts for the tuning workflow', () => {
    const summary = repo.getGankFeedbackSummary()
    expect(summary.accurate).toBe(2)
    expect(summary.wrong).toBe(1)
    expect(summary.rows).toHaveLength(3)
    expect(summary.byOutcome.length).toBeGreaterThan(0)
  })

  it('clears only the targeted gank', () => {
    repo.clearGankFeedback({ matchId: MATCH, participantId: ME, timestampMs: AT })

    const rows = repo.listGankFeedback(MATCH, ME)
    expect(rows).toHaveLength(1)
    expect(rows[0].timestamp_ms).toBe(480_000)
    // The other participant's verdict is untouched.
    expect(repo.listGankFeedback(MATCH, 5)).toHaveLength(1)
  })

  it('is a no-op when clearing something that was never judged', () => {
    expect(() =>
      repo.clearGankFeedback({ matchId: MATCH, participantId: ME, timestampMs: 999_999 })
    ).not.toThrow()
    expect(repo.listGankFeedback(MATCH, ME)).toHaveLength(1)
  })
})
