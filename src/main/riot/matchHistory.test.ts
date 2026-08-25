import { describe, expect, it } from 'vitest'
import type { MatchInfoDto, ParticipantDto } from './types'
import { buildMatchHistorySummary } from './matchHistory'

function participant(overrides: Partial<ParticipantDto> = {}): ParticipantDto {
  return {
    puuid: 'mine',
    participantId: 1,
    championName: 'Poppy',
    championId: 78,
    champLevel: 18,
    teamId: 100,
    kills: 7,
    deaths: 3,
    assists: 8,
    win: true,
    teamPosition: 'TOP',
    individualPosition: 'TOP',
    goldEarned: 13_000,
    totalMinionsKilled: 220,
    neutralMinionsKilled: 20,
    summoner1Id: 4,
    summoner2Id: 12,
    item0: 1,
    item1: 2,
    item2: 3,
    item3: 4,
    item4: 5,
    item5: 6,
    item6: 7,
    riotIdGameName: 'Player',
    riotIdTagline: 'SG2',
    totalDamageDealtToChampions: 22_000,
    visionScore: 28,
    perks: {
      styles: [
        {
          description: 'primaryStyle',
          selections: [{ perk: 8437, var1: 0, var2: 0, var3: 0 }],
          style: 8400
        }
      ]
    },
    ...overrides
  }
}

describe('buildMatchHistorySummary', () => {
  it('extracts the owner, lane opponent, loadout, and compact scoreboard', () => {
    const owner = participant()
    const opponent = participant({
      puuid: 'enemy',
      participantId: 6,
      championName: 'Garen',
      teamId: 200,
      kills: 2,
      deaths: 6,
      assists: 1,
      win: false,
      goldEarned: 11_800,
      riotIdGameName: 'Opponent',
      riotIdTagline: undefined
    })
    const info: MatchInfoDto = {
      gameStartTimestamp: 1_000,
      gameEndTimestamp: 1_801_000,
      gameDuration: 1800,
      gameMode: 'CLASSIC',
      gameVersion: '16.1',
      queueId: 420,
      participants: [owner, opponent]
    }

    const result = buildMatchHistorySummary('SG2_123', info, owner, {
      platform: 'sg2',
      puuid: 'mine',
      accountLabel: 'Player#SG2'
    })

    expect(result).toMatchObject({
      matchId: 'SG2_123',
      enemyChampionName: 'Garen',
      cs: 240,
      goldDiff: 1200,
      damageToChampions: 22_000,
      visionScore: 28,
      keystoneId: 8437,
      items: [1, 2, 3, 4, 5, 6, 7]
    })
    expect(result.participants).toHaveLength(2)
    expect(result.participants[0].displayName).toBe('Player#SG2')
    expect(result.participants[1].displayName).toBe('Opponent')
  })

  it('does not invent an opponent when Riot has no valid lane assignment', () => {
    const owner = participant({ teamPosition: '', individualPosition: 'Invalid' })
    const info: MatchInfoDto = {
      gameStartTimestamp: 1_000,
      gameEndTimestamp: 1_801_000,
      gameDuration: 1800,
      gameMode: 'ARAM',
      gameVersion: '16.1',
      participants: [owner]
    }

    const result = buildMatchHistorySummary('SG2_456', info, owner, {
      platform: 'sg2',
      puuid: 'mine',
      accountLabel: 'Player#SG2'
    })

    expect(result.enemyChampionName).toBeNull()
    expect(result.goldDiff).toBeNull()
  })
})
