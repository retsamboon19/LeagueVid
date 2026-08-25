import { describe, expect, it } from 'vitest'
import type { MatchHistorySummary } from '../../../shared/types'
import { detachedRecording, historyMatchKey, historyMatchToVideoRow } from './matchHistory'

const match: MatchHistorySummary = {
  matchId: 'SG2_123',
  gameStartTimestamp: 1_000,
  gameEndTimestamp: 1_801_000,
  gameDuration: 1800,
  gameMode: 'CLASSIC',
  gameVersion: '16.1',
  championName: 'Poppy',
  kills: 7,
  deaths: 3,
  assists: 8,
  win: true,
  teamPosition: 'TOP',
  enemyChampionName: 'Garen',
  puuid: 'mine',
  platform: 'sg2',
  accountLabel: 'Player#SG2',
  queueId: 420,
  cs: 240,
  goldEarned: 13000,
  goldDiff: 1200,
  damageToChampions: 22000,
  visionScore: 28,
  summoner1Id: 4,
  summoner2Id: 12,
  keystoneId: 8437,
  items: [1, 2, 3, 4, 5, 6, 7],
  participants: [
    {
      puuid: 'mine',
      teamId: 100,
      championName: 'Poppy',
      displayName: 'Player#SG2',
      teamPosition: 'TOP',
      kills: 7,
      deaths: 3,
      assists: 8,
      cs: 240,
      goldEarned: 13000,
      items: [1, 2, 3, 4, 5, 6, 7],
      summoner1Id: 4,
      summoner2Id: 12,
      keystoneId: 8437
    },
    {
      puuid: 'enemy',
      teamId: 200,
      championName: 'Garen',
      displayName: 'Opponent#TOP',
      teamPosition: 'TOP',
      kills: 2,
      deaths: 6,
      assists: 1,
      cs: 210,
      goldEarned: 11800,
      items: [8, 9, 10, 11, 12, 13, 14],
      summoner1Id: 4,
      summoner2Id: 12,
      keystoneId: 8010
    }
  ]
}

describe('match history tile adapter', () => {
  it('preserves match totals and creates a video-shaped stat-only row', () => {
    const row = historyMatchToVideoRow(match, -1)
    expect(row).toMatchObject({
      id: -1,
      duration_ms: 1_800_000,
      match_id: 'SG2_123',
      champion_name: 'Poppy',
      kda: '7/3/8',
      win: 1,
      gold_diff: 1200
    })
  })

  it('marks the selected linked account as me in its roster', () => {
    const roster = JSON.parse(historyMatchToVideoRow(match, -1).match_data as string)
    expect(roster.allies[0]).toMatchObject({ puuid: 'mine', isMe: true })
    expect(roster.enemies[0]).toMatchObject({ puuid: 'enemy', isMe: false })
  })

  it('keys the same game separately when two linked accounts played it', () => {
    expect(historyMatchKey(match)).toBe('SG2_123:mine')
  })

  it('detaches match fields without removing the recording identity or favorite', () => {
    const linked = { ...historyMatchToVideoRow(match, 42), file_path: 'C:/vod.mp4', is_favorite: 1 }
    const detached = detachedRecording(linked)

    expect(detached).toMatchObject({
      id: 42,
      file_path: 'C:/vod.mp4',
      is_favorite: 1,
      match_id: null,
      champion_name: null,
      match_data: null
    })
  })
})
