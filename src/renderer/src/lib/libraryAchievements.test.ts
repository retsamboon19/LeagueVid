import { describe, expect, it } from 'vitest'
import type { MatchStats, StatsParticipant, VideoRow } from '../../../shared/types'
import { buildAchievementsByVideo } from './libraryAchievements'

function participant(overrides: Partial<StatsParticipant>): StatsParticipant {
  return {
    puuid: 'player',
    participantId: 1,
    teamId: 100,
    displayName: null,
    championName: 'Yorick',
    champLevel: 16,
    teamPosition: 'TOP',
    kills: 6,
    deaths: 6,
    assists: 0,
    cs: 224,
    goldEarned: 13_000,
    damageToChampions: 22_500,
    damageTaken: 20_000,
    damageSelfMitigated: 10_000,
    damageToObjectives: 15_000,
    damageToTurrets: 14_254,
    visionScore: 20,
    wardsPlaced: 10,
    wardsKilled: 2,
    controlWardsPlaced: 1,
    turretKills: 3,
    largestMultiKill: 2,
    largestKillingSpree: 3,
    timeCCingOthers: 5,
    totalHeal: 0,
    healsOnTeammates: 0,
    shieldedOnTeammates: 0,
    longestTimeSpentLiving: 600,
    totalTimeSpentDead: 180,
    items: [],
    summoner1Id: 4,
    summoner2Id: 12,
    perks: [],
    challenges: {},
    skillOrder: [],
    itemPurchases: [],
    ...overrides
  }
}

const video = {
  id: 1906,
  match_id: 'SG2_TEST',
  match_data: null
} as VideoRow

const stats: MatchStats = {
  matchId: 'SG2_TEST',
  gameDurationSeconds: 29 * 60,
  gameMode: 'CLASSIC',
  gameVersion: 'test',
  hasTimeline: true,
  ownerPuuid: 'player',
  teams: [
    { teamId: 100, win: true, kills: 20, deaths: 15, assists: 25, goldEarned: 55_000 },
    { teamId: 200, win: false, kills: 15, deaths: 20, assists: 18, goldEarned: 50_000 }
  ],
  participants: [
    participant({}),
    participant({
      puuid: 'opponent',
      participantId: 6,
      teamId: 200,
      championName: 'Rumble',
      kills: 3,
      deaths: 7,
      assists: 2,
      cs: 151,
      goldEarned: 9_400,
      damageToChampions: 17_200
    })
  ],
  frames: [],
  heuristicsByParticipant: {},
  earlyPhaseByParticipant: { 1: { kills: 1, deaths: 3, assists: 0 } },
  gankByParticipant: {
    1: {
      gankDeaths: 3,
      gankAttempts: 3,
      ganksSurvived: 0,
      ganksTurnedAround: 0,
      gankEvents: []
    }
  },
  objectives: []
}

describe('library achievement evaluation', () => {
  it('matches full-detail gank and tower-dive achievements used by the player page', () => {
    const byVideo = buildAchievementsByVideo(
      [video],
      new Map([[video.id, stats]]),
      new Map([[video.id, 1]])
    )

    const earned = byVideo.get(video.id)?.earnedIds
    expect(earned?.has('held_under_pressure')).toBe(true)
    expect(earned?.has('tower_diver')).toBe(true)
  })

  it('updates a cached recording when its grouped tower-dive evidence arrives', () => {
    const withoutDive = buildAchievementsByVideo(
      [video],
      new Map([[video.id, stats]]),
      new Map()
    )
    const withDive = buildAchievementsByVideo(
      [video],
      new Map([[video.id, stats]]),
      new Map([[video.id, 1]])
    )

    expect(withoutDive.get(video.id)?.earnedIds.has('tower_diver')).toBe(false)
    expect(withDive.get(video.id)?.earnedIds.has('tower_diver')).toBe(true)
  })
})
