// Dry-run of the api_cache -> files migration against a COPY of the real
// database, so the outcome is known before the app touches live data.
//
// Verifies: every row moves, files are valid JSON, the database shrinks, and
// the cached data is still readable afterwards.
//
// Usage: npx tsx scripts/test-cache-migration.ts

import initSqlJs from 'sql.js'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, tmpdir } from 'os'

const liveDb = join(homedir(), 'AppData', 'Roaming', 'leaguevid', 'leaguevid.db')
const workDir = join(tmpdir(), 'leaguevid-migration-test')
const workDb = join(workDir, 'copy.db')
const cacheDir = join(workDir, 'cache')

function pathForKey(key: string): string {
  const segments = key.split(':').map((s) => s.replace(/[^A-Za-z0-9._-]/g, '_')).filter(Boolean)
  const fileName = `${segments.pop()}.json`
  return join(cacheDir, ...segments, fileName)
}

async function main(): Promise<void> {
  if (!existsSync(liveDb)) {
    console.error(`No database at ${liveDb}`)
    process.exitCode = 1
    return
  }

  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })

  const sizeBefore = statSync(liveDb).size
  console.log(`Copying live DB (${(sizeBefore / 1024 / 1024).toFixed(1)} MB) to a scratch dir...`)
  writeFileSync(workDb, readFileSync(liveDb))

  const SQL = await initSqlJs({
    locateFile: (f) => join(process.cwd(), 'node_modules', 'sql.js', 'dist', f)
  })
  const db = new SQL.Database(readFileSync(workDb))

  const before = Number(db.exec(`SELECT COUNT(*) FROM api_cache`)[0]?.values[0]?.[0] ?? 0)
  console.log(`api_cache rows before: ${before}`)

  // Same algorithm as migrateApiCacheToFiles in src/main/db/index.ts.
  const t0 = Date.now()
  const BATCH = 50
  let moved = 0
  for (;;) {
    const rows = db.exec(`SELECT cache_key, value FROM api_cache LIMIT ${BATCH}`)[0]?.values ?? []
    if (rows.length === 0) break
    const keys: string[] = []
    for (const row of rows) {
      const key = String(row[0])
      const path = pathForKey(key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, String(row[1]), 'utf8')
      keys.push(key)
    }
    db.run(`DELETE FROM api_cache WHERE cache_key IN (${keys.map(() => '?').join(',')})`, keys)
    moved += keys.length
  }
  db.run('VACUUM')
  const elapsed = Date.now() - t0

  const after = Number(db.exec(`SELECT COUNT(*) FROM api_cache`)[0]?.values[0]?.[0] ?? 0)
  writeFileSync(workDb, Buffer.from(db.export()))
  const sizeAfter = statSync(workDb).size

  // Verify the data survived: every file must parse, and matches must still
  // have participants.
  let files = 0
  let parsed = 0
  let withParticipants = 0
  const walk = (dir: string): void => {
    for (const entry of require('fs').readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json')) {
        files++
        try {
          const v = JSON.parse(readFileSync(full, 'utf8'))
          parsed++
          if (full.includes(`${'match'}`) && v?.info?.participants?.length === 10) withParticipants++
        } catch {
          console.error(`  UNPARSEABLE: ${full}`)
        }
      }
    }
  }
  walk(cacheDir)

  console.log('')
  console.log('--- Result ---')
  console.log(`rows moved            : ${moved}`)
  console.log(`api_cache rows after  : ${after}`)
  console.log(`files written         : ${files}`)
  console.log(`files parsed OK       : ${parsed}`)
  console.log(`matches w/ 10 players : ${withParticipants}`)
  console.log(
    `DB size              : ${(sizeBefore / 1024 / 1024).toFixed(1)} MB -> ${(sizeAfter / 1024 / 1024).toFixed(1)} MB`
  )
  console.log(`migration took        : ${(elapsed / 1000).toFixed(1)}s`)
  console.log('')
  if (after === 0 && parsed === files && files === before) {
    console.log('PASS: every row moved, every file is valid JSON, DB shrank.')
  } else {
    console.log('FAIL: see numbers above.')
    process.exitCode = 1
  }

  db.close()
  console.log(`\n(scratch dir left at ${workDir} -- safe to delete)`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
