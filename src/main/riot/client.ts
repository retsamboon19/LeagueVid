import { RiotRateLimiter, type RequestPriority, type RateLimitWindowConfig } from './rateLimiter'
import type {
  MatchDto,
  MatchTimelineDto,
  PlatformRouting,
  RegionalRouting,
  RiotAccountDto
} from './types'

export class RiotApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'RiotApiError'
  }
}

// Maps a platform (e.g. na1) to its regional routing value (e.g. americas)
// used by the match-v5 endpoints. SEA platforms (oc1/sg2/tw2/vn2) route to
// 'sea' here -- Thailand/Philippines were merged into the Singapore (sg2)
// server as of patch 15.1 (Jan 2025), forming the unified SEA server.
const PLATFORM_TO_MATCH_REGION: Record<PlatformRouting, RegionalRouting> = {
  na1: 'americas',
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  kr: 'asia',
  jp1: 'asia',
  euw1: 'europe',
  eun1: 'europe',
  tr1: 'europe',
  ru: 'europe',
  oc1: 'sea',
  sg2: 'sea',
  tw2: 'sea',
  vn2: 'sea',
  // Legacy platform codes kept for backwards compatibility with older
  // links/data; both now route through the merged SEA server.
  ph2: 'sea',
  th2: 'sea'
}

// account-v1 (Riot ID -> PUUID lookup) does not support the 'sea' regional
// routing value -- it must use 'asia' even for SEA platforms.
const PLATFORM_TO_ACCOUNT_REGION: Record<PlatformRouting, RegionalRouting> = {
  ...PLATFORM_TO_MATCH_REGION,
  oc1: 'asia',
  sg2: 'asia',
  tw2: 'asia',
  vn2: 'asia',
  ph2: 'asia',
  th2: 'asia'
}

export function matchRegionForPlatform(platform: PlatformRouting): RegionalRouting {
  return PLATFORM_TO_MATCH_REGION[platform]
}

export function accountRegionForPlatform(platform: PlatformRouting): RegionalRouting {
  return PLATFORM_TO_ACCOUNT_REGION[platform]
}

export class RiotClient {
  private limiter: RiotRateLimiter

  constructor(
    private apiKey: string,
    rateLimitWindows?: RateLimitWindowConfig[]
  ) {
    this.limiter = new RiotRateLimiter(rateLimitWindows)
  }

  private async request<T>(
    url: string,
    priority: RequestPriority = 'foreground',
    attempt = 0
  ): Promise<T> {
    await this.limiter.acquire(priority)

    const res = await fetch(url, {
      headers: { 'X-Riot-Token': this.apiKey }
    })

    if (res.status === 429 && attempt < 3) {
      // Respect Riot's Retry-After header when present; otherwise back off
      // with increasing delay. Transient 429s (e.g. from bursts of parallel
      // requests) are retried automatically rather than surfaced as errors.
      const retryAfterHeader = res.headers.get('Retry-After')
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : 1000 * (attempt + 1)
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
      return this.request<T>(url, priority, attempt + 1)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new RiotApiError(res.status, `Riot API ${res.status}: ${body || res.statusText}`)
    }

    return res.json() as Promise<T>
  }

  async getAccountByRiotId(
    region: RegionalRouting,
    gameName: string,
    tagLine: string
  ): Promise<RiotAccountDto> {
    const url = `https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
      gameName
    )}/${encodeURIComponent(tagLine)}`
    return this.request<RiotAccountDto>(url)
  }

  async getMatchIdsByPuuid(
    region: RegionalRouting,
    puuid: string,
    opts: {
      start?: number
      count?: number
      startTime?: number // epoch seconds, inclusive
      endTime?: number // epoch seconds, exclusive
      /** Riot queue id filter (e.g. 420 for ranked solo/duo). Omit for all queues. */
      queue?: number
      priority?: RequestPriority
    } = {}
  ): Promise<string[]> {
    const params = new URLSearchParams({
      start: String(opts.start ?? 0),
      count: String(opts.count ?? 20)
    })
    if (opts.startTime !== undefined) params.set('startTime', String(opts.startTime))
    if (opts.endTime !== undefined) params.set('endTime', String(opts.endTime))
    if (opts.queue !== undefined) params.set('queue', String(opts.queue))

    const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?${params.toString()}`
    return this.request<string[]>(url, opts.priority ?? 'foreground')
  }

  /**
   * Paginates through getMatchIdsByPuuid to collect every match id within a
   * startTime/endTime window, instead of just the first page. Riot applies
   * the time filter to the player's whole history first, THEN applies
   * start/count pagination on the filtered result -- so a single
   * start=0/count=100 call silently truncates anyone with more than 100
   * games in the window, dropping the older half of it. Stops once a page
   * comes back shorter than the page size (no more results) or a safety
   * cap is hit (guards against an unbounded loop for extreme match counts).
   */
  async getAllMatchIdsByPuuid(
    region: RegionalRouting,
    puuid: string,
    opts: {
      startTime?: number
      endTime?: number
      priority?: RequestPriority
      pageSize?: number
      maxPages?: number
    } = {}
  ): Promise<string[]> {
    const pageSize = opts.pageSize ?? 100
    const maxPages = opts.maxPages ?? 20 // up to 2000 matches
    const allIds: string[] = []

    for (let page = 0; page < maxPages; page++) {
      const ids = await this.getMatchIdsByPuuid(region, puuid, {
        start: page * pageSize,
        count: pageSize,
        startTime: opts.startTime,
        endTime: opts.endTime,
        priority: opts.priority
      })
      allIds.push(...ids)
      if (ids.length < pageSize) break
    }

    return allIds
  }

/**
   * Counts how many match ids Riot will return for this player, by paging
   * through the ID-ONLY endpoint. This is cheap compared to downloading the
   * matches themselves: ids come back 100 per call, so ~500 matches costs 5
   * requests instead of 500. Used to get a denominator for backfill
   * progress without fetching any match bodies.
   *
   * Note this is "how many matches Riot will hand back", not a lifetime
   * game count -- match-v5's id list is capped (roughly the last ~1000
   * matches / ~2 years), so a very active player's real total can be
   * higher than this reports.
   */
  async countMatchIds(
    region: RegionalRouting,
    puuid: string,
    opts: { priority?: RequestPriority; pageSize?: number; maxPages?: number } = {}
  ): Promise<number> {
    const pageSize = opts.pageSize ?? 100
    const maxPages = opts.maxPages ?? 20
    let total = 0

    for (let page = 0; page < maxPages; page++) {
      const ids = await this.getMatchIdsByPuuid(region, puuid, {
        start: page * pageSize,
        count: pageSize,
        priority: opts.priority ?? 'background'
      })
      total += ids.length
      if (ids.length < pageSize) break
    }

    return total
  }

  async getMatch(
    region: RegionalRouting,
    matchId: string,
    priority: RequestPriority = 'foreground'
  ): Promise<MatchDto> {
    const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}`
    return this.request<MatchDto>(url, priority)
  }

  async getMatchTimeline(
    region: RegionalRouting,
    matchId: string,
    priority: RequestPriority = 'foreground'
  ): Promise<MatchTimelineDto> {
    const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`
    return this.request<MatchTimelineDto>(url, priority)
  }
}
