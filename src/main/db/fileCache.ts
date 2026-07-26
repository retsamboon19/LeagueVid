import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'

// On-disk cache for immutable Riot API responses (match bodies and
// timelines), stored as one JSON file per response.
//
// These used to live in the SQLite database, which was a mistake at this
// scale. sql.js has no incremental write path: saving the database means
// serializing the whole thing and rewriting the file. Once the cache grew to
// ~900 matches plus timelines the database was 635 MB, so every small write
// anywhere in the app rewrote 635 MB, and startup read all of it into memory.
//
// Splitting the cache out means:
//   - writing one cache entry touches one small file
//   - the database drops to a few MB, so its saves are cheap again
//   - startup no longer loads hundreds of MB of match JSON into memory
//
// A filesystem is a perfectly good key/value store for immutable blobs keyed
// by id, which is all this ever needed.

let cacheRootOverride: string | null = null

/** Lets scripts and tests point at a specific cache directory. */
export function setCacheRoot(path: string): void {
  cacheRootOverride = path
}

// Deliberately NOT "cache": Electron/Chromium already keeps its own HTTP
// cache at userData/Cache, and Windows paths are case-insensitive, so a
// directory named "cache" resolves to that same folder. Chromium actively
// evicts entries there, which silently deleted most of a migrated match
// cache. The name has to be one Chromium will never touch.
const CACHE_DIR_NAME = 'riot-api-cache'

export function cacheRoot(): string {
  if (cacheRootOverride) return cacheRootOverride
  return join(app.getPath('userData'), CACHE_DIR_NAME)
}

// Cache keys look like "match:sea:SG2_156043554" or
// "timeline:sea:SG2_156043554". Each segment becomes a path segment, so the
// layout on disk is cache/match/sea/SG2_156043554.json -- browsable, and
// cheap to enumerate one kind of entry without touching the others.
function sanitizeSegment(segment: string): string {
  // Defensive: cache keys are internally generated, but a path separator or
  // traversal sequence slipping into one must not escape the cache directory.
  return segment.replace(/[^A-Za-z0-9._-]/g, '_')
}

function pathForKey(key: string): string {
  const segments = key.split(':').map(sanitizeSegment).filter(Boolean)
  if (segments.length === 0) return join(cacheRoot(), 'unknown.json')
  const fileName = `${segments.pop()}.json`
  return join(cacheRoot(), ...segments, fileName)
}

export function hasCachedValue(key: string): boolean {
  return existsSync(pathForKey(key))
}

export function getCachedValue<T>(key: string): T | null {
  const path = pathForKey(key)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    // A truncated or corrupt file is treated as absent, so the caller can
    // re-fetch rather than crash on parse.
    return null
  }
}

export function setCachedValue<T>(key: string, value: T): void {
  setRawCachedValue(key, JSON.stringify(value))
}

/**
 * Writes an already-serialized JSON string. Used by the migration out of the
 * database, where the value is stored as text and re-parsing it just to
 * re-serialize would be wasted work on hundreds of MB.
 */
export function setRawCachedValue(key: string, json: string): void {
  const path = pathForKey(key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, json, 'utf8')
}

/** Absolute paths of every cached entry of a given kind, e.g. 'match'. */
export function listCachedPaths(kind: string): string[] {
  const root = join(cacheRoot(), sanitizeSegment(kind))
  if (!existsSync(root)) return []

  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json')) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * Reads every cached entry of a kind, yielding the id (file name without
 * extension) and parsed value. Skips unreadable files rather than failing.
 */
export function readCachedEntries<T>(kind: string): Array<{ id: string; value: T }> {
  const entries: Array<{ id: string; value: T }> = []
  for (const path of listCachedPaths(kind)) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as T
      const id = path.slice(path.lastIndexOf('\\') + 1).replace(/\.json$/, '')
      entries.push({ id, value })
    } catch {
      continue
    }
  }
  return entries
}

export function cacheStats(): { count: number; oldestAt: number | null } {
  let count = 0
  let oldest: number | null = null

  for (const kind of ['match', 'timeline']) {
    for (const path of listCachedPaths(kind)) {
      count++
      try {
        const mtime = statSync(path).mtimeMs
        if (oldest === null || mtime < oldest) oldest = mtime
      } catch {
        continue
      }
    }
  }

  return { count, oldestAt: oldest }
}

/** Number of cached match bodies -- the "how much history do I have" figure. */
export function cachedMatchCount(): number {
  return listCachedPaths('match').length
}

export function clearFileCache(): void {
  const root = cacheRoot()
  if (!existsSync(root)) return
  rmSync(root, { recursive: true, force: true })
}
