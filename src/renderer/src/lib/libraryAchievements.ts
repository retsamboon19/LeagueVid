import type { MatchRosterData, MatchStats, VideoRow } from '../../../shared/types'
import {
  buildLiteMatchFacts,
  buildMatchFacts,
  evaluateAchievements,
  selectFromEarned,
  type EarnedAchievement
} from './achievements'

// Achievement evaluation for the recordings list, done once per recording.
//
// Two consumers need it and they used to be solved separately: the tiles wanted
// a handful of chips, and the achievement filter wants the full set of ids a
// recording earned. Both come from the same rule pass, so this runs it once and
// returns both. Doing it per tile inside the tile meant ~75 conditions per
// visible row on every library re-render -- filter keystrokes included.

/**
 * Chips shown on a tile. The achievements panel shows up to six; a tile has far
 * less room and is meant to be scannable at a glance, so it takes the
 * highest-priority few and lets CSS hide any that don't fit the width.
 */
export const TILE_CHIP_LIMIT = 5

export interface VideoAchievements {
  /** Trimmed, highest-priority first. What the tile displays. */
  chips: EarnedAchievement[]
  /** Every id that qualified, untrimmed. What the filter matches against. */
  earnedIds: Set<string>
}

/** The roster snapshot stored on a video row, or null if absent/corrupt. */
export function parseRoster(matchData: string | null): MatchRosterData | null {
  if (!matchData) return null
  try {
    return JSON.parse(matchData) as MatchRosterData
  } catch {
    return null
  }
}

/**
 * Evaluates one recording.
 *
 * Prefers the bulk stats when the library has loaded them (full rule coverage
 * bar the timeline-only ones) and falls back to the row's own data, so chips
 * appear immediately and sharpen once the stats land rather than the list
 * waiting on a round trip.
 *
 * Fillers are excluded from the chips: they exist to stop the player page's
 * dedicated panel from looking empty, but on a tile a chip has to mean
 * something. With them on, over half of all tiles led with "Kept Farming" or
 * "Banked It", which is exactly the noise the real rules avoid. They stay in
 * `earnedIds` -- the filter should still find them if you ask for one.
 */
export function evaluateVideoAchievements(
  video: VideoRow,
  roster: MatchRosterData | null,
  stats: MatchStats | undefined,
  towerDiveKills?: number
): VideoAchievements | null {
  const focus = stats?.participants.find((p) => p.puuid === stats.ownerPuuid)
  const facts =
    stats && focus
      ? buildMatchFacts({ stats, focus, towerDiveKills })
      : buildLiteMatchFacts({ video, roster })
  if (!facts) return null

  const earned = evaluateAchievements(facts)
  const selection = selectFromEarned(earned, facts, undefined, { includeFillers: false })

  return {
    chips: [...selection.positive, ...selection.negative].slice(0, TILE_CHIP_LIMIT),
    earnedIds: new Set(earned.map((a) => a.id))
  }
}

/**
 * Per-row memo, so a library-wide rebuild only pays for the rows that changed.
 *
 * Keyed on the VideoRow object itself, which works because every state update in
 * the library rebuilds the array but reuses the row objects it didn't touch
 * (`prev.map(v => v.id === id ? { ...v } : v)`). Starring one recording
 * therefore re-evaluates exactly one recording rather than all of them -- the
 * difference between an instant star and a visible hitch on a large library.
 *
 * A WeakMap because rows removed from the library should take their cache entry
 * with them without anything having to remember to evict it.
 */
const CACHE = new WeakMap<
  VideoRow,
  {
    stats: MatchStats | undefined
    towerDiveKills: number | undefined
    value: VideoAchievements | null
  }
>()

/** Evaluates a whole library, skipping unlinked recordings. */
export function buildAchievementsByVideo(
  videos: VideoRow[],
  statsByVideo: Map<number, MatchStats>,
  towerDiveCounts: Map<number, number> | null = null
): Map<number, VideoAchievements> {
  const byVideo = new Map<number, VideoAchievements>()

  for (const video of videos) {
    if (video.match_id === null) continue

    // Stats identity is part of the key: when the bulk stats land for a
    // recording the row hasn't changed, but its achievements have.
    const stats = statsByVideo.get(video.id)
    // A loaded grouped query makes an absent row an authoritative zero. null
    // means the query has not returned yet, so tag-fed rules must stay silent.
    const towerDiveKills =
      towerDiveCounts === null ? undefined : (towerDiveCounts.get(video.id) ?? 0)
    const cached = CACHE.get(video)

    let result: VideoAchievements | null
    if (cached && cached.stats === stats && cached.towerDiveKills === towerDiveKills) {
      result = cached.value
    } else {
      result = evaluateVideoAchievements(
        video,
        parseRoster(video.match_data),
        stats,
        towerDiveKills
      )
      CACHE.set(video, { stats, towerDiveKills, value: result })
    }

    if (result) byVideo.set(video.id, result)
  }

  return byVideo
}
