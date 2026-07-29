import { describe, expect, it } from 'vitest'
import {
  formatRetentionSummary,
  isEligibleForRetention,
  planRetention,
  type RetentionCandidate,
  type RetentionLimits
} from './retention'

const DAY = 24 * 60 * 60 * 1000
const GB = 1024 ** 3
const NOW = 1_700_000_000_000

function candidate(overrides: Partial<RetentionCandidate> & { videoId: number }): RetentionCandidate {
  return {
    filePath: `H:\\recordings\\${overrides.videoId}.mp4`,
    fileName: `${overrides.videoId}.mp4`,
    sizeBytes: GB,
    recordedAt: NOW - DAY,
    isFavorite: false,
    source: 'recorded',
    ...overrides
  }
}

function limits(overrides: Partial<RetentionLimits> = {}): RetentionLimits {
  return { enabled: true, maxGb: null, maxAgeDays: null, ...overrides }
}

describe('isEligibleForRetention', () => {
  it('allows a plain recorded video', () => {
    expect(isEligibleForRetention(candidate({ videoId: 1 }))).toBe(true)
  })

  // A file the user imported is theirs. A retention rule they set for
  // LeagueVid's own recordings must never reach it.
  it('never touches an imported file', () => {
    expect(isEligibleForRetention(candidate({ videoId: 1, source: 'imported' }))).toBe(false)
  })

  // Rows written before the source column existed read null, and the safe
  // reading of "unknown origin" is "not ours to delete".
  it('never touches a video with no recorded source', () => {
    expect(isEligibleForRetention(candidate({ videoId: 1, source: null }))).toBe(false)
  })

  // Marking a favourite is the user saying keep this. No size limit outranks it.
  it('never touches a favourite', () => {
    expect(isEligibleForRetention(candidate({ videoId: 1, isFavorite: true }))).toBe(false)
  })
})

