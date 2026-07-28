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
    isEstimate: def.isEstimate ?? false,
    isFiller: def.isFiller ?? false
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
export interface SelectOptions {
  /**
   * Whether the filler tier may pad a thin result out to minTotal.
   *
   * True (default) for the player page's Achievements panel, where a nearly
   * empty tab looks broken. False for the library's match-tile chips, where
   * space is tight and a chip has to earn its place -- with fillers on, more
   * than half of all tiles led with a routine observation.
   */
  includeFillers?: boolean
}

export function selectAchievements(
  facts: MatchFacts,
  thresholds: Thresholds = THRESHOLDS,
  definitions: AchievementDefinition[] = ACHIEVEMENTS,
  options: SelectOptions = {}
): SelectedAchievements {
  const { includeFillers = true } = options
  const all = evaluateAchievements(facts, thresholds, definitions)

  const byCategory = (category: AchievementCategory, filler: boolean): EarnedAchievement[] =>
    dedupeByGroup(all.filter((a) => a.category === category && a.isFiller === filler)).sort(
      byPriorityDesc
    )

  // Real achievements are deduped per category, so a group holding both a good
  // and a bad rule (e.g. `farming`) can still contribute to each side. The
  // conditions themselves are mutually exclusive, so this can't double up.
  const positives = byCategory('positive', false)
  const negatives = byCategory('negative', false)

  const { maxTotal, minTotal, maxNegativeWhenWinning, maxNegativeWhenLosing, minPositive } =
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
    chosenPositives.push(
      ...positives.slice(chosenPositives.length, chosenPositives.length + leftover)
    )
  }

  const standoutCount = chosenPositives.length + chosenNegatives.length

  // Top up to minTotal from the filler tier. Fillers are added strictly after
  // real achievements and never displace one, so a strong game never shows a
  // routine tile while a quiet game still has enough to read as a summary.
  //
  // Groups already represented are skipped: "Farm Machine" and "Kept Farming"
  // both describe the same farming, and showing both looks like padding.
  if (includeFillers && standoutCount < minTotal) {
    const usedGroups = new Set(
      [...chosenPositives, ...chosenNegatives].map((a) => a.group)
    )
    const fillers = byCategory('positive', true).filter((a) => !usedGroups.has(a.group))

    for (const filler of fillers) {
      if (chosenPositives.length + chosenNegatives.length >= minTotal) break
      if (usedGroups.has(filler.group)) continue
      usedGroups.add(filler.group)
      chosenPositives.push(filler)
    }
  }

  return {
    positive: chosenPositives,
    negative: chosenNegatives,
    totalEarned: positives.length + negatives.length,
    standoutCount
  }
}
