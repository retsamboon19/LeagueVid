import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { setRawCachedValue } from './fileCache'

// sql.js runs SQLite compiled to WebAssembly. This avoids native module
// compilation entirely (no node-gyp, no Electron ABI rebuilds needed),
// which was unreliable on this machine's toolchain. The whole DB lives
// in memory and is serialized to disk on every write. Given this app's
// scale (a personal tag list, at most a few thousand rows), that's fine.

let db: SqlJsDatabase | null = null
let dbFilePath: string | null = null

function defaultDbPath(): string {
  // Lazily required so this module can be used standalone (test scripts)
  // without a running Electron app, by passing an explicit path to initDb().
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron')
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'leaguevid.db')
}

export async function initDb(dbPathOverride?: string): Promise<SqlJsDatabase> {
  if (db) return db

  const SQL = await initSqlJs()
  dbFilePath = dbPathOverride ?? defaultDbPath()

  if (existsSync(dbFilePath)) {
    db = new SQL.Database(readFileSync(dbFilePath))
  } else {
    db = new SQL.Database()
  }

  migrate(db)
  migrateAddColumns(db)
  migrateAddRecordingColumns(db)
  migrateBackfillProgressColumns(db)
  dropRetiredTables(db)
  wipeCacheOnce(db)
  migrateApiCacheToFiles(db)
  // Startup schema work happens in one go, so write it out directly rather
  // than leaving it queued behind the debounce.
  persistPending = true
  writeNow()
  return db
}

/**
 * Moves the Riot response cache out of the database and onto disk as
 * individual files (see fileCache.ts), then reclaims the space.
 *
 * Keeping hundreds of MB of immutable API responses in a sql.js database made
 * every save rewrite the entire file and every startup read it all into
 * memory. The data itself is fine -- it just belongs in files.
 *
 * Migrates in batches and deletes as it goes, so a large cache doesn't need a
 * second full copy in memory. Runs once; afterwards the table is empty and
 * this is a no-op.
 */
function migrateApiCacheToFiles(database: SqlJsDatabase): void {
  const countRow = database.exec(`SELECT COUNT(*) FROM api_cache`)[0]?.values[0]?.[0]
  const total = typeof countRow === 'number' ? countRow : Number(countRow ?? 0)
  if (total === 0) return

  console.log(`[db] moving ${total} cached API response(s) out of the database into files...`)

  const BATCH = 50
  let moved = 0
  let failed = 0

  for (;;) {
    const rows =
      database.exec(`SELECT cache_key, value FROM api_cache LIMIT ${BATCH}`)[0]?.values ?? []
    if (rows.length === 0) break

    const movedKeys: string[] = []
    for (const row of rows) {
      const key = String(row[0])
      const raw = String(row[1])
      try {
        // Stored as a JSON string; write it through as-is rather than
        // parsing and re-serializing, which would be wasted work.
        setRawCachedValue(key, raw)
        movedKeys.push(key)
      } catch {
        failed++
        // Still remove it: leaving it behind would loop forever on this row.
        movedKeys.push(key)
      }
    }

    const placeholders = movedKeys.map(() => '?').join(',')
    database.run(`DELETE FROM api_cache WHERE cache_key IN (${placeholders})`, movedKeys)
    moved += movedKeys.length

    if (moved % 200 === 0 || moved === total) {
      console.log(`[db] migrated ${moved}/${total}`)
    }
  }

  // Without this the file keeps its old size -- SQLite reuses freed pages
  // internally but doesn't shrink the file on its own.
  database.run(`VACUUM`)

  console.log(
    `[db] cache migration complete: ${moved} moved${failed > 0 ? `, ${failed} unreadable` : ''}`
  )
}

// The local match-index subsystem (a "which match ids exist for this
// puuid/time range" table meant to avoid live Riot calls) turned out to
// have unsafe coverage logic that silently returned "no matches" for real
// searches -- see the match-linking rebuild. Dropped entirely rather than
// left dormant, so there's no risk of stale rows or code drifting back to
// reading from it.
function dropRetiredTables(database: SqlJsDatabase): void {
  database.run(`DROP TABLE IF EXISTS match_index`)
}

