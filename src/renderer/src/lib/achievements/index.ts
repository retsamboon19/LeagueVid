// Public surface of the achievement system.
//
// Typical use from a view:
//
//   const facts = buildMatchFacts({ stats, focus, tags })
//   const { positive, negative } = selectAchievements(facts)
//
// Thresholds are exported so a settings screen (or a test) can pass a tuned
// copy without editing the defaults.

export { buildMatchFacts } from './facts'
export { buildLiteMatchFacts } from './liteFacts'
export {
  dedupeEarnedByGroup,
  evaluateAchievements,
  selectAchievements,
  selectFromEarned,
  type SelectOptions
} from './evaluate'
export { ACHIEVEMENTS } from './definitions'
export { THRESHOLDS, forRole } from './thresholds'
export {
  TIER_META,
  TIER_ORDER,
  byTierThenPriority,
  tierForDefinition,
  tierForPriority,
  type TierMeta
} from './tiers'
export type {
  AchievementCategory,
  AchievementDefinition,
  AchievementGroup,
  AchievementTier,
  EarnedAchievement,
  MatchFacts,
  RoleScaled,
  SelectedAchievements,
  Thresholds
} from './types'
