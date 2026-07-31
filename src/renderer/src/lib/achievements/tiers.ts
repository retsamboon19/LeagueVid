import { THRESHOLDS } from './thresholds'
import type { AchievementDefinition, AchievementTier, Thresholds } from './types'

// Rarity bands, and where they come from.
//
// A tier is not a fourth piece of rule data -- it's a reading of `priority`,
// which thresholds.ts already calibrated against measured firing rates. Keeping
// it derived means there is exactly one number to tune per rule, and the badge
// can never contradict the order the tiles are shown in.
//
// A rule may still override its band explicitly (AchievementDefinition.tier)
// for the case where display order and rarity genuinely disagree. Nothing needs
// that today.

/** Rarest first. The order tier sections are rendered in. */
export const TIER_ORDER: readonly AchievementTier[] = ['SSR', 'S', 'R'] as const

export interface TierMeta {
  tier: AchievementTier
  /** Badge text. */
  label: string
  /** Longer name for section headings. */
  name: string
  /**
   * One line for the catalog legend. Describes how hard the band is to reach
   * in relative terms only -- no thresholds, same rule as a definition's hint.
   */
  blurb: string
}

// Copy is deliberately about rarity alone, not about a game going well. Tiers
// apply to the "things to improve" rules too -- a thrown lead is as rare as a
// pentakill -- so a heading like "games that get talked about afterwards" would
// end up sitting above a criticism. The flash does the celebrating instead, and
// it's applied only to positives (see global.css).
export const TIER_META: Record<AchievementTier, TierMeta> = {
  SSR: {
    tier: 'SSR',
    label: 'SSR',
    name: 'SSR \u2014 rarest',
    blurb: 'Turns up in very few games.'
  },
  S: {
    tier: 'S',
    label: 'S',
    name: 'S \u2014 uncommon',
    blurb: 'Stands out from the run of your usual games.'
  },
  R: {
    tier: 'R',
    label: 'R',
    name: 'R \u2014 common',
    blurb: 'A regular part of how a game goes.'
  }
}

/** The band a priority value falls into. */
export function tierForPriority(
  priority: number,
  thresholds: Thresholds = THRESHOLDS
): AchievementTier {
  if (priority >= thresholds.tiers.ssr) return 'SSR'
  if (priority >= thresholds.tiers.s) return 'S'
  return 'R'
}

/** A definition's band: its explicit override, else derived from priority. */
export function tierForDefinition(
  def: Pick<AchievementDefinition, 'priority' | 'tier'>,
  thresholds: Thresholds = THRESHOLDS
): AchievementTier {
  return def.tier ?? tierForPriority(def.priority, thresholds)
}

/**
 * Sorts rarest-first, then by priority within a band.
 *
 * Tier alone is too coarse to order a list by -- a band holds a dozen rules --
 * so priority still breaks the tie, which keeps the ordering identical to the
 * untiered lists elsewhere in the app.
 */
export function byTierThenPriority(
  a: { tier: AchievementTier; priority: number },
  b: { tier: AchievementTier; priority: number }
): number {
  const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
  return tierDiff !== 0 ? tierDiff : b.priority - a.priority
}
