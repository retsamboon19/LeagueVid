import { queryAll, queryOne, run, runBatch, execRaw, lastInsertRowId, persist } from './index'
import * as fileCache from './fileCache'
import type {
  AppSettings,
  EncoderCapabilities,
  MatchRosterData,
  PlayerPreferences,
  RecordingLinkState,
  RecordingRow,
  RecordingSettings,
  RecordingState,
  TagRow,
  VideoRow,
  VideoSource
} from '../../shared/types'
import { DEFAULT_PLAYER_PREFERENCES, parseRecordingSettings } from '../../shared/types'
import {
  clampBitrateKbps,
  clampMinKeepMinutes,
  minutesToMs,
  msToMinutes
} from '../../shared/recordingBounds'

export type { AppSettings, RecordingRow, RecordingSettings, TagRow, VideoRow }

const SETTINGS_KEY = 'riotAccount'
const PREFS_KEY = 'playerPreferences'
const API_KEY_SETTING = 'riotApiKeyOverride'

// User-supplied Riot API key, stored locally so it can be changed from the
// Settings screen instead of only via a .env file. Takes priority over
// RIOT_API_KEY from .env when present (see clientSingleton.ts) -- this is
// what lets someone swap in their own personal key without editing files or
// rebuilding the app.
export function getRiotApiKeyOverride(): string | null {
  const row = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [
    API_KEY_SETTING
  ])
  const trimmed = row?.value?.trim()
  return trimmed ? trimmed : null
}

export function setRiotApiKeyOverride(apiKey: string | null): void {
  const trimmed = apiKey?.trim()
  if (!trimmed) {
    run(`DELETE FROM settings WHERE key = ?`, [API_KEY_SETTING])
    return
  }
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [API_KEY_SETTING, trimmed]
  )
}

const CLIPS_DIR_SETTING = 'clipsDirectory'

// Where exported clips are written. Null means "use the default", which is a
// folder inside the app's own directory (see clipService.defaultClipsDir) --
// storing null rather than the resolved default keeps the setting meaningful
// if the app is later moved to a different drive.
export function getClipsDirOverride(): string | null {
  const row = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [
    CLIPS_DIR_SETTING
  ])
  const trimmed = row?.value?.trim()
  return trimmed ? trimmed : null
}

export function setClipsDirOverride(dir: string | null): void {
  const trimmed = dir?.trim()
  if (!trimmed) {
    run(`DELETE FROM settings WHERE key = ?`, [CLIPS_DIR_SETTING])
    return
  }
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CLIPS_DIR_SETTING, trimmed]
  )
}

const RATE_LIMIT_SETTING = 'riotRateLimitOverride'

export interface RateLimitConfig {
  // Requests allowed per 1-second window and per 2-minute window. These
  // mirror the two windows Riot documents for the standard tier (dev and
  // personal keys share the same default: 20/1s, 100/2min). If Riot has
  // approved a higher limit for a specific key -- e.g. after applying for
  // increased limits -- enter that key's actual approved numbers here
  // instead (visible on the key's page in the Riot Developer Portal).
  perSecond: number
  per2Minutes: number
}

export function getRiotRateLimitOverride(): RateLimitConfig | null {
  const row = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [
    RATE_LIMIT_SETTING
  ])
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value)
    if (typeof parsed.perSecond === 'number' && typeof parsed.per2Minutes === 'number') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function setRiotRateLimitOverride(config: RateLimitConfig | null): void {
  if (!config) {
    run(`DELETE FROM settings WHERE key = ?`, [RATE_LIMIT_SETTING])
    return
  }
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [RATE_LIMIT_SETTING, JSON.stringify(config)]
  )
}

const RECORDING_SETTINGS_KEY = 'recordingSettings'

// Recorder configuration. Kept out of AppSettings on purpose: that object is
// the linked Riot account list and is replaced wholesale whenever an account
// is added or removed, which would take the recorder's configuration with it.
export function getRecordingSettings(): RecordingSettings {
  const row = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [
    RECORDING_SETTINGS_KEY
  ])
  return parseRecordingSettings(row?.value)
}

