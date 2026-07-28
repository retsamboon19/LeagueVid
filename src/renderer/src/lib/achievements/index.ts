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
export { evaluateAchievements, selectAchievements } from './evaluate'
export { ACHIEVEMENTS } from './definitions'
export { THRESHOLDS, forRole } from './thresholds'
export type {
  AchievementCategory,
  AchievementDefinition,
  AchievementGroup,
  EarnedAchievement,
  MatchFacts,
  RoleScaled,
  SelectedAchievements,
  Thresholds
} from './types'
