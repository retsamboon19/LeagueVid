// Sliding-window rate limiter matching Riot's default dev key limits:
// 20 requests / 1 second, 100 requests / 2 minutes.
//
// Requests are split into two priority queues -- 'foreground' (user-
// triggered actions like linking a video) and 'background' (the continuous
// match-history backfill). Foreground requests are always served first,
// and background traffic is capped below the full window limit so it can
// never fully consume the budget and make the user wait behind it.

export type RequestPriority = 'foreground' | 'background'

interface Window {
  limit: number
  // How many slots per window are reserved exclusively for foreground use.
  // Background traffic is capped at (limit - reservedForForeground), so a
  // burst of foreground requests (e.g. linking a video) always has
  // headroom to go through quickly even if background backfill is busy.
  reservedForForeground: number
  intervalMs: number
  timestamps: number[]
}

export interface RateLimitWindowConfig {
  limit: number
  intervalMs: number
}

// Riot's default rate limit -- shared by both development keys and
// personal keys out of the box (a personal key's main benefit over a dev
// key is that it doesn't expire every 24 hours, not a higher limit).
// Actual limits can be higher if Riot has approved increased limits for a
// specific key; that's configurable via RiotRateLimiter's constructor
// (see the API key settings in the app) rather than assumed here.
export const DEFAULT_RATE_WINDOWS: RateLimitWindowConfig[] = [
  { limit: 20, intervalMs: 1_000 },
  { limit: 100, intervalMs: 120_000 }
]

export class RiotRateLimiter {
  private windows: Window[]
  private foregroundQueue: Array<() => void> = []
  private backgroundQueue: Array<() => void> = []
  private processing = false

  constructor(windowConfigs: RateLimitWindowConfig[] = DEFAULT_RATE_WINDOWS) {
    // Reserve 25% of each window's budget for foreground use, same ratio
    // as the previous hardcoded defaults (5/20, 25/100) -- keeps behavior
    // consistent regardless of what limits are configured.
    this.windows = windowConfigs.map((w) => ({
      limit: w.limit,
      reservedForForeground: Math.max(1, Math.round(w.limit * 0.25)),
      intervalMs: w.intervalMs,
      timestamps: []
    }))
  }

  async acquire(priority: RequestPriority = 'foreground'): Promise<void> {
    return new Promise((resolve) => {
      if (priority === 'background') this.backgroundQueue.push(resolve)
      else this.foregroundQueue.push(resolve)
      this.processQueue()
    })
  }

  private processQueue(): void {
    if (this.processing) return
    this.processing = true
    this.tick()
  }

  private prune(now: number): void {
    for (const w of this.windows) {
      w.timestamps = w.timestamps.filter((t) => now - t < w.intervalMs)
    }
  }

  private tick(): void {
    if (this.foregroundQueue.length === 0 && this.backgroundQueue.length === 0) {
      this.processing = false
      return
    }

    const now = Date.now()
    this.prune(now)

    const canGoForeground = this.windows.every((w) => w.timestamps.length < w.limit)
    const canGoBackground = this.windows.every(
      (w) => w.timestamps.length < w.limit - w.reservedForForeground
    )

    let resolve: (() => void) | undefined

    if (this.foregroundQueue.length > 0 && canGoForeground) {
      resolve = this.foregroundQueue.shift()
    } else if (this.backgroundQueue.length > 0 && canGoBackground) {
      resolve = this.backgroundQueue.shift()
    }

    if (resolve) {
      const releaseTime = Date.now()
      for (const w of this.windows) w.timestamps.push(releaseTime)
      resolve()
      // Continue draining queues on next microtask so bursts still respect limits.
      setTimeout(() => this.tick(), 0)
      return
    }

    // Nothing could go through -- figure out the soonest time a slot frees
    // up under the relevant cap (full limit if foreground is waiting,
    // otherwise the lower background cap).
    const waits = this.windows.map((w) => {
      const cap = this.foregroundQueue.length > 0 ? w.limit : w.limit - w.reservedForForeground
      if (w.timestamps.length < cap) return 0
      const oldest = w.timestamps[w.timestamps.length - cap] ?? w.timestamps[0]
      return Math.max(0, w.intervalMs - (now - oldest)) + 10
    })
    const waitMs = Math.max(...waits, 10)
    setTimeout(() => this.tick(), waitMs)
  }
}
