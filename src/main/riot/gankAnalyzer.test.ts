import { describe, expect, it } from 'vitest'
import { analyzeGanks, type GankParticipant } from './gankAnalyzer'
import { BOT_LANE, MID_LANE, TOP_LANE } from './laneGeometry'
import type { TimelineFrameDto } from './types'

// Gank detection is a heuristic with several interacting rules -- third-party
// identity, lane geometry, proximity, and a 60s sampling grid. These tests pin
// the decisions that are easy to break by accident, using synthetic timelines so
// each rule can be isolated.
//
// Population-level behaviour is checked separately by
// scripts/verify-gank-stats.ts against the real cached match cache.

const MINUTE = 60_000

/** Blue side 1-5, red side 6-10, matching Riot's participant numbering. */
const ROSTER: GankParticipant[] = [
  { participantId: 1, teamId: 100, role: 'TOP' },
  { participantId: 2, teamId: 100, role: 'JUNGLE' },
  { participantId: 3, teamId: 100, role: 'MIDDLE' },
  { participantId: 4, teamId: 100, role: 'BOTTOM' },
  { participantId: 5, teamId: 100, role: 'UTILITY' },
  { participantId: 6, teamId: 200, role: 'TOP' },
  { participantId: 7, teamId: 200, role: 'JUNGLE' },
  { participantId: 8, teamId: 200, role: 'MIDDLE' },
  { participantId: 9, teamId: 200, role: 'BOTTOM' },
  { participantId: 10, teamId: 200, role: 'UTILITY' }
]

/** A point on a lane's centre line, so it is unambiguously "in lane". */
const TOP_SPOT = TOP_LANE[3]
const MID_SPOT = MID_LANE[3]
const BOT_SPOT = BOT_LANE[3]

/** Somewhere in the enemy jungle, far from every lane corridor. */
const OFF_LANE = { x: 7000, y: 4200 }

function frame(
  timestamp: number,
  positions: Record<number, { x: number; y: number }>,
  events: TimelineFrameDto['events'] = []
): TimelineFrameDto {
  const participantFrames: TimelineFrameDto['participantFrames'] = {}
  for (const [id, position] of Object.entries(positions)) {
    participantFrames[id] = { participantId: Number(id), position }
  }
  return { timestamp, events, participantFrames }
}

function kill(
  timestamp: number,
  killerId: number,
  victimId: number,
  position: { x: number; y: number },
  assists: number[] = []
): TimelineFrameDto['events'][number] {
  return {
    type: 'CHAMPION_KILL',
    timestamp,
    killerId,
    victimId,
    assistingParticipantIds: assists,
    position
  }
}