export function saveRecordingSettings(settings: RecordingSettings): void {
  // Clamped here as well as in the field the user types into. The renderer's
  // validation is for feedback; this is the guarantee, and it matters because
  // these two values reach ffmpeg and the discard rule directly -- a bitrate of
  // 0 or a minimum length of nine hours would be accepted silently otherwise.
  const safe: RecordingSettings = {
    ...settings,
    bitrateKbps: clampBitrateKbps(settings.bitrateKbps).value,
    minKeepDurationMs: minutesToMs(clampMinKeepMinutes(msToMinutes(settings.minKeepDurationMs)).value)
  }

  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [RECORDING_SETTINGS_KEY, JSON.stringify(safe)]
  )
}

const ENCODER_CAPABILITIES_KEY = 'encoderCapabilities'

// Result of probing this machine's video encoders. Cached because probing
// spawns a child process per candidate and costs seconds, while the answer
// only changes when the GPU or its driver does -- so it is read from here on
// every launch and only recomputed when the user asks.
export function getEncoderCapabilitiesCache(): EncoderCapabilities | null {
  const row = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [
    ENCODER_CAPABILITIES_KEY
  ])
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value)
    // A row from an older shape is treated as absent rather than patched up:
    // re-probing is cheap enough, and a half-populated capability set would
    // silently pick the wrong encoder.
    if (!parsed || !Array.isArray(parsed.outcomes)) return null
    return parsed as EncoderCapabilities
  } catch {
    return null
  }
}

export function saveEncoderCapabilitiesCache(capabilities: EncoderCapabilities): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [ENCODER_CAPABILITIES_KEY, JSON.stringify(capabilities)]
  )
}

export function getPlayerPreferences(): PlayerPreferences {
  const row = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [PREFS_KEY])
  if (!row) return DEFAULT_PLAYER_PREFERENCES
  try {
    return { ...DEFAULT_PLAYER_PREFERENCES, ...JSON.parse(row.value) }
  } catch {
    return DEFAULT_PLAYER_PREFERENCES
  }
}

export function savePlayerPreferences(prefs: PlayerPreferences): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [PREFS_KEY, JSON.stringify(prefs)]
  )
}

export function getSettings(): AppSettings | null {
  const row = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [
    SETTINGS_KEY
  ])
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value)
    // Migrate from the old single-account shape ({gameName, tagLine,
    // platform, puuid}) to the current multi-account shape ({accounts: []}).
    if (parsed && !Array.isArray(parsed.accounts) && parsed.puuid) {
      const migrated: AppSettings = {
        accounts: [
          {
            gameName: parsed.gameName,
            tagLine: parsed.tagLine,
            platform: parsed.platform,
            puuid: parsed.puuid
          }
        ]
      }
      saveSettings(migrated)
      return migrated
    }
    if (!Array.isArray(parsed?.accounts)) return { accounts: [] }
    return parsed as AppSettings
  } catch {
    return null
  }
}

export function saveSettings(settings: AppSettings): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_KEY, JSON.stringify(settings)]
  )
}

export function insertVideo(input: {
  filePath: string
  fileName: string
  recordedAt?: number | null
  durationMs?: number | null
  /**
   * 'recorded' when LeagueVid captured the file itself, 'imported' otherwise.
   * Defaults to 'imported' because every existing caller is an import path,
   * and because retention must never be able to delete a file the user
   * brought in themselves -- so the safe value is the default one.
   */
  source?: VideoSource
}): VideoRow {
  run(
    `INSERT INTO videos (file_path, file_name, recorded_at, duration_ms, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET file_name = excluded.file_name`,
    [
      input.filePath,
      input.fileName,
      input.recordedAt ?? null,
      input.durationMs ?? null,
      input.source ?? 'imported'
    ]
  )
  const row = queryOne<VideoRow>(`SELECT * FROM videos WHERE file_path = ?`, [input.filePath])
  return row as VideoRow
}

