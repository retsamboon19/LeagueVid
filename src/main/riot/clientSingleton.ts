import { getRiotApiKey } from '../config'
import { RiotClient } from './client'
import { DEFAULT_RATE_WINDOWS, type RateLimitWindowConfig } from './rateLimiter'
import { getRiotRateLimitOverride } from '../db/repository'

// Shared singleton so foreground requests (ipc.ts) and the background
// backfill service use the same RiotClient -- and therefore the same
// rate limiter -- so priority-aware queuing actually works across both.
let client: RiotClient | null = null

function readRateLimitWindows(): RateLimitWindowConfig[] {
  const override = getRiotRateLimitOverride()
  if (!override) return DEFAULT_RATE_WINDOWS
  return [
    { limit: override.perSecond, intervalMs: 1_000 },
    { limit: override.per2Minutes, intervalMs: 120_000 }
  ]
}

export function getRiotClient(): RiotClient {
  if (!client) {
    client = new RiotClient(getRiotApiKey(), readRateLimitWindows())
  }
  return client
}

// Called after the user saves a new API key or rate limit from Settings, so
// the next request picks up the change immediately instead of continuing to
// use whatever key/limiter the singleton was first created with.
export function resetRiotClient(): void {
  client = null
}
