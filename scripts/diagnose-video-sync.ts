// Diagnoses why a linked video's bookmarks land at the wrong time.
//
// Usage:
//   npx tsx scripts/diagnose-video-sync.ts "part of the file name"
//
// Reads the database directly and read-only. Never calls the Riot API and
// never goes through src/main/db/index.ts (whose migrations clear api_cache).

import initSqlJs, { type Database } from 'sql.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function defaultDbPath(): string {
  return join(homedir(), 'AppData', 'Roaming', 'leaguevid', 'leaguevid.db')
}

function rows(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql)
  stmt.bind(params as never)
  const out: Record<string, unknown>[] = []
  while (stmt.step()) out.push(stmt.getAsObject() as Record<string, unknown>)
  stmt.free()
  return out
}

function fmtClock(ms: number): string {
  const sign = ms < 0 ? '-' : ''
  const total = Math.abs(Math.floor(ms / 1000))
  return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

async function main(): Promise<void> {
  const needle = process.argv[2] ?? '05-30-2026_23-41-41'
  const dbPath = process.argv[3] ?? defaultDbPath()

  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`)
    process.exitCode = 1
    return
  }

  const SQL = await initSqlJs({
    locateFile: (f) => join(process.cwd(), 'node_modules', 'sql.js', 'dist', f)
  })
  const db = new SQL.Database(readFileSync(dbPath))

  const videos = rows(db, `SELECT * FROM videos WHERE file_name LIKE ?`, [`%${needle}%`])
  if (videos.length === 0) {
    console.log(`No video matching "${needle}".`)
    db.close()
    return
  }

  for (const v of videos) {
    const recordedAt = Number(v.recorded_at)
    const durationMs = Number(v.duration_ms)
    const syncOffset = Number(v.sync_offset_ms ?? 0)

    console.log('='.repeat(70))
    console.log(`file_name      : ${v.file_name}`)
    console.log(`match_id       : ${v.match_id}`)
    console.log(`champion       : ${v.champion_name}  kda=${v.kda}`)
    console.log(
      `recorded_at    : ${recordedAt} (${new Date(recordedAt).toLocaleString()})  <- from file name`
    )
    console.log(`duration_ms    : ${durationMs} (${fmtClock(durationMs)})`)
    console.log(`sync_offset_ms : ${syncOffset} (${fmtClock(syncOffset)})`)

    if (!v.match_id) {
      console.log('Not linked, nothing more to check.')
      continue
    }

    // Find the cached match body regardless of region prefix.
    const cached = rows(db, `SELECT cache_key, value FROM api_cache WHERE cache_key LIKE ?`, [
      `match:%:${v.match_id}`
    ])
    if (cached.length === 0) {
      console.log('Match body is NOT in the local cache.')
      continue
    }

    const match = JSON.parse(String(cached[0].value))
    const gameStart = match.info.gameStartTimestamp
    const gameEnd = match.info.gameEndTimestamp
    const gameDuration = match.info.gameDuration

    console.log('-'.repeat(70))
    console.log(`gameStart      : ${gameStart} (${new Date(gameStart).toLocaleString()})`)
    console.log(`gameEnd        : ${gameEnd} (${new Date(gameEnd).toLocaleString()})`)
    console.log(`gameDuration   : ${gameDuration}s (${fmtClock(gameDuration * 1000)})`)

    console.log('-'.repeat(70))
    console.log('Interpretation:')
    const startDelta = recordedAt - gameStart
    const endDelta = recordedAt - gameEnd
    console.log(
      `  recorded_at is ${fmtClock(startDelta)} relative to game START (positive = after start)`
    )
    console.log(
      `  recorded_at is ${fmtClock(endDelta)} relative to game END   (positive = after end)`
    )
    if (Math.abs(endDelta) < Math.abs(startDelta)) {
      console.log(
        '  => The file name timestamp is much closer to the game END than the START.'
      )
      console.log(
        '     That means the recorder stamps the file when the recording FINISHES,'
      )
      console.log('     not when it begins -- so treating it as a start time is wrong.')
    } else {
      console.log('  => The file name timestamp lines up with the game start, as assumed.')
    }

    // What the current offset does to tag positions.
    const tags = rows(
      db,
      `SELECT type, label, timestamp_ms FROM tags WHERE video_id = ? ORDER BY timestamp_ms ASC`,
      [v.id]
    )
    const nonPositive = tags.filter((t) => Number(t.timestamp_ms) <= 0).length
    console.log('-'.repeat(70))
    console.log(`tags stored     : ${tags.length}`)
    console.log(`tags at <= 0    : ${nonPositive}  <- these all display as 0:00`)
    console.log('first 5 stored tag timestamps:')
    for (const t of tags.slice(0, 5)) {
      console.log(`  ${String(t.timestamp_ms).padStart(9)}  ${fmtClock(Number(t.timestamp_ms))}  ${t.label}`)
    }

    // What the offset SHOULD be if the file name marks the end of recording.
    const impliedStart = recordedAt - durationMs
    const betterOffset = gameStart - impliedStart
    console.log('-'.repeat(70))
    console.log('If the file name marks the END of the recording:')
    console.log(
      `  implied recording start = ${new Date(impliedStart).toLocaleString()}`
    )
    console.log(`  offset would be ${betterOffset} (${fmtClock(betterOffset)})`)
    console.log(
      `  first tag would move to ${fmtClock(
        Number(tags[0]?.timestamp_ms ?? 0) - Number(v.sync_offset_ms ?? 0) + betterOffset
      )}`
    )
  }

  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
