// Builds a large, role-balanced calibration dataset for the achievement
// system (see thresholds.ts), independent of the app's own riot-api-cache.
//
// Plan: take the seed account's last N solo-queue matches, collect every
// other player who appeared in them, then pull each of those players' M
// most recent solo-queue matches. This spreads role coverage across dozens
// of independent accounts instead of just the seed's own history -- the
// cost is that the N seed matches are correlated with each other (shared
// patch, one team's game shaping five stat lines at once), which the
// per-player fan-out doesn't fully escape either, since duo partners repeat.
//
// Output lives entirely under dataset/, never inside the app's own
// riot-api-cache -- this is a standalone calibration corpus for
// scripts/tune-achievements.ts, not something the shipped app reads.
//
// Deliberately has no Electron dependency (unlike src/main/riot/matchCache.ts
// and db/fileCache.ts, which need `app.getPath`), so it runs standalone via
// tsx. RiotClient/RiotRateLimiter are electron-free and reused as-is.
//
// Usage:
//   npx tsx scripts/build-dataset.ts
//   npx tsx scripts/build-dataset.ts --seed-count 10 --per-player 100 --queue 420
//   npx tsx scripts/build-dataset.ts --skip-timelines
//   npx tsx scripts/build-dataset.ts --puuid <puuid> --platform na1
//
// Safe to interrupt (Ctrl+C) and re-run: already-downloaded match/timeline
// files are never re-fetched, so a restart resumes instead of starting over.

import dotenv from 'dotenv'
import initSqlJs from 'sql.js'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  copyFileSync
} from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { RiotClient, matchRegionForPlatform } from '../src/main/riot/client'
import type { MatchDto, PlatformRouting, RegionalRouting } from '../src/main/riot/types'

dotenv.config({ path: join(__dirname, '..', '.env') })

// --- Config ----------------------------------------------------------------

const DATASET_ROOT = join(__dirname, '..', 'dataset')
const APP_DATA_DIR = join(homedir(), 'AppData', 'Roaming', 'leaguevid')
const APP_CACHE_ROOT = join(APP_DATA_DIR, 'riot-api-cache')
const APP_DB_PATH = join(APP_DATA_DIR, 'leaguevid.db')
const LOG_PATH = join(DATASET_ROOT, 'fetch-log.txt')
const MANIFEST_PATH = join(DATASET_ROOT, 'manifest.json')

// Riot's default dev/personal key limits are 20 requests/1s and 100/2min.
// Staying 1-2 below both keeps this run from ever tripping a 429 under
// normal conditions -- the client's Retry-After backoff is a backstop, not
// the primary strategy.
const RATE_WINDOWS = [
  { limit: 19, intervalMs: 1_000 },
  { limit: 98, intervalMs: 120_000 }
]

interface Args {
  seedCount: number
  perPlayer: number
  queue: number
  platform: PlatformRouting | null
  puuid: string | null
  skipTimelines: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return {
    seedCount: Number(get('--seed-count') ?? 10),
    perPlayer: Number(get('--per-player') ?? 100),
    queue: Number(get('--queue') ?? 420),
    platform: (get('--platform') as PlatformRouting | null) ?? null,
    puuid: get('--puuid'),
    skipTimelines: argv.includes('--skip-timelines')
  }
}

// --- Logging -----------------------------------------------------------------

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  appendFileSync(LOG_PATH, line + '\n')
}

// --- Seed account auto-detection --------------------------------------------
// Mirrors scripts/tune-achievements.ts's inferOwnerPuuid: whichever puuid
// appears most often across the app's own cached matches is treated as the
// main account. Then cross-referenced against the app's settings row to
// recover which platform it's linked under. Lets this script run with zero
// arguments on this machine while staying explicit (--puuid/--platform) for
// anyone running it elsewhere.