// One-time wipe of the Riot API response cache and backfill pagination
// state, run once after the match-linking rebuild. The previous caching
// layer (windowed match-id lookups) could get permanently poisoned with an
// incorrect empty result for a given time window, and there's no reliable
// way to distinguish "genuinely cached correctly" from "cached wrong" in
// existing data -- so the clean fix is to clear it all and let it repopulate
// from fresh, correct Riot API calls going forward. Gated behind a settings
// flag so this doesn't repeat on every app start.
function wipeCacheOnce(database: SqlJsDatabase): void {
  const flag = database.exec(
    `SELECT value FROM settings WHERE key = 'cacheWipeV1Done'`
  )[0]?.values[0]?.[0]
  if (flag) return

  database.run(`DELETE FROM api_cache`)
  database.run(`DELETE FROM backfill_progress`)
  database.run(
    `INSERT INTO settings (key, value) VALUES ('cacheWipeV1Done', '1')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
}

// total_matches was added later, to give the download progress indicator a
// denominator. Same retrofit reasoning as migrateAddColumns below.
function migrateBackfillProgressColumns(database: SqlJsDatabase): void {
  const existingColumns = new Set(
    database.exec(`PRAGMA table_info(backfill_progress)`)[0]?.values.map((row) => row[1]) ?? []
  )
  if (!existingColumns.has('total_matches')) {
    database.run(`ALTER TABLE backfill_progress ADD COLUMN total_matches INTEGER`)
  }
}

// Same retrofit reasoning as migrateAddColumns, for the recordings table.
function migrateAddRecordingColumns(database: SqlJsDatabase): void {
  const existing = new Set(
    database.exec(`PRAGMA table_info(recordings)`)[0]?.values.map((row) => row[1]) ?? []
  )
  // Empty means the table doesn't exist yet; migrate() creates it with every
  // column already present.
  if (existing.size === 0) return

  if (!existing.has('first_frame_ms')) {
    database.run(`ALTER TABLE recordings ADD COLUMN first_frame_ms INTEGER`)
  }
}

// Adds columns introduced after the initial CREATE TABLE for videos that were
// created by earlier versions of the app. CREATE TABLE IF NOT EXISTS alone
// won't retrofit new columns onto an existing table.
function migrateAddColumns(database: SqlJsDatabase): void {
  const existingColumns = new Set(
    database.exec(`PRAGMA table_info(videos)`)[0]?.values.map((row) => row[1]) ?? []
  )

  const columnsToAdd: Array<[string, string, string?]> = [
    ['kills', 'INTEGER'],
    ['deaths', 'INTEGER'],
    ['assists', 'INTEGER'],
    ['cs', 'INTEGER'],
    ['gold_diff', 'INTEGER'],
    ['enemy_champion_name', 'TEXT'],
    ['summoner1_id', 'INTEGER'],
    ['summoner2_id', 'INTEGER'],
    ['keystone_id', 'INTEGER'],
    ['game_mode', 'TEXT'],
    ['match_data', 'TEXT'],
    // QOL batch: role/queue filters, a manual favorite marker, and resuming
    // playback where you left off.
    ['team_position', 'TEXT'], // TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY, captured at link time
    ['queue_id', 'INTEGER'], // Riot queue id (420 ranked solo, 450 ARAM, etc.)
    ['is_favorite', 'INTEGER', '0'],
    ['last_position_ms', 'INTEGER'],
    // 'imported' (the user already had the file) or 'recorded' (LeagueVid
    // captured it). Drives the library badge, and scopes retention so that
    // automatic deletion can never reach a file the user brought themselves.
    // Rows predating this column are null, which retention treats as
    // imported -- the safe reading.
    ['source', 'TEXT']
  ]

  for (const [name, type, defaultValue] of columnsToAdd) {
    if (!existingColumns.has(name)) {
      const defaultClause = defaultValue !== undefined ? ` DEFAULT ${defaultValue}` : ''
      database.run(`ALTER TABLE videos ADD COLUMN ${name} ${type}${defaultClause}`)
    }
  }
}

export function getDb(): SqlJsDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() before using getDb().')
  }
  return db
}

// Persisting means serializing the WHOLE database and rewriting the file --
// sql.js has no incremental write path. With the Riot response cache living
// in this DB, the file runs to hundreds of megabytes, so each persist is
// hundreds of MB of work regardless of how small the change was.
//
// Two mechanisms keep that from dominating:
//   - a short debounce, so a burst of writes costs one persist instead of one
//     each (linking a video does three writes in a row);
//   - an explicit suspend/resume pair for bulk operations, so a loop over
//     hundreds of videos persists once at the end rather than per iteration.
//
// The trade-off is crash safety: writes sitting in the debounce window are
// lost if the process dies. Reads are unaffected (they hit the in-memory DB),
// the window is short, and flushPersist() runs on quit.
const PERSIST_DEBOUNCE_MS = 300

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistSuspended = false
let persistPending = false

function writeNow(): void {
  if (!db || !dbFilePath) return
  writeFileSync(dbFilePath, Buffer.from(db.export()))
  persistPending = false
}

/** Queues a persist, coalescing rapid successive writes into one. */
export function persist(): void {
  if (!db || !dbFilePath) return
  persistPending = true
  if (persistSuspended) return

  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeNow()
  }, PERSIST_DEBOUNCE_MS)
}

/** Writes immediately if anything is outstanding. Call before quitting. */
export function flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (persistPending) writeNow()
}

/**
 * Holds off disk writes for a bulk operation. Every write still applies to
 * the in-memory database immediately, so reads during the operation see
 * current data -- only the file write is deferred.
 */
export function suspendPersist(): void {
  persistSuspended = true
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}

/** Resumes normal persistence and writes out whatever accumulated. */
export function resumePersist(): void {
  persistSuspended = false
  flushPersist()
}

export interface Row {
  [column: string]: string | number | null
}

type SqlParam = string | number | null

/** Runs a statement without persisting to disk (for batching multiple writes). */
export function execRaw(sql: string, params: SqlParam[] = []): void {
  getDb().run(sql, params)
}

/** Runs a single write statement and persists immediately. */
export function run(sql: string, params: SqlParam[] = []): void {
  execRaw(sql, params)
  persist()
}

/** Runs multiple writes via `fn`, then persists once at the end. */
export function runBatch(fn: () => void): void {
  fn()
  persist()
}

export function queryAll<T = Row>(sql: string, params: SqlParam[] = []): T[] {
  const stmt = getDb().prepare(sql)
  stmt.bind(params)
  const rows: T[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return rows
}

export function queryOne<T = Row>(sql: string, params: SqlParam[] = []): T | undefined {
  return queryAll<T>(sql, params)[0]
}

export function lastInsertRowId(): number {
  const result = getDb().exec('SELECT last_insert_rowid() AS id')
  const value = result[0]?.values[0]?.[0]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function migrate(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      recorded_at INTEGER,        -- epoch ms, derived from file metadata
      duration_ms INTEGER,
      match_id TEXT,              -- Riot match id, once linked
      sync_offset_ms INTEGER,     -- video_time_ms = game_time_ms + sync_offset_ms
      champion_name TEXT,
      kda TEXT,
      win INTEGER,                -- 0/1
      -- Filterable summary fields, populated when linked to a match:
      kills INTEGER,
      deaths INTEGER,
      assists INTEGER,
      cs INTEGER,                 -- total creep score (minions + jungle)
      gold_diff INTEGER,          -- (my gold) - (enemy laner's gold), can be negative
      enemy_champion_name TEXT,   -- champion faced in the same lane/role
      summoner1_id INTEGER,
      summoner2_id INTEGER,
      keystone_id INTEGER,        -- primary rune keystone perk id
      game_mode TEXT,             -- e.g. "CLASSIC" (Summoner's Rift), "ARAM"
      match_data TEXT,            -- JSON blob: full roster (both teams), items, for tile rendering
      team_position TEXT,         -- TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY, for the role filter
      queue_id INTEGER,           -- Riot queue id (420 ranked solo, 450 ARAM, etc.)
      is_favorite INTEGER NOT NULL DEFAULT 0,
      last_position_ms INTEGER,   -- playback position to resume from, next time it's opened
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      timestamp_ms INTEGER NOT NULL,  -- position in the video
      type TEXT NOT NULL,             -- kill, death, assist, multikill, turret, dragon, baron, herald, other_objective, towerdive, manual, outplay, etc.
      label TEXT NOT NULL,
      detail TEXT,
      source TEXT NOT NULL DEFAULT 'manual', -- 'auto' | 'manual'
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_tags_video_id ON tags(video_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS linked_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT NOT NULL UNIQUE,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      last_scanned_at INTEGER,
      last_scan_imported INTEGER DEFAULT 0,
      last_scan_skipped INTEGER DEFAULT 0
    );

    -- Offline cache of Riot API responses, keyed by a logical cache key
    -- (e.g. "match:americas:NA1_123"). Match and timeline data is immutable
    -- once a game has ended, so these are cached indefinitely -- repeat
    -- lookups (re-linking, re-scanning, viewing tiles) never need to hit
    -- the network again once fetched.
    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      cached_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    -- Tracks how far the background backfill service has paged through each
    -- linked account's match history, so it resumes where it left off
    -- across app restarts instead of re-walking from the start every time.
    CREATE TABLE IF NOT EXISTS backfill_progress (
      puuid TEXT PRIMARY KEY,
      next_start INTEGER NOT NULL DEFAULT 0,
      reached_end INTEGER NOT NULL DEFAULT 0, -- 1 once the oldest match is reached
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    -- Caches a video file's probed duration, keyed by path + size. Probing
    -- (either the fast MP4/MOV header read or the full <video>-element
    -- fallback) never needs to repeat for a file that hasn't changed size
    -- since it was last scanned -- this is what makes re-scanning a folder
    -- of already-imported recordings fast on subsequent runs.
    CREATE TABLE IF NOT EXISTS video_duration_cache (
      file_path TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    -- One row per recording LeagueVid made itself, from the moment capture
    -- starts. Written before the file is finished on purpose: if the app is
    -- killed mid-game, this row is what the next launch uses to find the
    -- orphaned Matroska file, remux it and import it rather than leaving the
    -- footage stranded (see recorder/remux.ts).
    --
    -- game_start_ms is the measured wall-clock time at which the in-game
    -- clock read zero, derived from the Live Client Data endpoint. That is
    -- what makes sync_offset_ms on the resulting video a measurement instead
    -- of a guess from the file name.
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
      temp_path TEXT NOT NULL,          -- the .mkv being written
      final_path TEXT,                  -- the .mp4 after remux
      state TEXT NOT NULL,              -- recording|stopping|remuxing|complete|failed|discarded
      started_at INTEGER NOT NULL,      -- when the capture child was spawned
      -- When the first frame actually landed. This, not started_at, is what the
      -- sync offset is measured against: ffmpeg spends a few hundred
      -- milliseconds opening the display and the encoder, and anchoring
      -- bookmarks to the spawn instead of the first frame would shift every one
      -- of them by that much.
      first_frame_ms INTEGER,
      ended_at INTEGER,
      game_start_ms INTEGER,
      match_id_hint TEXT,               -- platform_gameId, from the League client
      platform TEXT,
      puuid TEXT,
      queue_id INTEGER,
      champion_name TEXT,
      live_events TEXT,                 -- JSON: in-game event feed, bookmark fallback
      link_state TEXT,                  -- pending|linked|failed|skipped
      link_attempts INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL,      -- the configuration this session actually ran with
      ffmpeg_error TEXT,
      dropped_frames INTEGER,
      avg_fps REAL,
      size_bytes INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `)
}

export function closeDb(): void {
  if (db) {
    persistSuspended = false
    flushPersist()
    db.close()
  }
  db = null
  dbFilePath = null
}
