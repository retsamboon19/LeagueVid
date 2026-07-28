// Types for the match achievement system.
//
// The design splits cleanly into three layers so that tuning never means
// touching detection logic:
//
//   1. facts.ts       - turns a MatchStats payload into plain numbers
//   2. thresholds.ts  - the tunable values, as data
//   3. definitions.ts - rules that compare facts against thresholds
//
// Nothing here fetches anything. Achievements are derived from the MatchStats
// payload the panel has already loaded, so browsing VODs never costs Riot API
// budget.

/**
 * Every number an achievement rule is allowed to look at.
 *
 * `null` means "not available for this match" -- an older game, a field Riot
 * has since dropped, or a stat that needs the timeline when the timeline
 * hasn't been downloaded. Rules must treat null as "cannot evaluate" and NOT
 * as zero, otherwise a match with missing vision data would wrongly earn
 * "placed no control wards".
 */
export interface MatchFacts {
  // --- Context ---
  /** TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY, or '' when unknown. */
  role: string
  durationMinutes: number
  win: boolean
  /** False when the timeline isn't cached; timeline-fed facts will be null. */
  hasTimeline: boolean

  // --- Combat ---
  kills: number
  deaths: number
  assists: number
  /** null on a deathless game -- callers should check `deaths === 0` first. */
  kdaRatio: number | null
  largestMultiKill: number
  largestKillingSpree: number
  /** 0..1. Falls back to a manual calculation when Riot omits the challenge. */
  killParticipation: number | null
  soloKills: number | null
  /** Kills inside the laning phase (first 15 min), from timeline events. */
  earlyKills: number | null
  /** Deaths inside the laning phase. Riot reports no equivalent challenge. */
  earlyDeaths: number | null

  // --- Damage ---
  damageToChampions: number
  /**
   * Null when damage isn't known for this source (see liteFacts.ts). Must be
   * null rather than 0, or the "low damage" rule fires on missing data.
   */
  damagePerMinute: number | null
  /** 0..1 share of the team's total champion damage. */
  teamDamageShare: number | null
  isTopDamageOnTeam: boolean
  damageTaken: number
  damageSelfMitigated: number
  isTopDamageTakenOnTeam: boolean
  timeCCingOthers: number
  /** Most assists on the team, and not tied for it. */
  isTopAssistsOnTeam: boolean

  // --- Economy ---
  cs: number
  csPerMinute: number
  goldEarned: number
  goldPerMinute: number
  /** CS at 10 minutes, from Riot's challenge data. */
  csAt10Min: number | null
  /** Focus CS minus lane opponent CS. null when no lane opponent found. */
  csDiffVsLaneOpponent: number | null
  /** Focus gold minus lane opponent gold at game end. */
  goldDiffVsLaneOpponent: number | null
  /** CS/min over the first 15 min vs. the rest of the game. */
  earlyCsPerMinute: number | null
  midCsPerMinute: number | null

  // --- Objectives and structures ---
  turretKills: number
  damageToTurrets: number
  damageToObjectives: number
  /** Major objectives (dragon/baron/herald) the player took part in. */
  objectiveParticipations: number | null
  /**
   * Major objectives taken by either team all game. Rules that penalise
   * non-participation must check this first -- a 12-minute surrender has no
   * objectives to have missed, and blaming the player for that is wrong.
   */
  majorObjectivesInGame: number | null
  dragonTakedowns: number | null
  baronTakedowns: number | null
  heraldTakedowns: number | null

  // --- Vision ---
  // All nullable: vision is absent from the tile-level data source, and a 0
  // here would wrongly earn "placed no control wards" / "Blind Spot".
  visionScore: number | null
  visionPerMinute: number | null
  wardsPlaced: number
  wardsKilled: number | null
  controlWardsPlaced: number | null
  isTopVisionOnTeam: boolean

  // --- Survival and support ---
  totalTimeSpentDead: number
  /** 0..1 share of the match spent waiting to respawn. Null when unknown. */
  deadTimeShare: number | null
  longestTimeSpentLiving: number
  healsOnTeammates: number
  shieldedOnTeammates: number

