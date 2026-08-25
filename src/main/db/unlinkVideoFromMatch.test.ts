import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { closeDb, initDb } from './index'
import * as repo from './repository'

const dbPath = join(tmpdir(), `leaguevid-unlink-match-test-${process.pid}.db`)
let videoId = 0

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initDb(dbPath)
  const video = repo.insertVideo({
    filePath: 'C:/recordings/game.mp4',
    fileName: 'game.mp4',
    recordedAt: 1_000,
    durationMs: 1_800_000
  })
  videoId = video.id

  repo.linkVideoToMatch({
    videoId,
    matchId: 'SG2_123',
    syncOffsetMs: 5_000,
    championName: 'Garen',
    kda: '8/2/4',
    win: true,
    kills: 8,
    deaths: 2,
    assists: 4,
    cs: 240,
    goldDiff: 1_500,
    enemyChampionName: 'Darius',
    summoner1Id: 4,
    summoner2Id: 12,
    keystoneId: 8010,
    gameMode: 'CLASSIC',
    matchData: { allies: [], enemies: [], gameDurationSeconds: 1800 },
    teamPosition: 'TOP',
    queueId: 420
  })
  repo.insertTags(videoId, [
    { timestampMs: 60_000, type: 'kill', label: 'Kill', source: 'auto' },
    { timestampMs: 90_000, type: 'manual', label: 'My note', source: 'manual' }
  ])
})

afterAll(() => {
  closeDb()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('unlinkVideoFromMatch', () => {
  it('keeps the recording, clears match fields, and preserves manual tags only', () => {
    repo.unlinkVideoFromMatch(videoId)

    expect(repo.getVideo(videoId)).toMatchObject({
      id: videoId,
      file_path: 'C:/recordings/game.mp4',
      match_id: null,
      champion_name: null,
      match_data: null
    })
    expect(repo.listTags(videoId).map((tag) => ({ source: tag.source, label: tag.label }))).toEqual([
      { source: 'manual', label: 'My note' }
    ])
  })
})