export function listVideos(): VideoRow[] {
  return queryAll<VideoRow>(`SELECT * FROM videos ORDER BY created_at DESC`)
}

export function getVideo(id: number): VideoRow | undefined {
  return queryOne<VideoRow>(`SELECT * FROM videos WHERE id = ?`, [id])
}

export function linkVideoToMatch(input: {
  videoId: number
  matchId: string
  syncOffsetMs: number
  championName: string
  kda: string
  win: boolean
  kills: number
  deaths: number
  assists: number
  cs: number
  goldDiff: number | null
  enemyChampionName: string | null
  summoner1Id: number
  summoner2Id: number
  keystoneId: number | null
  gameMode: string
  matchData: MatchRosterData
  teamPosition?: string | null
  queueId?: number | null
}): void {
  run(
    `UPDATE videos
     SET match_id = ?, sync_offset_ms = ?,
         champion_name = ?, kda = ?, win = ?,
         kills = ?, deaths = ?, assists = ?, cs = ?, gold_diff = ?,
         enemy_champion_name = ?, summoner1_id = ?, summoner2_id = ?, keystone_id = ?,
         game_mode = ?, match_data = ?, team_position = ?, queue_id = ?
     WHERE id = ?`,
    [
      input.matchId,
      input.syncOffsetMs,
      input.championName,
      input.kda,
      input.win ? 1 : 0,
      input.kills,
      input.deaths,
      input.assists,
      input.cs,
      input.goldDiff,
      input.enemyChampionName,
      input.summoner1Id,
      input.summoner2Id,
      input.keystoneId,
      input.gameMode,
      JSON.stringify(input.matchData),
      input.teamPosition ?? null,
      input.queueId ?? null,
      input.videoId
    ]
  )
}

export function updateSyncOffset(videoId: number, syncOffsetMs: number): void {
  run(`UPDATE videos SET sync_offset_ms = ? WHERE id = ?`, [syncOffsetMs, videoId])
}

export function setFavorite(videoId: number, isFavorite: boolean): void {
  run(`UPDATE videos SET is_favorite = ? WHERE id = ?`, [isFavorite ? 1 : 0, videoId])
}

// Saved periodically (not on every timeupdate) and on leaving the player, so
// re-opening a video resumes near where playback stopped instead of always
// restarting from 0:00.
export function updateLastPosition(videoId: number, positionMs: number): void {
  run(`UPDATE videos SET last_position_ms = ? WHERE id = ?`, [Math.round(positionMs), videoId])
}

// Re-syncs all bookmarks for a video given how many seconds into the match
// the recording actually started. E.g. if the recording began 18 seconds
// after the game clock started, pass recordingStartSeconds = 18, and every
// bookmark's video-relative timestamp is shifted so game-time 18s now maps
// to video-time 0s.
//
// Tags are stored with their offset already baked into timestamp_ms (there's
// no separate raw "game time" column), so re-syncing works by computing the
// delta between the previously-applied offset (video.sync_offset_ms) and the
// newly requested one, then shifting every tag by that delta in one pass.
export function resyncTags(videoId: number, recordingStartSeconds: number): void {
  const video = getVideo(videoId)
  if (!video) return

  const newSyncOffsetMs = -(recordingStartSeconds * 1000)
  const oldSyncOffsetMs = video.sync_offset_ms ?? 0
  const deltaMs = newSyncOffsetMs - oldSyncOffsetMs

  runBatch(() => {
    execRaw(`UPDATE tags SET timestamp_ms = timestamp_ms + ? WHERE video_id = ?`, [
      deltaMs,
      videoId
    ])
    execRaw(`UPDATE videos SET sync_offset_ms = ? WHERE id = ?`, [newSyncOffsetMs, videoId])
  })
}

