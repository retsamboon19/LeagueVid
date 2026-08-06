import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { closeDb, initDb } from './index'
import * as repo from './repository'

const dbPath = join(tmpdir(), `leaguevid-retention-candidates-test-${process.pid}.db`)

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initDb(dbPath)
})

afterAll(() => {
  closeDb()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('retention candidate sizes', () => {
  it('reuses the duration-probe size for imported videos', () => {
    const filePath = 'G:\\recordings\\cached-import.mp4'
    const sizeBytes = 1_234_567_890
    repo.setCachedVideoDuration(filePath, sizeBytes, 31 * 60_000)
    const video = repo.insertVideo({
      filePath,
      fileName: 'cached-import.mp4',
      durationMs: 31 * 60_000,
      source: 'imported'
    })

    const candidate = repo
      .listRetentionCandidates()
      .find((entry) => entry.videoId === video.id)

    expect(candidate?.sizeBytes).toBe(sizeBytes)
  })
})
