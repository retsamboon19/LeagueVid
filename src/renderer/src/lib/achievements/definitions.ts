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
//   - `hint` is the opposite: it goes in the browse-all catalog, where nothing
//     has been earned yet, so it must NOT include the number. "Make a habit of
//     clearing enemy wards", never "clear 11 wards". Publishing the bar turns
//     the catalog into a list to farm, and the bars move every calibration.
//   - Rarity (R / S / SSR) is not written here. It's read off `priority` in
//     tiers.ts, so there's one number to tune per rule rather than two that
//     can disagree.
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
    hint: 'Wipe out an entire enemy team by yourself in a single fight.',
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
    hint: 'Cut down nearly a whole enemy team in one fight, on your own.',
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
    hint: 'Chase a kill in under an enemy turret and get away with it.',
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
    hint: 'Rack up kills with no teammate involved in them.',
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
    hint: 'Keep winning your one-on-one fights across a game.',
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
    hint: 'String kills together without dying in between.',
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
    hint: 'Finish a game with a kill count that turns heads.',
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
    hint: 'Get on top of your lane with kills during the laning phase.',
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
    hint: 'Spend a game holding enemies in place for your team.',
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
    hint: 'Put out heavy damage to enemy champions over a game.',
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
    hint: 'Be the biggest source of damage on your team.',
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
    hint: 'Absorb a great deal of punishment and stay alive through it.',
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
    hint: 'Be the one soaking up the most damage on a team that wins.',
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
    hint: 'Hold a high farming rate from the first minute to the last.',
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
    hint: 'Farm at least as well after laning ends as you did during it.',
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
    hint: 'Come out of the opening minutes with your farm well stocked.',
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
    hint: 'End the game with a clear gold lead over your lane opponent.',
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
    hint: 'Finish with more farm than the player you laned against.',
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
    hint: 'Generate gold at a strong rate all game long.',
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
    hint: 'Spend your game putting damage into enemy structures.',
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
    hint: 'Be the one who personally finishes off enemy turrets.',
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
    hint: 'Make a habit of turning up for dragons, heralds and Barons.',
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
    hint: 'Be there when your team takes dragons down.',
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
    hint: 'Take part in bringing Baron down.',
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
    hint: 'Make a habit of hunting down the enemy team\u2019s wards.',
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
    hint: 'Lead your team in vision score, with a strong one.',
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
    hint: 'Keep the map lit up with wards for your team.',
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
    hint: 'Keep spending on control wards to deny the enemy their vision.',
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
    hint: 'Get through an entire game without dying once.',
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
    hint: 'Reach the end of a game having given away barely any deaths.',
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
    hint: 'Go a long unbroken stretch of a game without dying.',
    category: 'positive',
    group: 'deaths',
    priority: 51,
    icon: 'heart',
    condition: (f, t) => f.longestTimeSpentLiving >= t.survival.longestLifeSeconds,
    describe: (f) =>
      `You went ${Math.round(f.longestTimeSpentLiving / 60)} minutes straight without dying.`
  },

  // --- Early ganks ----------------------------------------------------------
  //
  // All four share the gank_survival group on purpose, so a good laning phase
  // shows its single strongest tile instead of four tiles restating it.
  //
  // Every rule here is an estimate: gank detection is LeagueVid's own, derived
  // from lane corridor geometry and Riot's once-a-minute position samples. Null
  // facts (junglers, non-Summoner's-Rift modes) must never satisfy a condition,
  // hence the explicit null checks rather than `?? 0`.
  {
    id: 'unfindable',
    title: 'Unfindable',
    hint: 'Have them keep coming for your lane and never once catch you.',
    category: 'positive',
    group: 'gank_survival',
    // Rarest of the set at 2.2% of laner-games, and the one that best answers
    // "did I play the map well", so it outranks the rest of the group.
    priority: 90,
    icon: 'shield',
    isEstimate: true,
    condition: (f, t) =>
      f.gankDeaths !== null &&
      f.gankAttempts !== null &&
      f.gankDeaths === 0 &&
      f.gankAttempts >= t.ganks.pressureWitnessed,
    describe: (f) =>
      `They came for your lane ${f.gankAttempts} times before 15 minutes and never got you once.`
  },
  {
    id: 'gank_turnaround',
    title: 'Turned the Tables',
    hint: 'Make the players who rotate into your lane regret the trip.',
    category: 'positive',
    group: 'gank_survival',
    priority: 86,
    icon: 'swords',
    isEstimate: true,
    condition: (f, t) =>
      f.ganksTurnedAround !== null && f.ganksTurnedAround >= t.ganks.turnedAround,
    describe: (f) => `${f.ganksTurnedAround} enemies came to gank your lane and died for it.`
  },
  {
    id: 'ganks_survived',
    title: 'Slippery',
    hint: 'Walk away from early attempts to collapse on your lane.',
    category: 'positive',
    group: 'gank_survival',
    priority: 76,
    icon: 'heart',
    isEstimate: true,
    condition: (f, t) => f.ganksSurvived !== null && f.ganksSurvived >= t.ganks.ganksSurvived,
    describe: (f) => `You walked away from ${f.ganksSurvived} early ganks on your lane.`
  },
  {
    id: 'gank_punisher',
    title: 'Punished the Roam',
    hint: 'Kill someone who came into your lane looking for you.',
    category: 'positive',
    group: 'gank_survival',
    // Fires in 22% of laner-games, so it sits in routine territory -- the
    // group's higher tiers displace it whenever the laning phase went better
    // than "a roam showed up and died".
    priority: 46,
    icon: 'crosshair',
    isEstimate: true,
    condition: (f, t) =>
      f.ganksTurnedAround !== null && f.ganksTurnedAround >= t.ganks.turnedAroundOne,
    describe: () => 'Someone rotated into your lane to kill you and died there instead.'
  },
  {
    id: 'held_under_pressure',
    title: 'Held the Lane',
    hint: 'Get collapsed on repeatedly and still finish ahead of your laner.',
    category: 'positive',
    // Its own group: this is about the lane's economy surviving the ganks, not
    // about the ganks themselves, so it can stand next to a gank_survival tile.
    group: 'lane_economy',
    priority: 82,
    icon: 'shield',
    isEstimate: true,
    condition: (f, t) =>
      f.gankDeaths !== null &&
      f.goldDiffVsLaneOpponent !== null &&
      f.gankDeaths >= t.ganks.heldUnderPressureDeaths &&
      f.goldDiffVsLaneOpponent > 0,
    describe: (f) =>
      `They ganked you ${f.gankDeaths} times and you still finished ahead of your laner.`
  },
  {
    id: 'untouched_laning',
    title: 'Clean Laning Phase',
    hint: 'Get through the whole laning phase alive while being hunted.',
    category: 'positive',
    group: 'gank_survival',
    priority: 80,
    icon: 'sparkles',
    isEstimate: true,
    // Requires a witnessed attempt: without it this would reward any quiet
    // laning phase where nobody ever came, which is not the same achievement.
    condition: (f) =>
      f.gankAttempts !== null &&
      f.gankDeaths !== null &&
      f.earlyDeaths !== null &&
      f.gankAttempts >= 1 &&
      f.gankDeaths === 0 &&
      f.earlyDeaths === 0,
    describe: () =>
      'Someone came for your lane and you reached 15 minutes without dying once.'
  },

  // --- Support and utility --------------------------------------------------
  {
    id: 'medic',
    title: 'Field Medic',
    hint: 'Spend your game keeping teammates topped up with healing.',
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
    hint: 'Take damage off your teammates by shielding them.',
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
    hint: 'Lead your team in assists.',
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
    hint: 'Have a hand in most of the kills your team picks up.',
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
    hint: 'Be present for the teamfights rather than arriving after them.',
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
    hint: 'Win a game your team had already fallen a long way behind in.',
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
    hint: 'Win a game your team was never really in danger of losing.',
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
    hint: 'Finish as the highest-level player of the ten.',
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
    hint: 'Close out a win that was not going to win any awards.',
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
    hint: 'Come out on the right side of your trades over a game.',
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
    hint: 'Be there for some of the game\u2019s major objectives.',
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
    hint: 'Keep your farm ticking along at a respectable rate.',
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
    hint: 'Contribute your share of the damage your team put out.',
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
    hint: 'Take a real share of the damage flying around.',
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
    hint: 'Get some damage onto enemy structures.',
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
    hint: 'Put wards down and build a vision score off them.',
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
    hint: 'Put together a decent run without dying somewhere in the game.',
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
    hint: 'Be involved in a fair share of your team\u2019s kills.',
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
    hint: 'Come out of lane dead level with your opponent on farm.',
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
    hint: 'A note on what you earned. Every game gets this one.',
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
    hint: 'Give away a lot of deaths across one game.',
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
    hint: 'Keep dying in places where no teammate was close enough to help.',
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
    hint: 'Fall behind by dying during the laning phase.',
    category: 'negative',
    group: 'deaths',
    priority: 60,
    icon: 'sunrise',
    condition: (f, t) =>
      f.earlyDeaths !== null && f.earlyDeaths >= forRole(t.survival.earlyDeaths, f.role),
    describe: (f) => `${f.earlyDeaths} deaths inside the laning phase put you behind early.`
  },
  {
    id: 'gank_magnet',
    title: 'Gank Magnet',
    hint: 'Lose your early deaths to enemies collapsing on your lane.',
    category: 'negative',
    // Its own group rather than 'deaths': being repeatedly collapsed on in lane
    // is a different problem from dying a lot overall, and the fix is different
    // too, so it should be able to appear alongside a raw death-count tile.
    group: 'gank_pressure',
    priority: 70,
    icon: 'target',
    isEstimate: true,
    condition: (f, t) => f.gankDeaths !== null && f.gankDeaths >= t.ganks.manyGankDeaths,
    describe: (f) =>
      `${f.gankDeaths} of your early deaths came from enemies collapsing on your lane. Worth checking your ward timings on the rewatch.`
  },
  {
    id: 'camped',
    title: 'Camped',
    hint: 'Have the enemy jungler decide your lane is their project.',
    category: 'negative',
    group: 'gank_pressure',
    // Below gank_magnet, so when a camped lane also cost several deaths the
    // group shows the death count rather than the visit count.
    priority: 58,
    icon: 'target',
    isEstimate: true,
    condition: (f, t) => f.gankAttempts !== null && f.gankAttempts >= t.ganks.campedAttempts,
    describe: (f) =>
      `Your lane was visited ${f.gankAttempts} separate times before 15 minutes. That is where their jungler spent the game.`
  },
  {
    id: 'only_died_to_ganks',
    title: 'Never Lost the 1v1',
    hint: 'Lose your laning deaths to collapses, never to your matchup.',
    category: 'negative',
    // Sits in gank_pressure so it can't stack with Gank Magnet, which is the
    // same observation stated more bluntly.
    group: 'gank_pressure',
    priority: 50,
    icon: 'users',
    isEstimate: true,
    condition: (f, t) =>
      f.gankDeaths !== null &&
      f.earlyDeaths !== null &&
      f.gankDeaths >= t.ganks.allEarlyDeathsFromGanks &&
      f.earlyDeaths === f.gankDeaths,
    describe: (f) =>
      `All ${f.earlyDeaths} of your laning deaths came from collapses, none from your actual matchup.`
  },
  {
    id: 'time_dead',
    title: 'Spectator Mode',
    hint: 'Spend a sizeable chunk of the game waiting to respawn.',
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
    hint: 'Get through a full-length game without buying a control ward.',
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
    hint: 'End a game with less vision than your role usually provides.',
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
    hint: 'Leave every enemy ward standing for the whole game.',
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
    hint: 'Finish on a farming rate below what your role should manage.',
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
    hint: 'Farm well in lane, then let it slide once laning ends.',
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
    hint: 'Finish lane well behind your opponent on farm.',
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
    hint: 'Miss most of the kills your team picked up.',
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
    hint: 'Be somewhere else for most of the teamfights your team took.',
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
    hint: 'Put out less damage than your role normally does.',
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
    hint: 'Let the game\u2019s major objectives happen without you there.',
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
    hint: 'Lose a game your team was comfortably ahead in.',
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