describe('analyzeGanks', () => {
  it('omits junglers entirely rather than reporting zeros for them', () => {
    const result = analyzeGanks([frame(MINUTE, { 2: OFF_LANE })], ROSTER)
    // A jungler has no lane to be ganked in, so "not applicable" must not be
    // rendered as a flawless laning phase.
    expect(result[2]).toBeUndefined()
    expect(result[7]).toBeUndefined()
  })

  it('counts a death in own lane involving a third party as a gank death', () => {
    const result = analyzeGanks(
      [frame(5 * MINUTE, {}, [kill(5 * MINUTE, 7, 1, TOP_SPOT, [6])])],
      ROSTER
    )
    expect(result[1].gankDeaths).toBe(1)
    // Exact fatal evidence also establishes the attempt even though no
    // once-a-minute participant frame happened to sample the ganker.
    expect(result[1].gankAttempts).toBe(1)
    expect(result[1].ganksSurvived).toBe(0)
    expect(result[1].gankEvents).toHaveLength(1)
    expect(result[1].gankEvents[0].outcome).toBe('died')
    // The enemy top laner assisted but is the expected matchup; only the
    // jungler counts as the ganker.
    expect(result[1].gankEvents[0].gankerParticipantIds).toEqual([7])
    expect(result[1].gankEvents[0].approximateTime).toBe(false)
  })

  it('does not count losing the 1v1 to the lane opponent as a gank', () => {
    const result = analyzeGanks(
      [frame(5 * MINUTE, {}, [kill(5 * MINUTE, 6, 1, TOP_SPOT)])],
      ROSTER
    )
    expect(result[1].gankDeaths).toBe(0)
    expect(result[1].gankEvents).toHaveLength(0)
  })

  it('does not treat a normal 2v2 bot lane death as a gank', () => {
    // Enemy ADC kills the bot laner with the enemy support assisting. Both are
    // the expected matchup down there, so this is lane, not a gank.
    const result = analyzeGanks(
      [frame(5 * MINUTE, {}, [kill(5 * MINUTE, 9, 4, BOT_SPOT, [10])])],
      ROSTER
    )
    expect(result[4].gankDeaths).toBe(0)
  })

  it('counts a mid laner roaming to bot as a gank, not just the jungler', () => {
    const result = analyzeGanks(
      [frame(6 * MINUTE, {}, [kill(6 * MINUTE, 8, 4, BOT_SPOT, [9])])],
      ROSTER
    )
    expect(result[4].gankDeaths).toBe(1)
    expect(result[4].gankEvents[0].gankerParticipantIds).toEqual([8])
  })

  it('ignores a third-party death outside the player\u2019s lane', () => {
    // Same collapse, but in the jungle rather than in lane -- an invade or a
    // river fight, not a lane gank.
    const result = analyzeGanks(
      [frame(5 * MINUTE, {}, [kill(5 * MINUTE, 7, 1, OFF_LANE, [6])])],
      ROSTER
    )
    expect(result[1].gankDeaths).toBe(0)
  })

  it('records a survived attempt when a third party is in lane beside the player', () => {
    const result = analyzeGanks([frame(4 * MINUTE, { 1: TOP_SPOT, 7: TOP_SPOT })], ROSTER)
    expect(result[1].gankAttempts).toBe(1)
    expect(result[1].ganksSurvived).toBe(1)
    expect(result[1].gankEvents).toHaveLength(1)
    expect(result[1].gankEvents[0].outcome).toBe('survived')
    // Sampled from a frame boundary, so the time is only approximate.
    expect(result[1].gankEvents[0].approximateTime).toBe(true)
    expect(result[1].gankEvents[0].timestampMs).toBe(4 * MINUTE)
  })

  it('requires proximity, not merely sharing the corridor', () => {
    // Both are inside the top lane corridor, but at opposite ends of it.
    const farEnd = TOP_LANE[7]
    const result = analyzeGanks([frame(4 * MINUTE, { 1: TOP_SPOT, 7: farEnd })], ROSTER)
    expect(result[1].gankAttempts).toBe(0)
  })

  it('requires the player to be in lane, so an empty-lane visit is not a gank', () => {
    const result = analyzeGanks([frame(4 * MINUTE, { 1: OFF_LANE, 7: TOP_SPOT })], ROSTER)
    expect(result[1].gankAttempts).toBe(0)
  })

  it('does not count the lane opponent standing next to the player', () => {
    const result = analyzeGanks([frame(4 * MINUTE, { 1: TOP_SPOT, 6: TOP_SPOT })], ROSTER)
    expect(result[1].gankAttempts).toBe(0)
  })

  it('merges consecutive frames into one attempt', () => {
    // A support parked in lane for three minutes is one prolonged presence, not
    // three separate ganks.
    const result = analyzeGanks(
      [
        frame(3 * MINUTE, { 4: BOT_SPOT, 8: BOT_SPOT }),
        frame(4 * MINUTE, { 4: BOT_SPOT, 8: BOT_SPOT }),
        frame(5 * MINUTE, { 4: BOT_SPOT, 8: BOT_SPOT })
      ],
      ROSTER
    )
    expect(result[4].gankAttempts).toBe(1)
  })

  it('separates attempts again once the ganker leaves and returns', () => {
    const result = analyzeGanks(
      [
        frame(3 * MINUTE, { 4: BOT_SPOT, 8: BOT_SPOT }),
        frame(4 * MINUTE, { 4: BOT_SPOT, 8: OFF_LANE }),
        frame(5 * MINUTE, { 4: BOT_SPOT, 8: BOT_SPOT })
      ],
      ROSTER
    )
    expect(result[4].gankAttempts).toBe(2)
  })

  it('does not count a sampled attempt as survived when it killed the player', () => {
    const result = analyzeGanks(
      [
        frame(4 * MINUTE, { 1: TOP_SPOT, 7: TOP_SPOT }, [
          kill(4 * MINUTE + 5_000, 7, 1, TOP_SPOT)
        ])
      ],
      ROSTER
    )
    expect(result[1].gankAttempts).toBe(1)
    expect(result[1].ganksSurvived).toBe(0)
    expect(result[1].gankDeaths).toBe(1)
    // One moment, so one row -- the death, not a death plus a survival.
    expect(result[1].gankEvents).toHaveLength(1)
    expect(result[1].gankEvents[0].outcome).toBe('died')
  })

  it('counts a sampled survival and a later unsampled fatal gank as two attempts', () => {
    const result = analyzeGanks(
      [
        frame(4 * MINUTE, { 1: TOP_SPOT, 7: TOP_SPOT }),
        frame(5 * MINUTE, { 1: TOP_SPOT, 7: OFF_LANE }),
        frame(8 * MINUTE, {}, [kill(8 * MINUTE + 10_000, 7, 1, TOP_SPOT)])
      ],
      ROSTER
    )

    expect(result[1].gankAttempts).toBe(2)
    expect(result[1].ganksSurvived).toBe(1)
    expect(result[1].gankDeaths).toBe(1)
    expect(result[1].gankEvents.map((event) => event.outcome)).toEqual(['survived', 'died'])
  })

  it('keeps attempts at least as large as deaths for every laner', () => {
    const result = analyzeGanks(
      [
        frame(3 * MINUTE, {}, [
          kill(3 * MINUTE + 5_000, 7, 1, TOP_SPOT),
          kill(3 * MINUTE + 10_000, 2, 6, TOP_SPOT)
        ]),
        frame(7 * MINUTE, {}, [kill(7 * MINUTE, 8, 4, BOT_SPOT)])
      ],
      ROSTER
    )

    for (const stats of Object.values(result)) {
      expect(stats.gankAttempts).toBeGreaterThanOrEqual(stats.gankDeaths)
    }
  })

  it('counts killing the ganker in your own lane as turning it around', () => {
    const result = analyzeGanks(
      [frame(5 * MINUTE, {}, [kill(5 * MINUTE, 1, 7, TOP_SPOT)])],
      ROSTER
    )
    expect(result[1].ganksTurnedAround).toBe(1)
    expect(result[1].gankEvents[0].outcome).toBe('turned_around')
    expect(result[1].gankEvents[0].gankerParticipantIds).toEqual([7])
  })

  it('does not credit a turnaround the player took no part in', () => {
    // The ally jungler kills the enemy jungler in top lane on their own.
    const result = analyzeGanks(
      [frame(5 * MINUTE, {}, [kill(5 * MINUTE, 2, 7, TOP_SPOT)])],
      ROSTER
    )
    expect(result[1].ganksTurnedAround).toBe(0)
  })

  it('treats a trade as no turnaround', () => {
    const result = analyzeGanks(
      [
        frame(5 * MINUTE, {}, [
          kill(5 * MINUTE, 1, 7, TOP_SPOT),
          // The player dies moments later, so the ganker was not punished for free.
          kill(5 * MINUTE + 4_000, 6, 1, TOP_SPOT)
        ])
      ],
      ROSTER
    )
    expect(result[1].ganksTurnedAround).toBe(0)
  })

  it('shows a survived-and-punished gank as one turned_around row', () => {
    // The sampled attempt and the kill on the ganker are the same gank, so the
    // list must not claim two.
    const result = analyzeGanks(
      [
        frame(5 * MINUTE, { 3: MID_SPOT, 7: MID_SPOT }, [
          kill(5 * MINUTE + 6_000, 3, 7, MID_SPOT)
        ])
      ],
      ROSTER
    )
    expect(result[3].gankAttempts).toBe(1)
    expect(result[3].ganksSurvived).toBe(1)
    expect(result[3].ganksTurnedAround).toBe(1)
    expect(result[3].gankEvents).toHaveLength(1)
    expect(result[3].gankEvents[0].outcome).toBe('turned_around')
    // The kill's exact time is preferred over the frame's approximate one.
    expect(result[3].gankEvents[0].approximateTime).toBe(false)
    expect(result[3].gankEvents[0].timestampMs).toBe(5 * MINUTE + 6_000)
  })

  it('includes Riot’s slightly late nominal 15:00 position frame', () => {
    const result = analyzeGanks(
      [frame(15 * MINUTE + 283, { 1: TOP_SPOT, 7: TOP_SPOT })],
      ROSTER
    )

    expect(result[1].gankAttempts).toBe(1)
    expect(result[1].ganksSurvived).toBe(1)
    expect(result[1].gankEvents[0].timestampMs).toBe(15 * MINUTE)
  })

  it('does not extend frame sampling materially beyond 15:00', () => {
    const result = analyzeGanks(
      [frame(15 * MINUTE + 5_001, { 1: TOP_SPOT, 7: TOP_SPOT })],
      ROSTER
    )

    expect(result[1].gankAttempts).toBe(0)
    expect(result[1].gankEvents).toHaveLength(0)
  })

  it('ignores everything after the laning phase ends', () => {
    const result = analyzeGanks(
      [
        frame(20 * MINUTE, { 1: TOP_SPOT, 7: TOP_SPOT }, [
          kill(20 * MINUTE, 7, 1, TOP_SPOT, [6])
        ])
      ],
      ROSTER
    )
    expect(result[1].gankDeaths).toBe(0)
    expect(result[1].gankAttempts).toBe(0)
    expect(result[1].gankEvents).toHaveLength(0)
  })

  it('ignores the frame at 0ms, where everyone shares the fountain', () => {
    const result = analyzeGanks([frame(0, { 1: TOP_SPOT, 7: TOP_SPOT })], ROSTER)
    expect(result[1].gankAttempts).toBe(0)
  })

  it('returns events in chronological order', () => {
    const result = analyzeGanks(
      [
        frame(3 * MINUTE, { 1: TOP_SPOT, 7: TOP_SPOT }),
        frame(8 * MINUTE, {}, [kill(8 * MINUTE, 7, 1, TOP_SPOT, [6])]),
        frame(6 * MINUTE, {}, [kill(6 * MINUTE, 1, 8, TOP_SPOT)])
      ],
      ROSTER
    )
    const times = result[1].gankEvents.map((e) => e.timestampMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times).toHaveLength(3)
  })

  it('gives every event a distinct timestamp, so feedback keys cannot collide', () => {
    const result = analyzeGanks(
      [
        frame(3 * MINUTE, { 1: TOP_SPOT, 7: TOP_SPOT }),
        frame(9 * MINUTE, {}, [kill(9 * MINUTE, 7, 1, TOP_SPOT, [6])])
      ],
      ROSTER
    )
    const keys = result[1].gankEvents.map((e) => Math.round(e.timestampMs))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('returns nothing when there is no timeline to read', () => {
    expect(analyzeGanks([], ROSTER)).toEqual({})
  })
})
