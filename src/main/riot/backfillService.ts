import { matchRegionForPlatform } from './client'
import { getRiotClient } from './clientSingleton'
import { getMatchCached, getMatchTimelineCached, isMatchCached } from './matchCache'
import {
  getBackfillProgress,
  getSettings,
  resetBackfillTotal,
  setBackfillProgress,
  setBackfillTotal
} from '../db/repository'
import type { RiotAccountLink } from '../../shared/types'

// Continuously warms the local match/timeline cache in the background so
// that when the user actually links a video, the data is usually already
// on disk instead of waiting on Riot's rate limit. Runs at 'background'
// priority throughout, so it never competes with anything the user is
// actively doing (see rateLimiter.ts's reserved foreground headroom).
//
// Two phases per account:
//   1. Backfill: page backward through match history (oldest data Riot
//      will return) until an empty page, persisting how far we've gotten
//      so a restart resumes instead of re-paging from scratch.
//   2. Steady-state: once backfill reaches the end, periodically re-check
//      the most recent matches (start=0) for anything new played since,
//      fetching only ids not already cached.

const PAGE_SIZE = 100
const DELAY_BETWEEN_MATCHES_MS = 250 // small breather so this never looks like a burst
const DELAY_BETWEEN_PAGES_MS = 2_000
const STEADY_STATE_RECHECK_INTERVAL_MS = 10 * 60 * 1000 // re-check for new matches every 10 min
const STEADY_STATE_RECHECK_COUNT = 20

let running = false
let stopRequested = false

// Lets a long idle wait be cut short, so "Download match data" in the UI
// takes effect immediately instead of after up to 10 minutes of sleeping.
let wake: (() => void) | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Sleep that returns early if requestBackfillNow() is called. */
function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null
      resolve()
    }, ms)
    wake = () => {
      clearTimeout(timer)
      wake = null
      resolve()
    }
  })
}

// Pre-fetches a match + its timeline into the local cache so a later
// foreground link doesn't have to wait on the network.
//
// Returns whether it actually hit the network. The caller uses that to
// decide whether to pause: pausing after an already-cached match wasted
// 250ms per match, which on a 700+ match library meant several minutes of
// pure waiting on every rescan pass (and made the app feel busy for no
// reason). Only real requests need spacing out.
async function warmMatch(
  region: ReturnType<typeof matchRegionForPlatform>,
  matchId: string
): Promise<boolean> {
  if (isMatchCached(region, matchId)) return false
  await getMatchCached(region, matchId, 'background')
  await getMatchTimelineCached(region, matchId, 'background')
  return true
}

async function backfillAccount(account: RiotAccountLink): Promise<void> {
  const region = matchRegionForPlatform(account.platform)
  let progress = getBackfillProgress(account.puuid)

  // Establish how many matches there are to download before downloading
  // any, so the progress indicator has a real denominator from the start.
  // Cheap: ids only, 100 per request (~5 calls for 500 matches), versus one
  // request per match to actually fetch them.
  if (!progress || progress.total_matches === null || progress.total_matches === undefined) {
    if (stopRequested) return
    const total = await getRiotClient().countMatchIds(region, account.puuid, {
      priority: 'background'
    })
    setBackfillTotal(account.puuid, total)
    console.log(`[backfill] ${account.gameName}#${account.tagLine}: ${total} match(es) available`)
    progress = getBackfillProgress(account.puuid)
  }

  if (!progress || !progress.reached_end) {
    // Phase 1: keep paging backward through history.
    const start = progress?.next_start ?? 0
    if (stopRequested) return

    const ids = await getRiotClient().getMatchIdsByPuuid(region, account.puuid, {
      start,
      count: PAGE_SIZE,
      priority: 'background'
    })

    for (const id of ids) {
      if (stopRequested) return
      const fetched = await warmMatch(region, id)
      if (fetched) await sleep(DELAY_BETWEEN_MATCHES_MS)
    }

    const reachedEnd = ids.length < PAGE_SIZE
    setBackfillProgress(account.puuid, {
      nextStart: start + ids.length,
      reachedEnd
    })
    return
  }

  // Phase 2: steady-state -- just check the most recent matches for
  // anything new. Cheap when nothing's new (all ids already cached).
  const ids = await getRiotClient().getMatchIdsByPuuid(region, account.puuid, {
    start: 0,
    count: STEADY_STATE_RECHECK_COUNT,
    priority: 'background'
  })

  for (const id of ids) {
    if (stopRequested) return
    const fetched = await warmMatch(region, id)
    if (fetched) await sleep(DELAY_BETWEEN_MATCHES_MS)
  }
}

async function loop(): Promise<void> {
  while (!stopRequested) {
    try {
      const settings = getSettings()
      const accounts = settings?.accounts ?? []

      if (accounts.length === 0) {
        await sleep(STEADY_STATE_RECHECK_INTERVAL_MS)
        continue
      }

      let allReachedEnd = true
      for (const account of accounts) {
        if (stopRequested) break
        await backfillAccount(account)
        const progress = getBackfillProgress(account.puuid)
        if (!progress?.reached_end) allReachedEnd = false
        await sleep(DELAY_BETWEEN_PAGES_MS)
      }

      // Once every account has backfilled fully, there's nothing urgent
      // to do -- wait longer before the next steady-state re-check pass.
      // Interruptible so the user can force an immediate pass.
      if (allReachedEnd) {
        await interruptibleSleep(STEADY_STATE_RECHECK_INTERVAL_MS)
      }
    } catch {
      // Network hiccup, expired key, etc. Don't crash the loop -- just
      // wait and retry. Foreground requests surface their own errors
      // through the normal IPC error path, so silent retry here is fine.
      await interruptibleSleep(STEADY_STATE_RECHECK_INTERVAL_MS)
    }
  }
  running = false
}

export function startBackfillService(): void {
  if (running) return
  running = true
  stopRequested = false
  // Small initial delay so this doesn't compete with the app's own
  // startup work (DB init, Data Dragon fetch, window load).
  setTimeout(() => {
    loop()
  }, 5_000)
}

export function stopBackfillService(): void {
  stopRequested = true
}

/**
 * Forces a full re-walk of every linked account's history right now, so any
 * match that isn't cached yet gets picked up. Safe to press repeatedly:
 * matches already on disk are skipped without a network request, so a rescan
 * of an already-complete library costs only the id-list pages (roughly one
 * request per 100 matches) rather than re-downloading anything.
 *
 * Also clears the stored total so it's recounted, which is what picks up
 * games played since the last count.
 */
export function requestBackfillNow(): void {
  const accounts = getSettings()?.accounts ?? []
  for (const account of accounts) {
    // Rewind to the first page and clear reached_end so phase 1 runs again.
    setBackfillProgress(account.puuid, { nextStart: 0, reachedEnd: false })
    resetBackfillTotal(account.puuid)
  }
  wake?.()
}
