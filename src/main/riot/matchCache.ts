import { getRiotClient } from './clientSingleton'
import { getCachedApiValue, hasCachedApiValue, setCachedApiValue } from '../db/repository'
import type { RequestPriority } from './rateLimiter'
import type { MatchDto, MatchTimelineDto, RegionalRouting } from './types'

// Match and timeline data are immutable once a game has ended, so they're
// cached locally forever -- re-linking, re-scanning, or re-opening a video
// never needs to re-fetch from Riot once the data has been seen once. This
// is also what the background backfill service (backfillService.ts) warms
// ahead of time, so foreground lookups hit the cache instead of the network.
//
// Deliberately NOT cached here: the "what match ids exist for this puuid in
// this time window" lookup. An earlier version tried to cache that too, but
// a time-windowed id list is much easier to cache incorrectly than a single
// match body -- and it did: an empty result ([]) is truthy in JS, so a
// lookup that returned zero matches (e.g. transiently, or before an account
// was linked) got treated as "successfully cached" and served back forever,
// silently breaking search with no visible error. Match id searches now
// always go live to Riot -- see riot/ipc.ts's fetchRecentMatches.

export function isMatchCached(region: RegionalRouting, matchId: string): boolean {
  // Existence check only -- no read or parse. The background downloader calls
  // this once per match id, so parsing a multi-MB body just to answer "is it
  // here?" would be pure waste.
  return hasCachedApiValue(`match:${region}:${matchId}`)
}

export async function getMatchCached(
  region: RegionalRouting,
  matchId: string,
  priority: RequestPriority = 'foreground'
): Promise<MatchDto> {
  const key = `match:${region}:${matchId}`
  const cached = getCachedApiValue<MatchDto>(key)
  if (cached) return cached
  const fresh = await getRiotClient().getMatch(region, matchId, priority)
  setCachedApiValue(key, fresh)
  return fresh
}

export async function getMatchTimelineCached(
  region: RegionalRouting,
  matchId: string,
  priority: RequestPriority = 'foreground'
): Promise<MatchTimelineDto> {
  const key = `timeline:${region}:${matchId}`
  const cached = getCachedApiValue<MatchTimelineDto>(key)
  if (cached) return cached
  const fresh = await getRiotClient().getMatchTimeline(region, matchId, priority)
  setCachedApiValue(key, fresh)
  return fresh
}
