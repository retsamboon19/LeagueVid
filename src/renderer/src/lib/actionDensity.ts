import type { MatchActionEvent } from '../../../shared/types'

// Builds an "action density" curve for the timeline, so busy stretches of a
// game are visible at a glance and dead stretches can be skipped.
//
// This reflects the WHOLE match, not just the recording owner's own
// bookmarks. It's built from every kill, epic monster, and building-kill
// event in the match timeline across all 10 players (see
// getMatchActionTimeline in main/riot/matchStats.ts) -- so a teamfight the
// owner wasn't even in still shows up as a spike, not just their personal
// kills/deaths/assists.
//
// A note on what this is NOT: Outplayed shows an APM (actions per minute)
// graph, sampled from the recording player's own keyboard and mouse while
// recording. LeagueVid can't reproduce that -- nothing captured input at the
// time, and it isn't recoverable after the fact. This measures match events
// instead, which is the best available signal for "where's the action",
// arguably closer to what matters for clipping anyway: APM spikes while
// farming too, whereas a teamfight is what's worth rewatching. It's labelled
// "Action" in the UI, not "APM", so it isn't mistaken for an input reading.

export interface DensityEvent {
  timestampMs: number
  weight: number
}

/** Adapts match-wide action events (already weighted server-side) to the
 * generic density-event shape this module works with. */
export function fromMatchActionEvents(events: MatchActionEvent[]): DensityEvent[] {
  return events.map((e) => ({ timestampMs: e.timestampMs, weight: e.weight }))
}

export interface DensityBucket {
  startMs: number
  endMs: number
  /** Raw weighted score for the bucket. */
  score: number
  /** Score scaled to 0..1 against the busiest bucket. */
  intensity: number
}

/**
 * Buckets weighted events across a duration.
 *
 * Each event is spread over a short window rather than counted at a single
 * instant, because the interesting part of a fight extends around the kill
 * that got recorded -- a spike one bucket wide would be noise on a long game.
 */
export function buildActionDensity(
  events: DensityEvent[],
  durationMs: number,
  bucketCount = 240
): DensityBucket[] {
  if (durationMs <= 0 || bucketCount <= 0) return []

  const bucketMs = durationMs / bucketCount
  const scores = new Array<number>(bucketCount).fill(0)

  // How far either side of an event its influence reaches. Fixed in real time
  // (not buckets) so the shape doesn't change with zoom or game length.
  const SPREAD_MS = 6_000

  for (const event of events) {
    if (event.timestampMs < 0 || event.timestampMs > durationMs) continue
    const firstBucket = Math.max(0, Math.floor((event.timestampMs - SPREAD_MS) / bucketMs))
    const lastBucket = Math.min(
      bucketCount - 1,
      Math.floor((event.timestampMs + SPREAD_MS) / bucketMs)
    )

    for (let i = firstBucket; i <= lastBucket; i++) {
      const bucketCenter = (i + 0.5) * bucketMs
      const distance = Math.abs(bucketCenter - event.timestampMs)
      // Linear falloff to the edge of the spread window: simple, and enough
      // to turn isolated events into readable humps. Overlapping falloffs
      // from simultaneous events (a teamfight) sum together naturally, which
      // is what makes a 5-kill fight read as a taller spike than a solo kill
      // without any special-casing.
      const falloff = Math.max(0, 1 - distance / SPREAD_MS)
      scores[i] += event.weight * falloff
    }
  }

  const max = Math.max(...scores, 0)

  return scores.map((score, i) => ({
    startMs: i * bucketMs,
    endMs: (i + 1) * bucketMs,
    score,
    intensity: max > 0 ? score / max : 0
  }))
}

/** SVG polyline points for a density curve drawn into a width x height box. */
export function densityPolyline(
  buckets: DensityBucket[],
  width: number,
  height: number
): string {
  if (buckets.length === 0) return ''
  const step = width / Math.max(1, buckets.length - 1)
  return buckets
    .map((b, i) => `${(i * step).toFixed(2)},${(height - b.intensity * height).toFixed(2)}`)
    .join(' ')
}

/** Closed path version, for filling the area under the curve. */
export function densityAreaPath(
  buckets: DensityBucket[],
  width: number,
  height: number
): string {
  if (buckets.length === 0) return ''
  const line = densityPolyline(buckets, width, height)
  return `M0,${height} L${line.split(' ').join(' L')} L${width},${height} Z`
}