function walkJson(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJson(full))
    else if (entry.name.endsWith('.json')) out.push(full)
  }
  return out
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function inferMainPuuidFromCache(): string | null {
  const counts = new Map<string, number>()
  for (const path of walkJson(join(APP_CACHE_ROOT, 'match'))) {
    const match = readJson<MatchDto>(path)
    if (!match) continue
    for (const p of match.metadata?.participants ?? []) {
      counts.set(p, (counts.get(p) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestCount = 0
  for (const [puuid, count] of counts) {
    if (count > bestCount) {
      best = puuid
      bestCount = count
    }
  }
  return best
}

async function findPlatformForPuuid(puuid: string): Promise<PlatformRouting | null> {
  if (!existsSync(APP_DB_PATH)) return null
  const SQL = await initSqlJs({
    locateFile: (f) => join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f)
  })
  const db = new SQL.Database(readFileSync(APP_DB_PATH))
  try {
    const rows = db.exec(`SELECT value FROM settings WHERE key = 'riotAccount'`)
    const value = rows[0]?.values[0]?.[0]
    if (typeof value !== 'string') return null
    const parsed = JSON.parse(value) as { accounts?: Array<{ puuid: string; platform: string }> }
    const match = parsed.accounts?.find((a) => a.puuid === puuid)
    return (match?.platform as PlatformRouting) ?? null
  } finally {
    db.close()
  }
}

/**
 * Mirrors main/config.ts's getRiotApiKey(): a key saved from the app's
 * Settings screen (stored in leaguevid.db) always wins over .env, since
 * that's the one actually used for live requests -- and dev keys in .env
 * expire every 24h, so it's routinely the stale one.
 */
async function resolveApiKey(): Promise<string> {
  if (existsSync(APP_DB_PATH)) {
    const SQL = await initSqlJs({
      locateFile: (f) => join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f)
    })
    const db = new SQL.Database(readFileSync(APP_DB_PATH))
    try {
      const rows = db.exec(`SELECT value FROM settings WHERE key = 'riotApiKeyOverride'`)
      const value = rows[0]?.values[0]?.[0]
      if (typeof value === 'string' && value.trim()) return value.trim()
    } finally {
      db.close()
    }
  }
  const envKey = process.env.RIOT_API_KEY
  if (!envKey) {
    throw new Error(
      'No Riot API key found in the app settings override or RIOT_API_KEY in .env.'
    )
  }
  return envKey
}

async function resolveSeedAccount(
  args: Args
): Promise<{ puuid: string; platform: PlatformRouting }> {
  if (args.puuid && args.platform) {
    return { puuid: args.puuid, platform: args.platform }
  }

  const inferredPuuid = args.puuid ?? inferMainPuuidFromCache()
  if (!inferredPuuid) {
    throw new Error(
      'Could not auto-detect a seed account from the app cache. Pass --puuid and --platform explicitly.'
    )
  }

  const inferredPlatform = args.platform ?? (await findPlatformForPuuid(inferredPuuid))
  if (!inferredPlatform) {
    throw new Error(
      `Found a candidate puuid but no matching platform in settings. Pass --platform explicitly.`
    )
  }

  return { puuid: inferredPuuid, platform: inferredPlatform }
}

// --- File storage ------------------------------------------------------------

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '_')
}

function datasetPath(kind: 'match' | 'timeline', region: RegionalRouting, matchId: string): string {
  return join(DATASET_ROOT, kind, region, `${sanitizeSegment(matchId)}.json`)
}

function appCachePath(kind: 'match' | 'timeline', region: RegionalRouting, matchId: string): string {
  return join(APP_CACHE_ROOT, kind, region, `${sanitizeSegment(matchId)}.json`)
}

/**
 * Returns true if the file is now present at `dest`, either because it
 * already was, or because a copy already sitting in the app's own cache
 * (from ordinary backfill) was reused instead of spending a network request.
 */
function ensureFromAppCacheOrMissing(
  kind: 'match' | 'timeline',
  region: RegionalRouting,
  matchId: string
): boolean {
  const dest = datasetPath(kind, region, matchId)
  if (existsSync(dest)) return true

  const source = appCachePath(kind, region, matchId)
  if (existsSync(source)) {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(source, dest)
    return true
  }
  return false
}

function writeDataset(kind: 'match' | 'timeline', region: RegionalRouting, matchId: string, value: unknown): void {
  const dest = datasetPath(kind, region, matchId)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, JSON.stringify(value))
}

// --- Manifest (progress, for checking in on an overnight run) --------------

interface Manifest {
  startedAt: string
  updatedAt: string
  seedPuuid: string
  seedPlatform: PlatformRouting
  seedCount: number
  perPlayer: number
  queue: number
  skipTimelines: boolean
  phase: string
  uniqueOtherPlayers: number
  targetMatchCount: number
  matchesFetched: number
  matchesReusedFromAppCache: number
  timelinesFetched: number
  timelinesReusedFromAppCache: number
  failures: number
  done: boolean
}

let manifest: Manifest

