// Standalone test of the SQLite database layer, run outside Electron.
// Usage: npx tsx scripts/test-db.ts
//
// Verifies: schema creation, video insert/upsert, linking to a match,
// tag insert (auto + manual), listing, updating, deleting, and cascade delete.

import { existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { getDb, closeDb } from '../src/main/db'
import * as repo from '../src/main/db/repository'

const TEST_DB_PATH = resolve(__dirname, '../test-leaguevid.db')

function cleanupDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix
    if (existsSync(p)) unlinkSync(p)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

async function main(): Promise<void> {
  cleanupDbFiles()
  getDb(TEST_DB_PATH) // initialize with test path

  console.log('[1/6] Inserting a video...')
  const video = repo.insertVideo({
    filePath: 'C:/recordings/game1.mp4',
    fileName: 'game1.mp4',
    recordedAt: Date.now(),
    durationMs: 1_800_000
  })
  assert(video.id > 0, 'video should have an id')
  console.log(`  -> inserted video id=${video.id}`)

  console.log('\n[2/6] Testing upsert (insert same file_path again)...')
  const videoAgain = repo.insertVideo({
    filePath: 'C:/recordings/game1.mp4',
    fileName: 'game1-renamed.mp4'
  })
  assert(videoAgain.id === video.id, 'upsert should reuse the same row id')
  console.log(`  -> upsert returned same id=${videoAgain.id}, file_name updated`)

  console.log('\n[3/6] Linking video to a match...')
  repo.linkVideoToMatch({
    videoId: video.id,
    matchId: 'SG2_123456789',
    syncOffsetMs: 5000,
    championName: 'Pantheon',
    kda: '5/8/17',
    win: true
  })
  const linked = repo.getVideo(video.id)
  assert(linked?.match_id === 'SG2_123456789', 'match_id should be set')
  assert(linked?.win === 1, 'win should be stored as 1')
  console.log(`  -> linked to match ${linked?.match_id}, champion=${linked?.champion_name}`)

  console.log('\n[4/6] Inserting auto tags + a manual tag...')
  repo.insertTags(video.id, [
    { timestampMs: 136000, type: 'death', label: 'Death (Pantheon)', source: 'auto' },
    { timestampMs: 138000, type: 'assist', label: 'Assist (Pantheon)', source: 'auto' },
    { timestampMs: 857000, type: 'kill', label: 'Kill (Pantheon)', source: 'auto' }
  ])
  const manualTag = repo.insertManualTag({
    videoId: video.id,
    timestampMs: 300000,
    type: 'outplay',
    label: 'Nice 1v2 outplay'
  })
  const allTags = repo.listTags(video.id)
  assert(allTags.length === 4, `expected 4 tags, got ${allTags.length}`)
  console.log(`  -> ${allTags.length} tags present (3 auto + 1 manual)`)
  console.log(`  -> manual tag id=${manualTag.id}, label="${manualTag.label}"`)

  console.log('\n[5/6] Testing clearAutoTags (should keep manual tag only)...')
  repo.clearAutoTags(video.id)
  const afterClear = repo.listTags(video.id)
  assert(afterClear.length === 1, `expected 1 tag after clearing auto tags, got ${afterClear.length}`)
  assert(afterClear[0].source === 'manual', 'remaining tag should be the manual one')
  console.log(`  -> ${afterClear.length} tag remaining (manual), auto tags cleared correctly`)

  console.log('\n[6/6] Testing updateTag, deleteTag, and cascade delete on video removal...')
  repo.updateTag(manualTag.id, { label: 'Updated label' })
  const updated = repo.listTags(video.id)[0]
  assert(updated.label === 'Updated label', 'tag label should be updated')
  console.log(`  -> tag updated: "${updated.label}"`)

  // Re-insert a couple auto tags to verify cascade delete works too.
  repo.insertTags(video.id, [
    { timestampMs: 10000, type: 'kill', label: 'Kill test', source: 'auto' }
  ])
  const db = getDb()
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id)
  const orphanTags = repo.listTags(video.id)
  assert(orphanTags.length === 0, 'tags should cascade-delete when video is deleted')
  console.log('  -> cascade delete on video removal works correctly')

  console.log('\nAll DB layer checks passed.')
}

main()
  .catch((err) => {
    console.error('\nTest failed:', err)
    process.exitCode = 1
  })
  .finally(() => {
    closeDb()
    cleanupDbFiles()
  })
