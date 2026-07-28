import { forRole } from './thresholds'
import type { AchievementDefinition } from './types'

// The achievement rules, as data.
//
// Every entry is a `condition` (does this apply?) plus a `describe` (what does
// the tile say?). No thresholds are written inline -- they all come from
// thresholds.ts, so tuning is a one-line edit there and never touches logic
// here.
//
// Conventions:
//   - `condition` must return false when a needed fact is null, never throw.
//   - `describe` should always include the number that earned it. "You cleared
//     11 wards" reads as earned; "Good vision!" reads as filler.
//   - Rules sharing a `group` are mutually exclusive at display time; the
//     highest-priority one wins. That's how Flawless suppresses Survivor.
//   - Set `isEstimate` for anything reading LeagueVid's heuristics, so the UI
//     can mark it the way the Insights tab already does.
//
// This is a starter set covering each category. Expanding it means appending
// entries, not restructuring anything.

const n = (value: number): string => Math.round(value).toLocaleString()
const one = (value: number): string => value.toFixed(1)
const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`

export const ACHIEVEMENTS: AchievementDefinition[] = [
  // ---------------------------------------------------------------- positive
  // --- Multikills -----------------------------------------------------------
  {
    id: 'penta_kill',
    title: 'Pentakill',
    category: 'positive',
    group: 'multikill',
    priority: 100,
    icon: 'flame',
    condition: (f) => f.largestMultiKill >= 5,
    describe: () => 'Five kills, one fight. The whole enemy team, gone.'
  },
  {
    id: 'quadra_kill',
    title: 'Quadra Kill',
    category: 'positive',
    group: 'multikill',
    priority: 92,
    icon: 'flame',
    condition: (f) => f.largestMultiKill === 4,
    describe: () => 'Four in a single fight. One away from the big one.'
  },
  // Deliberately no double or triple kill tile. Calibration showed a double
  // kill in 23% of games and it became the fourth most-shown positive, which
  // is participation-trophy territory -- it crowded out tiles that actually
  // said something about the game. Multikills only earn a tile from a quadra
  // upward, where they're genuinely uncommon (0.5% and 0.2% respectively).
  // Every multikill is still bookmarked on the video timeline and in the
  // Highlights strip, which is where finding the moment matters.

  // --- Combat ---------------------------------------------------------------
  {
    id: 'tower_diver',
    title: 'Tower Diver',
    category: 'positive',
    group: 'solo_combat',
    priority: 88,
    icon: 'tower',
    condition: (f, t) =>
      f.towerDiveKills !== null && f.towerDiveKills >= t.combat.towerDives,
    describe: (f) =>
      f.towerDiveKills === 1
        ? 'You went under their turret and killed them anyway.'
        : `You landed ${f.towerDiveKills} solo kills under enemy turrets.`
  },
  {
    id: 'solo_slayer',
    title: 'Solo Slayer',
    category: 'positive',
    group: 'solo_combat',
    priority: 78,
    icon: 'sword',
    condition: (f, t) => f.soloKills !== null && f.soloKills >= t.combat.soloKills,
    describe: (f) => `No help needed. ${f.soloKills} kills entirely on your own.`
  },
  {
    id: 'duelist',
    title: 'Master Duelist',
    category: 'positive',
    group: 'solo_combat',
    priority: 70,
    icon: 'sword',
    isEstimate: true,
    condition: (f, t) =>
      f.duelWinRate !== null &&
      f.duelCount >= t.combat.duelMinSample &&
      f.duelWinRate >= t.combat.duelWinRate,
    describe: (f) =>
      `You won about ${pct(f.duelWinRate ?? 0)} of your ${f.duelCount} one-on-one fights.`
  },
  {
    id: 'killing_spree',
    title: 'Unstoppable',
    category: 'positive',
    group: 'kill_volume',
    priority: 82,
    icon: 'zap',
    condition: (f, t) => f.largestKillingSpree >= t.combat.killingSpree,
    describe: (f) => `You strung together ${f.largestKillingSpree} kills without dying once.`
  },
  {
    id: 'carnage',
    title: 'Bringer of Carnage',
    category: 'positive',
    group: 'kill_volume',
    priority: 74,
    icon: 'skull',
    condition: (f, t) => f.kills >= t.combat.highKills,
    describe: (f) => `Destruction follows you around. ${f.kills} kills this game.`
  },
  {
    id: 'early_aggressor',
    title: 'Early Aggressor',
    category: 'positive',
    group: 'kill_volume',
    priority: 60,
    icon: 'sunrise',
    condition: (f, t) => f.earlyKills !== null && f.earlyKills >= t.combat.earlyKills,
    describe: (f) => `You were already ahead early, with ${f.earlyKills} kills inside the laning phase.`
  },
  {
    id: 'crowd_control',
    title: 'Lockdown Artist',
    category: 'positive',
    group: 'damage',
    priority: 52,
    icon: 'snowflake',
    condition: (f, t) => f.timeCCingOthers >= forRole(t.combat.ccSeconds, f.role),
    describe: (f) => `You held enemies still for ${n(f.timeCCingOthers)} seconds in total.`
  },

  // --- Damage ---------------------------------------------------------------
  {
    id: 'damage_dealer',
    title: 'Ouch You Hurt',
    category: 'positive',
    group: 'damage',
    priority: 72,
    icon: 'flame',
    condition: (f, t) => f.damageToChampions >= forRole(t.damage.highDamage, f.role),
    describe: (f) => `You did tons of damage, ${n(f.damageToChampions)} to be exact.`
  },
  {
    id: 'team_carry_damage',
    title: 'Damage Leader',
    category: 'positive',
    group: 'damage',
    priority: 68,
    icon: 'crosshair',
    condition: (f, t) =>
      f.isTopDamageOnTeam &&
      f.teamDamageShare !== null &&
      f.teamDamageShare >= t.damage.teamDamageShare,
    describe: (f) => `You dealt ${pct(f.teamDamageShare ?? 0)} of your team's damage, more than anyone else on it.`
  },
  {
    id: 'iron_wall',
    title: 'Iron Wall',
    category: 'positive',
    group: 'tanking',
    priority: 64,
    icon: 'shield',
    condition: (f, t) =>
      f.damageSelfMitigated >= t.survival.selfMitigated &&
      f.deaths <= forRole(t.survival.fewDeaths, f.role) + 2,
    describe: (f) => `You absorbed ${n(f.damageSelfMitigated)} damage and still only died ${f.deaths} times.`
  },
  {
    id: 'frontline',
    title: 'Frontline',
    category: 'positive',
    group: 'tanking',
    priority: 48,
    icon: 'shield',
    condition: (f) => f.isTopDamageTakenOnTeam && f.win,
    describe: (f) => `You soaked up the most damage on your team, ${n(f.damageTaken)} of it, and still won.`
  },

  // --- Farming and economy --------------------------------------------------
  {
    id: 'cs_machine',
    title: 'Farm Machine',
    category: 'positive',
    group: 'farming',
    priority: 66,
    icon: 'wheat',
    condition: (f, t) => f.csPerMinute >= forRole(t.farming.strongCsPerMinute, f.role),
    describe: (f) => `${one(f.csPerMinute)} CS per minute, ${n(f.cs)} in total.`
  },
  {
    id: 'never_slacking',
    title: 'Never Slacking',
    category: 'positive',
    group: 'farming',
    priority: 58,
    icon: 'wheat',
    condition: (f, t) =>
      f.earlyCsPerMinute !== null &&
      f.midCsPerMinute !== null &&
      f.earlyCsPerMinute - f.midCsPerMinute <= t.farming.consistentDropoff,
    describe: (f) =>
      `You farmed harder after laning, ${one(f.earlyCsPerMinute ?? 0)} up to ${one(f.midCsPerMinute ?? 0)} CS per minute. ${n(f.cs)} in total.`
  },
  {
    id: 'early_farmer',
    title: 'Early Game Farmer',
    category: 'positive',
    group: 'farming',
    priority: 56,
    icon: 'sunrise',
    condition: (f, t) => f.csAt10Min !== null && f.csAt10Min >= forRole(t.farming.strongCsAt10, f.role),
    describe: (f) => `You hit ${n(f.csAt10Min ?? 0)} CS in the first 10 minutes.`
  },
  {
    id: 'lane_dominator',
    title: 'Lane Dominator',
    category: 'positive',
    group: 'lane_economy',
    priority: 76,
    icon: 'trending-up',
    condition: (f, t) =>
      f.goldDiffVsLaneOpponent !== null && f.goldDiffVsLaneOpponent >= t.farming.goldLead,
    describe: (f) => `You finished ${n(f.goldDiffVsLaneOpponent ?? 0)} gold ahead of your lane opponent.`
  },
  {
    id: 'out_farmed_them',
    title: 'Out-Farmed Them',
    category: 'positive',
    group: 'lane_economy',
    priority: 54,
    icon: 'wheat',
    condition: (f, t) =>
      f.csDiffVsLaneOpponent !== null &&
      f.csDiffVsLaneOpponent >= forRole(t.farming.csLead, f.role),
    describe: (f) => `You out-farmed your lane opponent by ${n(f.csDiffVsLaneOpponent ?? 0)} CS.`
  },
  {
    id: 'gold_hoarder',
    title: 'Goblin Hoarder',
    category: 'positive',
    group: 'gold_rate',
    priority: 50,
    icon: 'coins',
    condition: (f, t) => f.goldPerMinute >= forRole(t.farming.goldPerMinute, f.role),
    describe: (f) => `You made so much gold this game, about ${n(f.goldPerMinute)} per minute.`
  },

  // --- Objectives and structures -------------------------------------------
  {
    id: 'wrecking_ball',
    title: 'Wrecking Ball',
    category: 'positive',
    group: 'structures',
    priority: 62,
    icon: 'hammer',
    condition: (f, t) => f.damageToTurrets >= t.objectives.turretDamage,
    describe: (f) =>
      `You definitely have your priorities straight. ${n(f.damageToTurrets)} damage to structures.`
  },
  {
    id: 'tower_taker',
    title: 'Siege Master',
    category: 'positive',
    group: 'structures',
    priority: 58,
    icon: 'hammer',
    condition: (f, t) => f.turretKills >= t.objectives.turretKills,
    describe: (f) => `You personally took down ${f.turretKills} turrets.`
  },
  {
    id: 'objective_hunter',
    title: 'Objective Hunter',
    category: 'positive',
    group: 'objectives',
    priority: 65,
    icon: 'target',
    condition: (f, t) =>
      f.objectiveParticipations !== null &&
      f.objectiveParticipations >= t.objectives.participations,
    describe: (f) => `You showed up for ${f.objectiveParticipations} major objectives.`
  },
  {
    id: 'dragon_tamer',
    title: 'Dragon Tamer',
    category: 'positive',
    group: 'objectives',
    priority: 57,
    icon: 'target',
    condition: (f, t) =>
      f.dragonTakedowns !== null &&
      f.dragonTakedowns >= forRole(t.objectives.dragonTakedowns, f.role),
    describe: (f) => `You were there for ${f.dragonTakedowns} dragon takedowns.`
  },
  {
    id: 'baron_slayer',
    title: 'Baron Slayer',
    category: 'positive',
    group: 'objectives',
    priority: 53,
    icon: 'crown',
    condition: (f, t) =>
      f.baronTakedowns !== null && f.baronTakedowns >= t.objectives.baronTakedowns,
    describe: (f) => `You were in on ${f.baronTakedowns} Baron takedowns.`
  },

  // --- Vision ---------------------------------------------------------------
  {
    id: 'ward_hunter',
    title: 'Servant of Darkness',
    category: 'positive',
    group: 'vision_denied',
    priority: 61,
    icon: 'eye-off',
    condition: (f, t) =>
      f.wardsKilled !== null && f.wardsKilled >= forRole(t.vision.wardsKilled, f.role),
    describe: (f) => `Enemy wards aren't safe when you're around. You cleared ${f.wardsKilled} of them.`
  },
  {
    id: 'visionary',
    title: 'Visionary',
    category: 'positive',
    group: 'vision_provided',
    priority: 59,
    icon: 'eye',
    condition: (f, t) =>
      f.isTopVisionOnTeam &&
      f.visionScore !== null &&
      f.visionScore >= forRole(t.vision.strongVisionScore, f.role),
    describe: (f) => `Best vision score on your team at ${n(f.visionScore ?? 0)}.`
  },
  {
    id: 'ward_provider',
    title: 'Eyes Everywhere',
    category: 'positive',
    group: 'vision_provided',
    priority: 46,
    icon: 'eye',
    condition: (f, t) => f.wardsPlaced >= forRole(t.vision.wardsPlaced, f.role),
    describe: (f) => `You put down ${f.wardsPlaced} wards for your team.`
  },
  {
    id: 'control_freak',
    title: 'Control Freak',
    category: 'positive',
    group: 'control_wards',
    priority: 47,
    icon: 'eye',
    condition: (f, t) =>
      f.controlWardsPlaced !== null &&
      f.controlWardsPlaced >= forRole(t.vision.controlWards, f.role),
    describe: (f) => `${f.controlWardsPlaced} control wards. Denying vision is winning vision.`
  },

  // --- Survival -------------------------------------------------------------
  {
    id: 'flawless',
    title: 'Flawless',
    category: 'positive',
    group: 'deaths',
    priority: 90,
    icon: 'sparkles',
    condition: (f) => f.deaths === 0,
    describe: (f) => `Not a single death. ${f.kills}/${f.deaths}/${f.assists} on the board.`
  },
  {
    id: 'survivor',
    title: 'Survivor',
    category: 'positive',
    group: 'deaths',
    priority: 63,
    icon: 'heart',
    condition: (f, t) => f.deaths > 0 && f.deaths <= forRole(t.survival.fewDeaths, f.role),
    describe: (f) => `Hard to pin down. You only died ${f.deaths} times all game.`
  },
  {
    id: 'untouchable',
    title: 'Untouchable',
    category: 'positive',
    group: 'deaths',
    priority: 51,
    icon: 'heart',
    condition: (f, t) => f.longestTimeSpentLiving >= t.survival.longestLifeSeconds,
    describe: (f) =>
      `You went ${Math.round(f.longestTimeSpentLiving / 60)} minutes straight without dying.`
  },

  // --- Support and utility --------------------------------------------------
  {
    id: 'medic',
    title: 'Field Medic',
    category: 'positive',
    group: 'support_utility',
    priority: 60,
    icon: 'heart-pulse',
    condition: (f, t) => f.healsOnTeammates >= t.support.healsOnTeammates,
    describe: (f) => `You healed your teammates for ${n(f.healsOnTeammates)} across the game.`
  },
  {
    id: 'guardian',
    title: 'Guardian',
    category: 'positive',
    group: 'support_utility',
    priority: 59,
    icon: 'shield',
    condition: (f, t) => f.shieldedOnTeammates >= t.support.shieldedOnTeammates,
    describe: (f) => `You shielded your teammates for ${n(f.shieldedOnTeammates)} damage.`
  },
  {
    id: 'assist_king',
    title: 'Enabler',
    category: 'positive',
    group: 'support_utility',
    priority: 55,
    icon: 'users',
    condition: (f, t) =>
      f.isTopAssistsOnTeam && f.assists >= forRole(t.support.topAssistsMin, f.role),
    describe: (f) => `${f.assists} assists, more than anyone else on your team.`
  },
  {
    id: 'team_player',
    title: 'Team Player',
    category: 'positive',
    group: 'participation',
    priority: 67,
    icon: 'users',
    condition: (f, t) =>
      f.killParticipation !== null &&
      f.killParticipation >= forRole(t.combat.highKillParticipation, f.role),
    describe: (f) => `You were in on ${pct(f.killParticipation ?? 0)} of your team's kills.`
  },
  {
    id: 'fight_anchor',
    title: 'Fight Anchor',
    category: 'positive',
    group: 'participation',
    priority: 64,
    icon: 'users',
    isEstimate: true,
    condition: (f, t) =>
      f.teamfightParticipation !== null &&
      f.teamfightCount >= t.combat.teamfightMinSample &&
      f.teamfightParticipation >= forRole(t.combat.teamfightParticipation, f.role),
    describe: (f) =>
      `You turned up for about ${pct(f.teamfightParticipation ?? 0)} of the ${f.teamfightCount} teamfights.`
  },

  // --- Match outcome --------------------------------------------------------
  {
    id: 'comeback_king',
    title: 'Comeback King',
    category: 'positive',
    group: 'outcome',
    priority: 95,
    icon: 'crown',
    condition: (f, t) =>
      f.win &&
      f.largestTeamGoldDeficit !== null &&
      f.largestTeamGoldDeficit <= -t.outcome.comebackDeficit,
    describe: (f) =>
      `Down ${n(Math.abs(f.largestTeamGoldDeficit ?? 0))} gold at the worst point, and you still won it.`
  },
  {
    id: 'stomp',
    title: 'Stomp',
    category: 'positive',
    group: 'outcome',
    priority: 70,
    icon: 'trending-up',
    condition: (f, t) => f.win && f.teamGoldDiff >= t.outcome.stompGoldDiff,
    describe: (f) => `Your team ran away with it, winning by ${n(f.teamGoldDiff)} gold.`
  },
  {
    id: 'most_experienced',
    title: 'Most Experienced Player',
    category: 'positive',
    group: 'levels',
    priority: 45,
    icon: 'award',
    condition: (f) => f.isHighestLevelInGame,
    describe: (f) =>
      f.finalLevelReachedAtMinute !== null
        ? `Highest level in the game. You hit ${f.champLevel} in ${f.finalLevelReachedAtMinute} minutes.`
        : `Highest level in the game, reaching ${f.champLevel}.`
  },

  // --- Filler tier ----------------------------------------------------------
  // Held in reserve and only used to pad a panel up to display.minTotal (see
  // isFiller). An unremarkable game qualifies for very little, and a one-tile
  // panel looks broken rather than honest -- but the answer can't be to lower
  // the real bars, or every game becomes a participation trophy.
  //
  // These are worded as descriptions rather than praise, and their bars sit
  // around the measured median, so they stay true. `gold_summary` is
  // unconditional and acts as the guaranteed floor.
  {
    id: 'win_secured',
    title: 'Got It Done',
    category: 'positive',
    group: 'outcome',
    priority: 30,
    icon: 'trophy',
    isFiller: true,
    condition: (f) => f.win,
    describe: (f) =>
      `Not your cleanest game, but you closed it out. ${f.kills}/${f.deaths}/${f.assists} in ${Math.round(f.durationMinutes)} minutes.`
  },
  {
    id: 'decent_kda',
    title: 'Traded Well',
    category: 'positive',
    group: 'kda',
    priority: 28,
    icon: 'swords',
    isFiller: true,
    condition: (f, t) => f.kdaRatio !== null && f.kdaRatio >= t.filler.decentKda,
    describe: (f) =>
      `A ${(f.kdaRatio ?? 0).toFixed(1)} KDA at ${f.kills}/${f.deaths}/${f.assists}. You came out ahead on trades.`
  },
  {
    id: 'objective_presence',
    title: 'Showed Up',
    category: 'positive',
    group: 'objectives',
    priority: 26,
    icon: 'target',
    isFiller: true,
    condition: (f) => f.objectiveParticipations !== null && f.objectiveParticipations >= 1,
    describe: (f) =>
      `You were in on ${f.objectiveParticipations} major ${f.objectiveParticipations === 1 ? 'objective' : 'objectives'}.`
  },
  {
    id: 'steady_farm',
    title: 'Kept Farming',
    category: 'positive',
    group: 'farming',
    priority: 24,
    icon: 'wheat',
    isFiller: true,
    condition: (f, t) => f.csPerMinute >= forRole(t.filler.steadyCsPerMinute, f.role),
    describe: (f) => `A steady ${one(f.csPerMinute)} CS per minute, ${n(f.cs)} in total.`
  },
  {
    id: 'fair_damage_share',
    title: 'Pulled Your Weight',
    category: 'positive',
    group: 'damage',
    priority: 22,
    icon: 'crosshair',
    isFiller: true,
    condition: (f, t) =>
      f.teamDamageShare !== null && f.teamDamageShare >= t.filler.fairDamageShare,
    describe: (f) =>
      `${n(f.damageToChampions)} damage to champions, ${pct(f.teamDamageShare ?? 0)} of your team's total.`
  },
  {
    id: 'soaked_pressure',
    title: 'Took the Hits',
    category: 'positive',
    group: 'tanking',
    priority: 20,
    icon: 'shield',
    isFiller: true,
    condition: (f, t) => f.damageTaken >= t.filler.someDamageTaken,
    describe: (f) => `You absorbed ${n(f.damageTaken)} damage over the game.`
  },
  {
    id: 'structure_chip',
    title: 'Chipped In',
    category: 'positive',
    group: 'structures',
    priority: 18,
    icon: 'hammer',
    isFiller: true,
    condition: (f, t) => f.damageToTurrets >= t.filler.someStructureDamage,
    describe: (f) => `${n(f.damageToTurrets)} damage to enemy structures.`
  },
  {
    id: 'some_vision',
    title: 'Eyes Out',
    category: 'positive',
    group: 'vision_provided',
    priority: 16,
    icon: 'eye',
    isFiller: true,
    condition: (f, t) =>
      f.visionScore !== null && f.wardsPlaced >= forRole(t.filler.someWards, f.role),
    describe: (f) => `${f.wardsPlaced} wards placed, for a ${n(f.visionScore ?? 0)} vision score.`
  },
  {
    id: 'held_on',
    title: 'Held On',
    category: 'positive',
    group: 'longevity',
    priority: 14,
    icon: 'heart',
    isFiller: true,
    condition: (f, t) => f.longestTimeSpentLiving >= t.filler.decentLongestLife,
    describe: (f) =>
      `Your longest run without dying was ${Math.round(f.longestTimeSpentLiving / 60)} minutes.`
  },
  {
    id: 'took_fights',
    title: 'In the Mix',
    category: 'positive',
    group: 'participation',
    priority: 12,
    icon: 'users',
    isFiller: true,
    condition: (f, t) =>
      f.killParticipation !== null && f.killParticipation >= t.filler.someKillParticipation,
    describe: (f) => `You had a hand in ${pct(f.killParticipation ?? 0)} of your team's kills.`
  },
  {
    id: 'even_lane',
    title: 'Even Lane',
    category: 'positive',
    group: 'lane_economy',
    priority: 10,
    icon: 'wheat',
    isFiller: true,
    condition: (f, t) =>
      f.csDiffVsLaneOpponent !== null &&
      Math.abs(f.csDiffVsLaneOpponent) <= t.filler.evenLaneCsMargin,
    describe: (f) =>
      `You and your lane opponent finished within ${Math.abs(f.csDiffVsLaneOpponent ?? 0)} CS of each other.`
  },
  {
    id: 'gold_summary',
    title: 'Banked It',
    category: 'positive',
    group: 'gold_rate',
    priority: 8,
    icon: 'coins',
    isFiller: true,
    // Unconditional: the guaranteed floor that keeps minTotal reachable even
    // in a short, uneventful game where nothing else applies.
    condition: () => true,
    describe: (f) =>
      `${n(f.goldEarned)} gold earned, about ${n(f.goldPerMinute)} per minute.`
  },

  // ---------------------------------------------------------------- negative
  // Tone matters here: these read as observations, not insults. They belong
  // under a "Things to improve" heading, the way the reference layout does.
  {
    id: 'rough_game',
    title: 'Rough Game',
    category: 'negative',
    group: 'deaths',
    priority: 85,
    icon: 'skull',
    condition: (f, t) => f.deaths >= forRole(t.survival.manyDeaths, f.role),
    describe: (f) => `${f.deaths} deaths is a lot to give away. Worth a rewatch to spot the pattern.`
  },
  {
    id: 'caught_out',
    title: 'Caught Out',
    category: 'negative',
    group: 'deaths',
    priority: 72,
    icon: 'skull',
    isEstimate: true,
    condition: (f, t) => f.soloDeaths !== null && f.soloDeaths >= t.survival.soloDeaths,
    describe: (f) => `About ${f.soloDeaths} of your deaths came while you were alone with no help nearby.`
  },
  {
    id: 'early_deaths',
    title: 'Rough Start',
    category: 'negative',
    group: 'deaths',
    priority: 60,
    icon: 'sunrise',
    condition: (f, t) =>
      f.earlyDeaths !== null && f.earlyDeaths >= forRole(t.survival.earlyDeaths, f.role),
    describe: (f) => `${f.earlyDeaths} deaths inside the laning phase put you behind early.`
  },
  {
    id: 'time_dead',
    title: 'Spectator Mode',
    category: 'negative',
    group: 'deaths',
    priority: 55,
    icon: 'clock',
    condition: (f, t) => f.deadTimeShare !== null && f.deadTimeShare >= t.survival.deadTimeShare,
    describe: (f) =>
      `You spent ${Math.round(f.totalTimeSpentDead / 60)} minutes dead, about ${pct(f.deadTimeShare ?? 0)} of the game.`
  },
  {
    id: 'no_control',
    title: 'No Control',
    category: 'negative',
    group: 'control_wards',
    priority: 58,
    icon: 'eye-off',
    // Gated on game length: in a short game there genuinely isn't spare gold,
    // and flagging it reads as unfair. By 25 minutes there's no excuse.
    condition: (f, t) =>
      f.controlWardsPlaced === 0 && f.durationMinutes >= t.vision.negativeMinMinutes,
    // controlWardsPlaced === 0 is deliberately an identity check, so a null
    // (vision unavailable) can't satisfy it.
    describe: (f) =>
      `${Math.round(f.durationMinutes)} minutes and not one control ward. They're cheap, and they win fights before they start.`
  },
  {
    id: 'low_vision',
    title: 'Blind Spot',
    category: 'negative',
    group: 'vision_provided',
    priority: 50,
    icon: 'eye-off',
    condition: (f, t) =>
      f.visionScore !== null && f.visionScore < forRole(t.vision.weakVisionScore, f.role),
    describe: (f) => `Vision score of ${n(f.visionScore ?? 0)} is light for your role.`
  },
  {
    id: 'nothing_cleared',
    title: 'Nothing Cleared',
    category: 'negative',
    group: 'vision_denied',
    priority: 40,
    icon: 'eye-off',
    // Identity check on 0 so a null (vision unavailable) can't satisfy it.
    condition: (f, t) => f.wardsKilled === 0 && f.durationMinutes >= t.vision.negativeMinMinutes,
    describe: () => "You didn't clear a single enemy ward, so they saw you coming all game."
  },
  {
    id: 'low_cs',
    title: 'Farm Slipped',
    category: 'negative',
    group: 'farming',
    priority: 56,
    icon: 'wheat',
    condition: (f, t) => f.csPerMinute < forRole(t.farming.weakCsPerMinute, f.role),
    describe: (f) => `${one(f.csPerMinute)} CS per minute leaves a lot of gold on the map.`
  },
  {
    id: 'mid_game_dropoff',
    title: 'Lost the Thread',
    category: 'negative',
    group: 'farming',
    priority: 52,
    icon: 'trending-down',
    condition: (f, t) =>
      f.earlyCsPerMinute !== null &&
      f.midCsPerMinute !== null &&
      f.earlyCsPerMinute - f.midCsPerMinute >= t.farming.midGameDropoff,
    describe: (f) =>
      `Your farming dropped from ${one(f.earlyCsPerMinute ?? 0)} to ${one(f.midCsPerMinute ?? 0)} CS per minute after laning.`
  },
  {
    id: 'cs_deficit',
    title: 'Out-Farmed',
    category: 'negative',
    group: 'lane_economy',
    priority: 54,
    icon: 'trending-down',
    condition: (f, t) =>
      f.csDiffVsLaneOpponent !== null &&
      f.csDiffVsLaneOpponent <= -forRole(t.farming.csDeficit, f.role),
    describe: (f) =>
      `Your lane opponent finished ${n(Math.abs(f.csDiffVsLaneOpponent ?? 0))} CS ahead of you.`
  },
  {
    id: 'low_participation',
    title: 'Off On Your Own',
    category: 'negative',
    group: 'participation',
    priority: 62,
    icon: 'users',
    condition: (f, t) =>
      f.killParticipation !== null &&
      f.killParticipation < forRole(t.combat.lowKillParticipation, f.role),
    describe: (f) => `You were only in on ${pct(f.killParticipation ?? 0)} of your team's kills.`
  },
  {
    id: 'absent_fights',
    title: 'Missed the Fights',
    category: 'negative',
    group: 'participation',
    priority: 57,
    icon: 'users',
    isEstimate: true,
    condition: (f, t) =>
      f.teamfightParticipation !== null &&
      f.teamfightCount >= t.combat.teamfightMinSample &&
      f.teamfightParticipation < forRole(t.combat.lowTeamfightParticipation, f.role),
    describe: (f) =>
      `You were in about ${pct(f.teamfightParticipation ?? 0)} of the ${f.teamfightCount} teamfights your team took.`
  },
  {
    id: 'low_damage',
    title: 'Quiet Game',
    category: 'negative',
    group: 'damage',
    priority: 51,
    icon: 'crosshair',
    condition: (f, t) =>
      f.damagePerMinute !== null &&
      f.damagePerMinute < forRole(t.damage.lowDamagePerMinute, f.role),
    describe: (f) => `${n(f.damagePerMinute ?? 0)} damage per minute is low for your role.`
  },
  {
    id: 'no_objectives',
    title: 'Objectives Without You',
    category: 'negative',
    group: 'objectives',
    priority: 48,
    icon: 'target',
    // Guarded on objectives having actually happened: a game that ended
    // before any dragon spawned has none to have missed.
    condition: (f) =>
      f.objectiveParticipations === 0 &&
      f.majorObjectivesInGame !== null &&
      f.majorObjectivesInGame >= 3,
    describe: (f) =>
      `${f.majorObjectivesInGame} dragons, heralds and Barons went down this game, and you weren't in on any of them.`
  },
  {
    id: 'threw_lead',
    title: 'Slipped Away',
    category: 'negative',
    group: 'outcome',
    priority: 88,
    icon: 'trending-down',
    condition: (f, t) =>
      !f.win &&
      f.largestTeamGoldLead !== null &&
      f.largestTeamGoldLead >= t.outcome.throwLead,
    describe: (f) =>
      `Your team was ${n(f.largestTeamGoldLead ?? 0)} gold ahead at one point and still lost.`
  }
]