function writeManifest(): void {
  manifest.updatedAt = new Date().toISOString()
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs()
  mkdirSync(DATASET_ROOT, { recursive: true })

  const apiKey = await resolveApiKey()
  const seed = await resolveSeedAccount(args)
  const region = matchRegionForPlatform(seed.platform)
  const client = new RiotClient(apiKey, RATE_WINDOWS)

  manifest = {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seedPuuid: seed.puuid,
    seedPlatform: seed.platform,
    seedCount: args.seedCount,
    perPlayer: args.perPlayer,
    queue: args.queue,
    skipTimelines: args.skipTimelines,
    phase: 'starting',
    uniqueOtherPlayers: 0,
    targetMatchCount: 0,
    matchesFetched: 0,
    matchesReusedFromAppCache: 0,
    timelinesFetched: 0,
    timelinesReusedFromAppCache: 0,
    failures: 0,
    done: false
  }
  writeManifest()

  log(
    `Starting dataset build. seed platform=${seed.platform} region=${region} ` +
      `seedCount=${args.seedCount} perPlayer=${args.perPlayer} queue=${args.queue} ` +
      `skipTimelines=${args.skipTimelines}`
  )

  // --- Phase 1: seed's own last N solo-queue matches ---
  manifest.phase = 'seed-ids'
  writeManifest()

  const seedIds = await client.getMatchIdsByPuuid(region, seed.puuid, {
    start: 0,
    count: args.seedCount,
    queue: args.queue,
    priority: 'foreground'
  })
  log(`Seed matches: ${seedIds.length}`)

  // --- Phase 2: fetch seed matches, collect every other participant ---
  manifest.phase = 'seed-matches'
  writeManifest()

  const otherPuuids = new Set<string>()

  for (const matchId of seedIds) {
    try {
      const match = await fetchMatchWithCacheReuse(client, region, matchId)
      manifest.matchesFetched++
      for (const puuid of match.metadata?.participants ?? []) {
        if (puuid !== seed.puuid) otherPuuids.add(puuid)
      }
      if (!args.skipTimelines) {
        await fetchTimelineWithCacheReuse(client, region, matchId)
        manifest.timelinesFetched++
      }
    } catch (err) {
      manifest.failures++
      log(`FAILED seed match ${matchId}: ${(err as Error).message}`)
    }
    writeManifest()
  }

  manifest.uniqueOtherPlayers = otherPuuids.size
  log(`Unique other players found across seed matches: ${otherPuuids.size}`)
  writeManifest()

  // --- Phase 3: for every other player, collect their own recent match ids ---
  manifest.phase = 'other-player-ids'
  writeManifest()

  const allMatchIds = new Set<string>(seedIds)

  let playerIndex = 0
  for (const puuid of otherPuuids) {
    playerIndex++
    try {
      const ids = await client.getMatchIdsByPuuid(region, puuid, {
        start: 0,
        count: args.perPlayer,
        queue: args.queue,
        priority: 'foreground'
      })
      for (const id of ids) allMatchIds.add(id)
      log(
        `[${playerIndex}/${otherPuuids.size}] player ${puuid.slice(0, 8)}...: ${ids.length} match ids ` +
          `(running unique total: ${allMatchIds.size})`
      )
    } catch (err) {
      manifest.failures++
      log(`FAILED match-id lookup for player ${puuid.slice(0, 8)}...: ${(err as Error).message}`)
    }
  }

  manifest.targetMatchCount = allMatchIds.size
  log(`Total unique match ids to fetch (incl. seed): ${allMatchIds.size}`)
  writeManifest()

  // --- Phase 4: download every match (+ timeline) not already fetched ---
  manifest.phase = 'downloading'
  writeManifest()

  let done = 0
  for (const matchId of allMatchIds) {
    done++
    try {
      const wasCached = existsSync(datasetPath('match', region, matchId))
      await fetchMatchWithCacheReuse(client, region, matchId)
      if (!wasCached) manifest.matchesFetched++

      if (!args.skipTimelines) {
        const timelineWasCached = existsSync(datasetPath('timeline', region, matchId))
        await fetchTimelineWithCacheReuse(client, region, matchId)
        if (!timelineWasCached) manifest.timelinesFetched++
      }
    } catch (err) {
      manifest.failures++
      log(`FAILED match ${matchId}: ${(err as Error).message}`)
    }

    if (done % 25 === 0 || done === allMatchIds.size) {
      log(`Progress: ${done}/${allMatchIds.size} matches processed`)
      writeManifest()
    }
  }

  manifest.phase = 'complete'
  manifest.done = true
  writeManifest()
  log(
    `Done. matches=${manifest.matchesFetched} (+${manifest.matchesReusedFromAppCache} reused) ` +
      `timelines=${manifest.timelinesFetched} (+${manifest.timelinesReusedFromAppCache} reused) ` +
      `failures=${manifest.failures}`
  )
}

/** Fetches a match body, reusing an existing dataset or app-cache copy when possible. */
async function fetchMatchWithCacheReuse(
  client: RiotClient,
  region: RegionalRouting,
  matchId: string
): Promise<MatchDto> {
  const dest = datasetPath('match', region, matchId)
  if (existsSync(dest)) {
    return readJson<MatchDto>(dest) as MatchDto
  }
  if (ensureFromAppCacheOrMissing('match', region, matchId)) {
    manifest.matchesReusedFromAppCache++
    return readJson<MatchDto>(dest) as MatchDto
  }
  const fresh = await client.getMatch(region, matchId, 'foreground')
  writeDataset('match', region, matchId, fresh)
  return fresh
}

/** Same idea as fetchMatchWithCacheReuse, for the timeline endpoint. */
async function fetchTimelineWithCacheReuse(
  client: RiotClient,
  region: RegionalRouting,
  matchId: string
): Promise<void> {
  const dest = datasetPath('timeline', region, matchId)
  if (existsSync(dest)) return
  if (ensureFromAppCacheOrMissing('timeline', region, matchId)) {
    manifest.timelinesReusedFromAppCache++
    return
  }
  const fresh = await client.getMatchTimeline(region, matchId, 'foreground')
  writeDataset('timeline', region, matchId, fresh)
}

main().catch((err) => {
  log(`FATAL: ${(err as Error).message}`)
  console.error(err)
  process.exitCode = 1
})