export function insertTags(
  videoId: number,
  tags: Array<{
    timestampMs: number
    type: string
    label: string
    detail?: string | null
    source: 'auto' | 'manual'
  }>
): void {
  runBatch(() => {
    for (const t of tags) {
      execRaw(
        `INSERT INTO tags (video_id, timestamp_ms, type, label, detail, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [videoId, t.timestampMs, t.type, t.label, t.detail ?? null, t.source]
      )
    }
  })
}

export function clearAutoTags(videoId: number): void {
  run(`DELETE FROM tags WHERE video_id = ? AND source = 'auto'`, [videoId])
}

// Includes the legacy 'multikill' type (written before the exact tiers
// existed) as an honorary double kill, so old bookmarks aren't invisible to
// the filter -- it's the closest known tier for those rows.
const MULTIKILL_TAG_TYPES = ['doublekill', 'triplekill', 'quadrakill', 'pentakill', 'multikill']

// Every multikill tag across every video, for the library's multikill
// filters. Returned as a flat list rather than pre-aggregated per video: a
// video can have several multikills of different tiers in one game, and the
// filter needs to know about all of them (e.g. a "solo triple kill" filter
// must check the triple specifically, not just whether ANY multikill that
// game happened to be solo).
export function listMultikillTags(): Array<{ videoId: number; type: string; solo: boolean }> {
  const placeholders = MULTIKILL_TAG_TYPES.map(() => '?').join(',')
  const rows = queryAll<{ video_id: number; type: string; detail: string | null }>(
    `SELECT video_id, type, detail FROM tags WHERE type IN (${placeholders})`,
    MULTIKILL_TAG_TYPES
  )
  return rows.map((r) => ({
    videoId: r.video_id,
    type: r.type === 'multikill' ? 'doublekill' : r.type,
    solo: r.detail === 'solo'
  }))
}

// Flags videos whose auto-generated bookmarks are all clamped to the very
// start of the video (timestamp_ms <= 0). That pattern is the signature of
// a video linked to the wrong match: every event's video-relative position
// comes out negative (the match's events all predate where the recording
// actually starts), and the player clamps negative positions to 0 for
// display/seeking. A single 0:00 tag can be legitimate (e.g. a genuine
// first-second event), but ALL of them landing there is not.
export function findVideosWithSuspiciousBookmarks(): number[] {
  const rows = queryAll<{ video_id: number }>(
    `SELECT video_id FROM tags
     WHERE source = 'auto'
     GROUP BY video_id
     HAVING MAX(timestamp_ms) <= 0 AND COUNT(*) >= 2`
  )
  return rows.map((r) => r.video_id)
}

export function listTags(videoId: number): TagRow[] {
  return queryAll<TagRow>(`SELECT * FROM tags WHERE video_id = ? ORDER BY timestamp_ms ASC`, [
    videoId
  ])
}

export function updateTag(
  tagId: number,
  input: { timestampMs?: number; label?: string; detail?: string | null }
): void {
  const existing = queryOne<TagRow>(`SELECT * FROM tags WHERE id = ?`, [tagId])
  if (!existing) return

  run(`UPDATE tags SET timestamp_ms = ?, label = ?, detail = ? WHERE id = ?`, [
    input.timestampMs ?? existing.timestamp_ms,
    input.label ?? existing.label,
    input.detail !== undefined ? input.detail : existing.detail,
    tagId
  ])
}

export function deleteTag(tagId: number): void {
  run(`DELETE FROM tags WHERE id = ?`, [tagId])
}

export function insertManualTag(input: {
  videoId: number
  timestampMs: number
  type: string
  label: string
  detail?: string
}): TagRow {
  execRaw(
    `INSERT INTO tags (video_id, timestamp_ms, type, label, detail, source)
     VALUES (?, ?, ?, ?, ?, 'manual')`,
    [input.videoId, input.timestampMs, input.type, input.label, input.detail ?? null]
  )
  const id = lastInsertRowId()
  persist()
  return queryOne<TagRow>(`SELECT * FROM tags WHERE id = ?`, [id]) as TagRow
}

// --- Offline API response cache ---
// Match/timeline data from Riot is immutable once a game ends, so cached
// entries never expire -- this is a permanent local copy, not a TTL cache.

// Riot responses live in files on disk, not in this database -- see
// fileCache.ts for why. These wrappers keep the old call sites unchanged.

export function getCachedApiValue<T>(cacheKey: string): T | null {
  return fileCache.getCachedValue<T>(cacheKey)
}

export function setCachedApiValue<T>(cacheKey: string, value: T): void {
  fileCache.setCachedValue(cacheKey, value)
}

export function hasCachedApiValue(cacheKey: string): boolean {
  return fileCache.hasCachedValue(cacheKey)
}

// --- Background backfill progress ---
// Tracks pagination position per account so the backfill service resumes
// where it left off across app restarts instead of re-walking history.

export interface BackfillProgressRow {
  puuid: string
  next_start: number
  reached_end: number
  // How many match ids Riot reports for this account (counted via the cheap
  // id-only endpoint -- see RiotClient.countMatchIds). Null until counted.
  // Used as the denominator for the download progress indicator.
  total_matches: number | null
  updated_at: number
}

/** Clears the cached match-count total so it gets recounted from Riot. */
export function resetBackfillTotal(puuid: string): void {
  run(`UPDATE backfill_progress SET total_matches = NULL WHERE puuid = ?`, [puuid])
}

export function setBackfillTotal(puuid: string, totalMatches: number): void {
  run(
    `INSERT INTO backfill_progress (puuid, next_start, reached_end, total_matches, updated_at)
     VALUES (?, 0, 0, ?, ?)
     ON CONFLICT(puuid) DO UPDATE SET
       total_matches = excluded.total_matches,
       updated_at = excluded.updated_at`,
    [puuid, totalMatches, Date.now()]
  )
}

export function getBackfillProgress(puuid: string): BackfillProgressRow | undefined {
  return queryOne<BackfillProgressRow>(`SELECT * FROM backfill_progress WHERE puuid = ?`, [puuid])
}

export function setBackfillProgress(
  puuid: string,
  input: { nextStart: number; reachedEnd: boolean }
): void {
  run(
    `INSERT INTO backfill_progress (puuid, next_start, reached_end, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(puuid) DO UPDATE SET
       next_start = excluded.next_start,
       reached_end = excluded.reached_end,
       updated_at = excluded.updated_at`,
    [puuid, input.nextStart, input.reachedEnd ? 1 : 0, Date.now()]
  )
}

export function resetBackfillProgress(puuid: string): void {
  run(`DELETE FROM backfill_progress WHERE puuid = ?`, [puuid])
}

// Progress of the background match-history download, for the indicator on
// the library page.
//
// matchesDownloaded/matchesTotal come from backfill_progress: next_start is
// how many match ids the service has already walked through (and therefore
// downloaded), and total_matches is how many Riot says exist for that
// account -- counted cheaply via the id-only endpoint rather than by
// fetching anything. Summed across accounts to give one overall bar.
//
// matchesTotal is null until at least one account has been counted, since a
// progress bar with an unknown denominator would be misleading. Riot's id
// list is capped (~1000 matches / ~2 years), so this tracks "history Riot
// will give us", not lifetime games played.
export interface BackfillStatusSummary {
  totalAccounts: number
  accountsFullyBackfilled: number
  matchesDownloaded: number
  matchesTotal: number | null
  /** Distinct match bodies held locally, across all accounts. */
  matchesCached: number
}

export function getBackfillStatusSummary(puuids: string[]): BackfillStatusSummary {
  if (puuids.length === 0) {
    return {
      totalAccounts: 0,
      accountsFullyBackfilled: 0,
      matchesDownloaded: 0,
      matchesTotal: null,
      matchesCached: 0
    }
  }

  const placeholders = puuids.map(() => '?').join(',')
  const progressRows = queryAll<{
    reached_end: number
    next_start: number
    total_matches: number | null
  }>(
    `SELECT reached_end, next_start, total_matches FROM backfill_progress
     WHERE puuid IN (${placeholders})`,
    puuids
  )

  const accountsFullyBackfilled = progressRows.filter((r) => r.reached_end).length
  const matchesDownloaded = progressRows.reduce((sum, r) => sum + (r.next_start ?? 0), 0)

  const counted = progressRows.filter((r) => typeof r.total_matches === 'number')
  const matchesTotal =
    counted.length > 0 ? counted.reduce((sum, r) => sum + (r.total_matches as number), 0) : null

  return {
    totalAccounts: puuids.length,
    accountsFullyBackfilled,
    matchesDownloaded,
    matchesTotal,
    matchesCached: fileCache.cachedMatchCount()
  }
}

/**
 * Every cached match, parsed, for the manual match picker. Manual linking
 * filters over whatever history has already been downloaded locally, so it
 * needs the full set rather than a time-windowed slice.
 *
 * Returns ALL cached matches regardless of account -- the caller matches them
 * against linked puuids, since a cache entry records the match, not who of
 * yours played it.
 */
export function listCachedMatchEntries<T = unknown>(): Array<{ matchId: string; value: T }> {
  return fileCache.readCachedEntries<T>('match').map((e) => ({ matchId: e.id, value: e.value }))
}

export function getApiCacheStats(): { count: number; oldestAt: number | null } {
  return fileCache.cacheStats()
}

// Clears all downloaded Riot match/timeline data and resets how far the
// background backfill has paged, so history re-downloads from scratch.
// Videos, bookmarks, and existing match links are untouched -- this only
// discards the local copy of Riot's data, which is safe to re-fetch.
export function clearMatchCache(): void {
  fileCache.clearFileCache()
  run(`DELETE FROM backfill_progress`, [])
}

// --- Video duration cache ---
// Keyed by file path + size, so a file that's been replaced/re-recorded at
// the same path (different size) is correctly re-probed instead of trusting
// a stale cached duration.

export function getCachedVideoDuration(filePath: string, sizeBytes: number): number | null {
  const row = queryOne<{ duration_ms: number }>(
    `SELECT duration_ms FROM video_duration_cache WHERE file_path = ? AND size_bytes = ?`,
    [filePath, sizeBytes]
  )
  return row?.duration_ms ?? null
}

export function setCachedVideoDuration(filePath: string, sizeBytes: number, durationMs: number): void {
  run(
    `INSERT INTO video_duration_cache (file_path, size_bytes, duration_ms, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       size_bytes = excluded.size_bytes,
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at`,
    [filePath, sizeBytes, durationMs, Date.now()]
  )
}

export interface LinkedFolderRow {
  id: number
  folder_path: string
  added_at: number
  last_scanned_at: number | null
  last_scan_imported: number
  last_scan_skipped: number
}

export function addLinkedFolder(folderPath: string): LinkedFolderRow {
  run(
    `INSERT INTO linked_folders (folder_path) VALUES (?)
     ON CONFLICT(folder_path) DO NOTHING`,
    [folderPath]
  )
  return queryOne<LinkedFolderRow>(`SELECT * FROM linked_folders WHERE folder_path = ?`, [
    folderPath
  ]) as LinkedFolderRow
}

export function listLinkedFolders(): LinkedFolderRow[] {
  return queryAll<LinkedFolderRow>(`SELECT * FROM linked_folders ORDER BY added_at DESC`)
}

export function removeLinkedFolder(id: number): void {
  run(`DELETE FROM linked_folders WHERE id = ?`, [id])
}

export function recordFolderScan(
  id: number,
  result: { imported: number; skipped: number }
): void {
  run(
    `UPDATE linked_folders
     SET last_scanned_at = ?, last_scan_imported = ?, last_scan_skipped = ?
     WHERE id = ?`,
    [Date.now(), result.imported, result.skipped, id]
  )
}

// Manual cascade delete: sql.js's bundled SQLite may not enforce
// ON DELETE CASCADE unless "PRAGMA foreign_keys = ON" is set per-connection,
// which isn't reliably persisted across serialize/deserialize cycles.
// We enforce it explicitly here instead of relying on the pragma.
export function deleteVideo(videoId: number): void {
  runBatch(() => {
    execRaw(`DELETE FROM tags WHERE video_id = ?`, [videoId])
    execRaw(`DELETE FROM videos WHERE id = ?`, [videoId])
  })
}

// Removes every recording from the library (tags + video rows). This only
// clears LeagueVid's own records -- it never touches the actual video files
// on disk, so nothing is lost if this is used by mistake beyond having to
// re-import/re-link.
export function deleteAllVideos(): void {
  runBatch(() => {
    execRaw(`DELETE FROM tags`, [])
    execRaw(`DELETE FROM videos`, [])
  })
}

// Removes a chosen subset of recordings in one batch (one persist at the
// end, not one per video) -- the middle ground between deleteVideo (one) and
// deleteAllVideos (everything), for multi-select removal from the library.
export function deleteVideos(videoIds: number[]): void {
  if (videoIds.length === 0) return
  const placeholders = videoIds.map(() => '?').join(',')
  runBatch(() => {
    execRaw(`DELETE FROM tags WHERE video_id IN (${placeholders})`, videoIds)
    execRaw(`DELETE FROM videos WHERE id IN (${placeholders})`, videoIds)
  })
}

// --- Recording sessions ---
//
// The row is inserted when capture starts rather than when it finishes. That
// ordering is the whole point: if the app is killed mid-game, the next launch
// finds a row still marked 'recording', locates the orphaned Matroska file and
// repairs it. A row written only on success would leave that footage stranded
// with nothing pointing at it.

export function insertRecording(input: {
  tempPath: string
  startedAt: number
  settingsJson: string
  platform?: string | null
  puuid?: string | null
  matchIdHint?: string | null
  gameStartMs?: number | null
  queueId?: number | null
  championName?: string | null
}): RecordingRow {
  run(
    `INSERT INTO recordings
       (temp_path, state, started_at, settings_json, platform, puuid, match_id_hint,
        game_start_ms, queue_id, champion_name, link_state)
     VALUES (?, 'recording', ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      input.tempPath,
      input.startedAt,
      input.settingsJson,
      input.platform ?? null,
      input.puuid ?? null,
      input.matchIdHint ?? null,
      input.gameStartMs ?? null,
      input.queueId ?? null,
      input.championName ?? null
    ]
  )
  return queryOne<RecordingRow>(`SELECT * FROM recordings WHERE id = ?`, [
    lastInsertRowId()
  ]) as RecordingRow
}

export function getRecording(id: number): RecordingRow | undefined {
  return queryOne<RecordingRow>(`SELECT * FROM recordings WHERE id = ?`, [id])
}

export function listRecordings(limit = 100): RecordingRow[] {
  return queryAll<RecordingRow>(`SELECT * FROM recordings ORDER BY started_at DESC LIMIT ?`, [
    limit
  ])
}

/**
 * Updates whichever fields are supplied. A partial update rather than a whole
 * row rewrite because several of these arrive at different times: the match
 * hint during the game, the capture health at the end, the video id after
 * import.
 */
export function updateRecording(
  id: number,
  patch: {
    state?: RecordingState
    finalPath?: string | null
    firstFrameMs?: number | null
    endedAt?: number | null
    gameStartMs?: number | null
    matchIdHint?: string | null
    platform?: string | null
    puuid?: string | null
    queueId?: number | null
    championName?: string | null
    liveEvents?: string | null
    videoId?: number | null
    linkState?: RecordingLinkState | null
    ffmpegError?: string | null
    droppedFrames?: number | null
    avgFps?: number | null
    sizeBytes?: number | null
  }
): void {
  const columns: Record<string, unknown> = {
    state: patch.state,
    final_path: patch.finalPath,
    first_frame_ms: patch.firstFrameMs,
    ended_at: patch.endedAt,
    game_start_ms: patch.gameStartMs,
    match_id_hint: patch.matchIdHint,
    platform: patch.platform,
    puuid: patch.puuid,
    queue_id: patch.queueId,
    champion_name: patch.championName,
    live_events: patch.liveEvents,
    video_id: patch.videoId,
    link_state: patch.linkState,
    ffmpeg_error: patch.ffmpegError,
    dropped_frames: patch.droppedFrames,
    avg_fps: patch.avgFps,
    size_bytes: patch.sizeBytes
  }

  const assignments: string[] = []
  const values: unknown[] = []
  for (const [column, value] of Object.entries(columns)) {
    // undefined means "leave alone"; null is a real value that clears a field.
    if (value === undefined) continue
    assignments.push(`${column} = ?`)
    values.push(value as string | number | null)
  }
  if (assignments.length === 0) return

  values.push(id)
  run(`UPDATE recordings SET ${assignments.join(', ')} WHERE id = ?`, values as never)
}

/**
 * Sessions that were still in progress when the app stopped running.
 *
 * 'recording' and 'stopping' are the two states that can only be left by the
 * process that owns the capture child, so finding one at startup means that
 * process died. 'remuxing' is included for the same reason: a remux
 * interrupted halfway leaves a partial mp4 and an intact mkv.
 */
export function findInterruptedRecordings(): RecordingRow[] {
  return queryAll<RecordingRow>(
    `SELECT * FROM recordings
     WHERE state IN ('recording', 'stopping', 'remuxing')
     ORDER BY started_at ASC`
  )
}

/** Finished recordings still waiting to be attached to a Riot match. */
export function listPendingLinkRecordings(): RecordingRow[] {
  return queryAll<RecordingRow>(
    `SELECT * FROM recordings
     WHERE state = 'complete' AND link_state = 'pending' AND video_id IS NOT NULL
     ORDER BY started_at ASC`
  )
}

export function bumpRecordingLinkAttempt(id: number): void {
  run(`UPDATE recordings SET link_attempts = link_attempts + 1 WHERE id = ?`, [id])
}

export function setVideoSource(videoId: number, source: VideoSource): void {
  run(`UPDATE videos SET source = ? WHERE id = ?`, [source, videoId])
}

/**
 * Everything a retention sweep might consider, with its size where known.
 *
 * Deliberately returns imported videos too, even though they can never be
 * deleted: they occupy the same disk, so the size readout and the "am I over the
 * limit" arithmetic have to see them. The exclusion happens in the planner,
 * where it's tested, rather than being hidden in this query.
 */
export function listRetentionCandidates(): Array<{
  videoId: number
  filePath: string
  fileName: string
  sizeBytes: number | null
  recordedAt: number
  isFavorite: boolean
  source: string | null
}> {
  const rows = queryAll<{
    id: number
    file_path: string
    file_name: string
    recorded_at: number | null
    created_at: number
    is_favorite: number
    source: string | null
    size_bytes: number | null
  }>(
    `SELECT v.id, v.file_path, v.file_name, v.recorded_at, v.created_at, v.is_favorite, v.source,
            (SELECT r.size_bytes FROM recordings r
              WHERE r.video_id = v.id AND r.size_bytes IS NOT NULL
              ORDER BY r.id DESC LIMIT 1) AS size_bytes
     FROM videos v`
  )

  return rows.map((row) => ({
    videoId: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    // recorded_at is when the game was played, which is what "old" means here.
    recordedAt: row.recorded_at ?? row.created_at,
    isFavorite: row.is_favorite === 1,
    source: row.source
  }))
}
