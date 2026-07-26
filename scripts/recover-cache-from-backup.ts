// Rebuilds the on-disk Riot response cache from a backup copy of the old
// database, for recovering the entries Chromium evicted when the cache was
// briefly written into its own Cache directory.
//
// Reads a backup .db (which still has the api_cache table populated) and
// writes every entry into the current cache directory. Never modifies the
// backup, and never calls the Riot API.
//
// Usage:
//   npx tsx scripts/recover-cache-from-backup.ts "path\to\backup\leaguevid.db"

import initSqlJs from 'sql.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

// Must match CACHE_DIR_NAME / pathForKey in src/main/db/fileCache.ts.
const CACHE_DIR = join(homedir(), 'AppData', 'Roaming', 'leaguevid', 'riot-api-cache')

function pathForKey(key: string): string {
  const segments = key
    .split(':')
    .map((s) => s.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter(Boolean)
  const fileName = `${segments.pop()}.json`
  return join(CACHE_DIR, ...segments, fileName)
}

async function main(): Promise<void> {
  const backupDb = process.argv[2]
  if (!backupDb) {
    console.error('Pass the backup database path:')
    console.error('  npx tsx scripts/recover-cache-from-backup.ts "path\\to\\leaguevid.db"')
    process.exitCode = 1
    return
  }
  if (!existsSync(backupDb)) {
    console.error(`No file at ${backupDb}`)
    process.exitCode = 1
    return
  }

  const SQL = await initSqlJs({
    locateFile: (f) => join(process.cwd(), 'node_modules', 'sql.js', 'dist', f)
  })
  const db = new SQL.Database(readFileSync(backupDb))

  const total = Number(db.exec(`SELECT COUNT(*) FROM api_cache`)[0]?.values[0]?.[0] ?? 0)
  console.log(`Backup: ${backupDb}`)
  console.log(`Cached entries in backup: ${total}`)
  console.log(`Restoring into: ${CACHE_DIR}\n`)

  if (total === 0) {
    console.log('Nothing to restore -- this backup has no cached API responses.')
    db.close()
    return
  }

  let written = 0
  let skippedExisting = 0
  const PAGE = 100

  for (let offset = 0; offset < total; offset += PAGE) {
    const rows =
      db.exec(`SELECT cache_key, value FROM api_cache LIMIT ${PAGE} OFFSET ${offset}`)[0]?.values ??
      []
    for (const row of rows) {
      const key = String(row[0])
      const path = pathForKey(key)
      // Don't overwrite anything already present -- entries fetched since the
      // backup are at least as good as the backup's copy.
      if (existsSync(path)) {
        skippedExisting++
        continue
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, String(row[1]), 'utf8')
      written++
    }
    if ((offset / PAGE) % 5 === 0) {
      console.log(`  ${Math.min(offset + PAGE, total)}/${total}`)
    }
  }

  console.log('')
  console.log(`Restored          : ${written}`)
  console.log(`Already present   : ${skippedExisting}`)
  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