describe('planRetention', () => {
  describe('when it must do nothing', () => {
    it('deletes nothing while disabled', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, recordedAt: NOW - 400 * DAY })],
        limits({ enabled: false, maxAgeDays: 7, maxGb: 1 }),
        NOW
      )
      expect(plan.toDelete).toEqual([])
    })

    // An enabled sweep with no rules set must not be read as "delete
    // everything" -- that reading would empty someone's library on a
    // half-finished configuration.
    it('deletes nothing when enabled with no limits set', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, recordedAt: NOW - 400 * DAY, sizeBytes: 500 * GB })],
        limits(),
        NOW
      )
      expect(plan.toDelete).toEqual([])
    })

    it('deletes nothing when everything is within the limits', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, sizeBytes: GB })],
        limits({ maxGb: 10, maxAgeDays: 30 }),
        NOW
      )
      expect(plan.toDelete).toEqual([])
      expect(formatRetentionSummary(plan)).toBe('Nothing would be deleted.')
    })
  })

  describe('the age limit', () => {
    it('deletes recordings past the age limit', () => {
      const plan = planRetention(
        [
          candidate({ videoId: 1, recordedAt: NOW - 40 * DAY }),
          candidate({ videoId: 2, recordedAt: NOW - 10 * DAY })
        ],
        limits({ maxAgeDays: 30 }),
        NOW
      )
      expect(plan.toDelete.map((c) => c.videoId)).toEqual([1])
      expect(plan.reasons[1]).toContain('40 days old')
    })

    it('keeps a recording exactly at the limit', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, recordedAt: NOW - 30 * DAY })],
        limits({ maxAgeDays: 30 }),
        NOW
      )
      expect(plan.toDelete).toEqual([])
    })

    it('spares an old favourite', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, recordedAt: NOW - 400 * DAY, isFavorite: true })],
        limits({ maxAgeDays: 30 }),
        NOW
      )
      expect(plan.toDelete).toEqual([])
    })

    it('spares an old imported file', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, recordedAt: NOW - 400 * DAY, source: 'imported' })],
        limits({ maxAgeDays: 30 }),
        NOW
      )
      expect(plan.toDelete).toEqual([])
    })
  })

  describe('the size limit', () => {
    it('deletes oldest first until under the limit', () => {
      const plan = planRetention(
        [
          candidate({ videoId: 1, recordedAt: NOW - 5 * DAY, sizeBytes: 2 * GB }),
          candidate({ videoId: 2, recordedAt: NOW - 4 * DAY, sizeBytes: 2 * GB }),
          candidate({ videoId: 3, recordedAt: NOW - 3 * DAY, sizeBytes: 2 * GB }),
          candidate({ videoId: 4, recordedAt: NOW - 2 * DAY, sizeBytes: 2 * GB })
        ],
        limits({ maxGb: 5 }),
        NOW
      )

      // 8 GB total, 5 GB limit: dropping the two oldest gets to 4 GB.
      expect(plan.toDelete.map((c) => c.videoId)).toEqual([1, 2])
      expect(plan.reclaimedBytes).toBe(4 * GB)
    })

    it('stops as soon as it is under the limit', () => {
      const plan = planRetention(
        [
          candidate({ videoId: 1, recordedAt: NOW - 5 * DAY, sizeBytes: 4 * GB }),
          candidate({ videoId: 2, recordedAt: NOW - 4 * DAY, sizeBytes: 1 * GB })
        ],
        limits({ maxGb: 2 }),
        NOW
      )
      expect(plan.toDelete.map((c) => c.videoId)).toEqual([1])
    })

    // An untouchable library of favourites sitting above the limit would
    // otherwise make the sweep delete everything it could reach and still fail
    // to get under it.
    it('counts untouchable files against the budget', () => {
      const plan = planRetention(
        [
          candidate({ videoId: 1, recordedAt: NOW - 5 * DAY, sizeBytes: 8 * GB, isFavorite: true }),
          candidate({ videoId: 2, recordedAt: NOW - 4 * DAY, sizeBytes: GB })
        ],
        limits({ maxGb: 5 }),
        NOW
      )
      // The favourite alone exceeds the limit, so the one deletable file goes --
      // and the favourite still survives.
      expect(plan.toDelete.map((c) => c.videoId)).toEqual([2])
      expect(plan.kept.map((c) => c.videoId)).toEqual([1])
    })

    it('never deletes a favourite to satisfy a size limit', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, sizeBytes: 100 * GB, isFavorite: true })],
        limits({ maxGb: 1 }),
        NOW
      )
      expect(plan.toDelete).toEqual([])
    })
  })

  describe('both limits together', () => {
    // Age answers "I don't care about old games", size answers "don't use more
    // than this much disk". Age is applied first so the size pass isn't spending
    // its budget on recordings the age rule would have removed anyway.
    it('applies age first, then size', () => {
      const plan = planRetention(
        [
          candidate({ videoId: 1, recordedAt: NOW - 100 * DAY, sizeBytes: 3 * GB }),
          candidate({ videoId: 2, recordedAt: NOW - 5 * DAY, sizeBytes: 3 * GB }),
          candidate({ videoId: 3, recordedAt: NOW - 4 * DAY, sizeBytes: 3 * GB })
        ],
        limits({ maxAgeDays: 30, maxGb: 5 }),
        NOW
      )

      expect(plan.reasons[1]).toContain('days old')
      // After the age pass, 6 GB remains against a 5 GB limit, so the oldest
      // survivor goes too.
      expect(plan.toDelete.map((c) => c.videoId)).toEqual([1, 2])
      expect(plan.reasons[2]).toContain('5 GB limit')
    })

    it('does not count a video twice', () => {
      const plan = planRetention(
        [candidate({ videoId: 1, recordedAt: NOW - 100 * DAY, sizeBytes: 10 * GB })],
        limits({ maxAgeDays: 30, maxGb: 1 }),
        NOW
      )
      expect(plan.toDelete).toHaveLength(1)
      expect(plan.reclaimedBytes).toBe(10 * GB)
    })
  })

  it('reports totals for the readout', () => {
    const plan = planRetention(
      [
        candidate({ videoId: 1, sizeBytes: 2 * GB, recordedAt: NOW - 100 * DAY }),
        candidate({ videoId: 2, sizeBytes: 3 * GB })
      ],
      limits({ maxAgeDays: 30 }),
      NOW
    )
    expect(plan.totalBytes).toBe(5 * GB)
    expect(plan.reclaimedBytes).toBe(2 * GB)
    expect(formatRetentionSummary(plan)).toBe('1 recording(s) would be deleted, freeing 2.0 GB.')
  })

  it('lists deletions oldest first', () => {
    const plan = planRetention(
      [
        candidate({ videoId: 3, recordedAt: NOW - 100 * DAY }),
        candidate({ videoId: 1, recordedAt: NOW - 300 * DAY }),
        candidate({ videoId: 2, recordedAt: NOW - 200 * DAY })
      ],
      limits({ maxAgeDays: 30 }),
      NOW
    )
    expect(plan.toDelete.map((c) => c.videoId)).toEqual([1, 2, 3])
  })

  // The property that matters: preview and sweep call this same function, so a
  // preview cannot describe one outcome while the sweep performs another.
  it('is deterministic for the same inputs', () => {
    const candidates = [
      candidate({ videoId: 1, recordedAt: NOW - 100 * DAY, sizeBytes: 2 * GB }),
      candidate({ videoId: 2, recordedAt: NOW - 50 * DAY, sizeBytes: 4 * GB })
    ]
    const config = limits({ maxAgeDays: 60, maxGb: 3 })

    const first = planRetention(candidates, config, NOW)
    const second = planRetention(candidates, config, NOW)

    expect(second.toDelete.map((c) => c.videoId)).toEqual(first.toDelete.map((c) => c.videoId))
    expect(second.reclaimedBytes).toBe(first.reclaimedBytes)
  })

  it('handles an empty library', () => {
    const plan = planRetention([], limits({ maxGb: 1, maxAgeDays: 1 }), NOW)
    expect(plan.toDelete).toEqual([])
    expect(plan.totalBytes).toBe(0)
  })
})
