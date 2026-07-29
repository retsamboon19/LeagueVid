import { describe, expect, it } from 'vitest'
import {
  estimateGameStart,
  extractGameSnapshot,
  medianGameStart,
  type GameSnapshot
} from './liveClientData'

/** Shape of a real /liveclientdata/allgamedata response, trimmed. */
function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    activePlayer: {
      riotId: 'Yorickenjoyer#EUW',
      summonerName: 'Yorickenjoyer',
      level: 6
    },
    allPlayers: [
      { championName: 'Yorick', riotId: 'Yorickenjoyer#EUW', team: 'ORDER', position: 'TOP' },
      { championName: 'Malphite', riotId: 'Rockman#EUW', team: 'CHAOS', position: 'TOP' }
    ],
    events: {
      Events: [
        { EventID: 0, EventName: 'GameStart', EventTime: 0.05 },
        {
          EventID: 1,
          EventName: 'ChampionKill',
          EventTime: 331.4,
          KillerName: 'Yorickenjoyer#EUW',
          VictimName: 'Rockman#EUW',
          Assisters: []
        }
      ]
    },
    gameData: {
      gameMode: 'CLASSIC',
      gameTime: 331.884,
      mapName: 'Map11',
      mapNumber: 11,
      mapTerrain: 'Default'
    },
    ...overrides
  }
}

function snapshotAt(gameTime: number, sampledAt: number): GameSnapshot {
  return {
    gameTime,
    gameMode: 'CLASSIC',
    mapNumber: 11,
    championName: 'Yorick',
    activePlayerName: 'x',
    events: [],
    sampledAt
  }
}

describe('extractGameSnapshot', () => {
  it('reads the fields the recorder needs', () => {
    const snapshot = extractGameSnapshot(payload(), 1_700_000_000_000)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.gameTime).toBe(331.884)
    expect(snapshot?.gameMode).toBe('CLASSIC')
    expect(snapshot?.mapNumber).toBe(11)
    expect(snapshot?.championName).toBe('Yorick')
    expect(snapshot?.events).toHaveLength(2)
  })

  // Riot has used riotId, riotIdGameName and summonerName as the canonical
  // identifier at different points, so all three have to resolve.
  it('matches the active player by riotIdGameName', () => {
    const snapshot = extractGameSnapshot(
      payload({
        activePlayer: { riotIdGameName: 'Yorickenjoyer' },
        allPlayers: [{ championName: 'Yorick', riotIdGameName: 'Yorickenjoyer' }]
      }),
      1
    )
    expect(snapshot?.championName).toBe('Yorick')
  })

  it('matches the active player by summonerName alone', () => {
    const snapshot = extractGameSnapshot(
      payload({
        activePlayer: { summonerName: 'Yorickenjoyer' },
        allPlayers: [{ championName: 'Yorick', summonerName: 'Yorickenjoyer' }]
      }),
      1
    )
    expect(snapshot?.championName).toBe('Yorick')
  })

  // One field carries 'Name#TAG' and another just 'Name', depending on patch.
  it('matches a tagged id against an untagged name', () => {
    const snapshot = extractGameSnapshot(
      payload({
        activePlayer: { riotId: 'Yorickenjoyer#EUW' },
        allPlayers: [{ championName: 'Yorick', summonerName: 'Yorickenjoyer' }]
      }),
      1
    )
    expect(snapshot?.championName).toBe('Yorick')
  })

  // The champion only affects the recording's file name, so not knowing it is
  // survivable. Refusing to record over it would not be.
  it('returns a snapshot with no champion rather than nothing', () => {
    const snapshot = extractGameSnapshot(payload({ allPlayers: [] }), 1)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.championName).toBeNull()
  })

  it('tolerates a missing event list', () => {
    const snapshot = extractGameSnapshot(payload({ events: undefined }), 1)
    expect(snapshot?.events).toEqual([])
  })

  // Without a clock there is nothing to anchor the recording to, which is the
  // one field that genuinely cannot be missing.
  it('rejects a response with no game clock', () => {
    expect(extractGameSnapshot(payload({ gameData: {} }), 1)).toBeNull()
    expect(extractGameSnapshot(payload({ gameData: { gameTime: 'soon' } }), 1)).toBeNull()
    expect(extractGameSnapshot(null, 1)).toBeNull()
    expect(extractGameSnapshot({}, 1)).toBeNull()
  })

  it('accepts a game clock of exactly zero', () => {
    const snapshot = extractGameSnapshot(payload({ gameData: { gameTime: 0 } }), 1)
    expect(snapshot?.gameTime).toBe(0)
  })
})

describe('estimateGameStart', () => {
  it('subtracts the in-game clock from the sample time', () => {
    expect(estimateGameStart(snapshotAt(300, 1_000_000))).toBe(1_000_000 - 300_000)
  })
})

describe('medianGameStart', () => {
  it('is null with no samples', () => {
    expect(medianGameStart([])).toBeNull()
  })

  it('agrees with a single sample', () => {
    expect(medianGameStart([snapshotAt(10, 20_000)])).toBe(10_000)
  })

  // Every sample says the game started at 10_000; latency only ever delays a
  // reply, so each estimate lands at or after the truth.
  it('recovers the true start from jittered samples', () => {
    const trueStart = 1_700_000_000_000
    const jitter = [0, 40, 15, 120, 8, 60, 25, 200, 5, 33]
    const samples = jitter.map((delayMs, index) => {
      const sampledAt = trueStart + (index + 1) * 2000 + delayMs
      // The reported clock reflects the moment the game answered, not the
      // moment we read it, so the delay shows up as an overestimate.
      return snapshotAt((sampledAt - trueStart - delayMs) / 1000, sampledAt)
    })

    const median = medianGameStart(samples) as number
    expect(Math.abs(median - trueStart)).toBeLessThanOrEqual(40)
  })

  // The reason for median over mean: latency error is one-sided, so a couple of
  // very slow replies drag a mean upward while leaving the median alone. The
  // result positions every bookmark on the recording.
  it('resists outliers that would skew a mean', () => {
    const trueStart = 1_000_000
    const clean = [10, 20, 30, 40, 50].map((seconds) =>
      snapshotAt(seconds, trueStart + seconds * 1000)
    )
    const withOutliers = [
      ...clean,
      snapshotAt(60, trueStart + 60_000 + 5000),
      snapshotAt(70, trueStart + 70_000 + 9000)
    ]

    expect(medianGameStart(clean)).toBe(trueStart)
    const median = medianGameStart(withOutliers) as number
    const mean =
      withOutliers.reduce((total, s) => total + estimateGameStart(s), 0) / withOutliers.length

    expect(Math.abs(median - trueStart)).toBeLessThan(Math.abs(mean - trueStart))
    expect(median).toBe(trueStart)
  })

  it('averages the middle pair for an even sample count', () => {
    const samples = [snapshotAt(10, 20_000), snapshotAt(10, 20_100)]
    expect(medianGameStart(samples)).toBe(10_050)
  })

  it('does not care what order samples arrive in', () => {
    const samples = [snapshotAt(30, 31_000), snapshotAt(10, 11_000), snapshotAt(20, 21_500)]
    expect(medianGameStart(samples)).toBe(1000)
  })
})