  // --- Levels ---
  champLevel: number
  /** Strictly higher than every other player, not merely tied for the lead. */
  isHighestLevelInGame: boolean
  /** Minute at which the player reached their final level. */
  finalLevelReachedAtMinute: number | null

  // --- Team outcome ---
  /** Focus team's total gold minus the enemy team's, at game end. */
  teamGoldDiff: number
  /**
   * Largest gold deficit the focus team faced at any point, as a negative
   * number (0 when never behind). Needs the timeline.
   */
  largestTeamGoldDeficit: number | null
  /** Largest lead the focus team held, as a positive number. */
  largestTeamGoldLead: number | null

  // --- LeagueVid heuristics (estimates, not Riot data) ---
  // See teamfightAnalyzer.ts. Any rule using these must set isEstimate.
  duelCount: number
  duelWinRate: number | null
  teamfightCount: number
  teamfightWinRate: number | null
  teamfightParticipation: number | null
  soloDeaths: number | null
  /** Solo kills landed under a standing enemy turret (tower dives). */
  towerDiveKills: number | null
}

export type AchievementCategory = 'positive' | 'negative'

/**
 * Groups exist to suppress redundant tiles. Two rules in the same group
 * measure the same underlying thing, so only the highest-priority one that
 * fired is shown -- e.g. "Flawless" (0 deaths) hides "Survivor" (<=2 deaths).
 */
export type AchievementGroup =
  | 'deaths'
  | 'multikill'
  | 'kill_volume'
  | 'solo_combat'
  | 'damage'
  | 'farming'
  | 'lane_economy'
  | 'gold_rate'
  | 'structures'
  | 'objectives'
  | 'vision_provided'
  | 'vision_denied'
  | 'control_wards'
  | 'support_utility'
  | 'participation'
  | 'outcome'
  | 'levels'
  | 'tanking'
  | 'longevity'
  | 'kda'

export interface AchievementDefinition {
  /** Stable id. Persisted/filtered against, so never rename in place. */
  id: string
  title: string
  category: AchievementCategory
  group: AchievementGroup
  /**
   * Higher wins when trimming to the display cap. Rough scale:
   *   90-100  rare and match-defining (pentakill, perfect game, comeback)
   *   70-89   strong, uncommon
   *   40-69   solid but routine
   *   1-39    filler, only shown when little else qualified
   */
  priority: number
  /** Icon key resolved to a component in AchievementsTab. */
  icon: string
  /** True when the rule leans on LeagueVid's estimates rather than Riot data. */
  isEstimate?: boolean
  /**
   * Routine observation rather than an accomplishment, held in reserve and
   * only pulled in when a panel would otherwise fall below
   * THRESHOLDS.display.minTotal.
   *
   * Fillers exist because an unremarkable game genuinely qualifies for very
   * little, and a panel with one tile looks broken rather than honest. Their
   * bars sit around the median instead of the p90, so they stay factually
   * true -- they just describe the game rather than praise it. A filler can
   * never displace a real achievement.
   */
  isFiller?: boolean
  /**
   * Whether the achievement applies. Must return false (not throw) when a
   * needed fact is null.
   */
  condition: (facts: MatchFacts, thresholds: Thresholds) => boolean
  /** One-line description. Should include the number that earned it. */
  describe: (facts: MatchFacts) => string
}

export interface EarnedAchievement {
  id: string
  title: string
  description: string
  category: AchievementCategory
  group: AchievementGroup
  priority: number
  icon: string
  isEstimate: boolean
  isFiller: boolean
}

export interface SelectedAchievements {
  positive: EarnedAchievement[]
  negative: EarnedAchievement[]
  /** Everything that qualified, before the display cap trimmed it down. */
  totalEarned: number
  /** Real (non-filler) achievements that qualified, for diagnostics. */
  standoutCount: number
}

/** Per-role values for stats where a flat number would be meaningless. */
export interface RoleScaled {
  TOP: number
  JUNGLE: number
  MIDDLE: number
  BOTTOM: number
  UTILITY: number
  /** Used when the role is unknown or a mode has no positions (ARAM). */
  DEFAULT: number
}

export type Thresholds = typeof import('./thresholds').THRESHOLDS
