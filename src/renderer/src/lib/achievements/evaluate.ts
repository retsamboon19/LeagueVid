import { ACHIEVEMENTS } from './definitions'
import { THRESHOLDS } from './thresholds'
import type {
  AchievementCategory,
  AchievementDefinition,
  EarnedAchievement,
  MatchFacts,
  SelectedAchievements,
  Thresholds
} from './types'

// Evaluates the rule set against one match, then trims the result down to what
// the panel can actually show.
//
// Trimming matters as much as detection: a good game easily qualifies for a
// dozen achievements, and showing all of them turns a highlight reel into a
// stat dump. Selection therefore does three things:
//
//   1. drops redundant tiles (same `group` -- Flawless hides Survivor)
//   2. keeps a sensible positive/negative mix rather than a wall of criticism
//   3. sorts by priority so rare achievements outrank routine ones
//
// A rule throwing would break the whole tab, so each condition is evaluated
// defensively -- a buggy rule loses its tile instead of the panel.

function toEarned(def: AchievementDefinition, facts: MatchFacts): EarnedAchievement {
  return {
    id: def.id,
    title: def.title,
    description: def.describe(facts),
    category: def.category,
    group: def.group,
    priority: def.priority,
    icon: def.icon,
    isEstimate: def.isEstimate ?? false
  }
}

/** Every achievement whose condition holds, unsorted and untrimmed. */
export function evaluateAchievements(
  facts: MatchFacts,
  thresholds: Thresholds = THRESHOLDS,
  definitions: AchievementDefinition[] = ACHIEVEMENTS
): EarnedAchievement[] {
  const earned: EarnedAchievement[] = []

  for (const def of definitions) {
    try {
      if (def.condition(facts, thresholds)) earned.push(toEarned(def, facts))
    } catch {
      // A rule reading a fact shape it didn't expect shouldn't take the tab
      // down with it. Skip it silently and carry on.
      continue
    }
  }

  return earned
}

/** Highest-priority entry per group, preserving input order otherwise. */
function dedupeByGroup(list: EarnedAchievement[]): EarnedAchievement[] {
  const best = new Map<string, EarnedAchievement>()
  for (const item of list) {
    const existing = best.get(item.group)
    if (!existing || item.priority > existing.priority) best.set(item.group, item)
  }
  return [...best.values()]
}

function byPriorityDesc(a: EarnedAchievement, b: EarnedAchievement): number {
  return b.priority - a.priority
}

/**
 * Picks what to display, honouring the caps in THRESHOLDS.display.
 *
 * Negatives are capped lower on a win than a loss: a won game with four
 * criticisms reads as nagging, while a heavy loss genuinely has more worth
 * pointing at. The positive floor works the other way -- even a bad game
 * should surface something that went right, if anything qualified.
 */
export function selectAchievements(
  facts: MatchFacts,
  thresholds: Thresholds = THRESHOLDS,
  definitions: AchievementDefinition[] = ACHIEVEMENTS
): SelectedAchievements {
  const all = evaluateAchievements(facts, thresholds, definitions)

  const fallbackIds = new Set(
    definitions.filter((d) => d.isFallback).map((d) => d.id)
  )
  const isFallback = (a: EarnedAchievement): boolean => fallbackIds.has(a.id)

  // Dedupe positives and negatives separately, so a group with both a good
  // and a bad rule (e.g. `farming`) can still contribute to each side. The
  // conditions themselves are mutually exclusive, so this can't double up.
  //
  // Fallbacks are held back and only spliced in when their category came up
  // empty, so they never displace a real achievement.
  const rank = (category: AchievementCategory): EarnedAchievement[] => {
    const matching = all.filter((a) => a.category === category)
    const real = dedupeByGroup(matching.filter((a) => !isFallback(a))).sort(byPriorityDesc)
    if (real.length > 0) return real
    return dedupeByGroup(matching.filter(isFallback)).sort(byPriorityDesc)
  }

  const positives = rank('positive')
  const negatives = rank('negative')

  const { maxTotal, maxNegativeWhenWinning, maxNegativeWhenLosing, minPositive } =
    thresholds.display

  const negativeCap = facts.win ? maxNegativeWhenWinning : maxNegativeWhenLosing

  // Reserve room for positives first, then fill the rest with negatives, then
  // top back up with positives if negatives didn't use their allowance.
  const positiveRoom = Math.max(minPositive, maxTotal - negativeCap)
  const chosenPositives = positives.slice(0, Math.min(positiveRoom, maxTotal))

  const negativeRoom = Math.min(negativeCap, maxTotal - chosenPositives.length)
  const chosenNegatives = negatives.slice(0, Math.max(0, negativeRoom))

  const leftover = maxTotal - chosenPositives.length - chosenNegatives.length
  if (leftover > 0) {
    chosenPositives.push(...positives.slice(chosenPositives.length, chosenPositives.length + leftover))
  }

  return {
    positive: chosenPositives,
    negative: chosenNegatives,
    totalEarned: positives.length + negatives.length
  }
}
