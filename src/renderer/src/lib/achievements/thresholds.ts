import type { RoleScaled } from './types'

// Every tunable number for the achievement system, in one place.
//
// This file is meant to be edited freely. Changing a value here re-tunes an
// achievement without touching detection logic, fact extraction, or the UI.
//
// --- How these numbers were chosen ---
//
// Recalibrated with scripts/tune-achievements-dataset.ts against a standalone
// dataset (see dataset/, built by scripts/build-dataset.ts): ~7,900 ranked
// Summoner's Rift matches gathered by seeding from one account's last 10
// games, then pulling up to 100 games from every other player found in them.
// Critically, EVERY participant in EVERY match is evaluated as a focus in
// turn (not just one account), which turns those matches into ~67,000
// role-tagged participant-game samples -- roughly 13,000 per role. That's
// what replaced the old per-role sample sizes below.
//
// The rule-of-thumb targets are unchanged from the original calibration:
//
//   positive, standout   ~10-15% of games  (around the p90 of the stat)
//   positive, routine    ~20-30% of games
//   negative             ~10-15% of games  (around the p10 of the stat)
//   rare/marquee         under 5%          (pentakill, comeback, perfect game)
//
// A rule firing in 70% of games isn't an achievement, it's a participation
// trophy. A rule firing in 0% is dead weight.
//
// --- Previous per-role sample sizes (now superseded) ---
//
// The original calibration (scripts/tune-achievements.ts, one account's own
// history only) had:
//
//   TOP      538 games  -- data-backed
//   UTILITY   35 games  -- sanity-checked only
//   MIDDLE    31 games  -- sanity-checked only
//   JUNGLE     6 games  -- UNVERIFIED, too small to measure
//   BOTTOM     0 games  -- UNVERIFIED, entirely derived
//
// Every RoleScaled table below is now measured against ~13,000 games per
// role from the dataset (see the `// measured` comments), not derived by
// analogy. The `support` block (healsOnTeammates/shieldedOnTeammates) is
// likewise measured against real UTILITY numbers instead of a top laner's
// all-zero sample.
//
// --- Caveat that recalibration does NOT fix ---
//
// The dataset is still drawn entirely from one matchmaking bracket (the seed
// account's rank, and the ranks of whoever else appeared in its last 10
// games). Every percentile here describes "unusual in this bracket", not
// "unusual in League generally" -- a stat that's a great game in one rank can
// be an average one two ranks up. Re-run scripts/build-dataset.ts from a
// different seed account to check whether that matters in practice.

/** Picks the value for a role, falling back to DEFAULT for unknown/ARAM. */
export function forRole(table: RoleScaled, role: string): number {
  switch (role) {
    case 'TOP':
      return table.TOP
    case 'JUNGLE':
      return table.JUNGLE
    case 'MIDDLE':
      return table.MIDDLE
    case 'BOTTOM':
      return table.BOTTOM
    case 'UTILITY':
      return table.UTILITY
    default:
      return table.DEFAULT
  }
}

export const THRESHOLDS = {
  // --- Combat ---
  combat: {
    /** Kills for "Bringer of Carnage". Blended p90 is 13; fires ~10% blended. */
    highKills: 13,
    /** Killing spree length for "Unstoppable". Blended p90 is 6; fires ~14%. */
    killingSpree: 6,
    /** Solo kills for "Solo Slayer". Blended p90 is 4; fires ~8%. */
    soloKills: 4,
    /** Laning-phase kills for "Early Aggressor". Blended p90 is 6; fires ~18%. */
    earlyKills: 6,
    /**
     * Kill participation (0..1) for "Team Player". Role-scaled: measured p90
     * per role from ~13,400 games each.
     */
    highKillParticipation: {
      TOP: 0.5, // measured p90
      JUNGLE: 0.7, // measured p90
      MIDDLE: 0.6, // measured p90
      BOTTOM: 0.7, // measured p90
      UTILITY: 0.7, // measured p90
      DEFAULT: 0.6
    } as RoleScaled,
    /** Kill participation flagged as disengaged. Measured p10 per role. */
    lowKillParticipation: {
      TOP: 0.2, // measured p10
      JUNGLE: 0.3, // measured p10
      MIDDLE: 0.3, // measured p10
      BOTTOM: 0.3, // measured p10
      UTILITY: 0.4, // measured p10
      DEFAULT: 0.27
    } as RoleScaled,
    /**
     * Estimated duel win rate for "Master Duelist". Measured blended median
     * is 0.5 and p90 is 1.0 -- most games have too few duels for a
     * meaningful rate, hence the min-sample gate below rather than raising
     * this further.
     */
    duelWinRate: 0.9,
    /** Duels needed before a win rate is worth reporting at all. */
    duelMinSample: 4,
    /**
     * Estimated teamfight participation for "Fight Anchor". Role-scaled:
     * measured p90 per role.
     */
    teamfightParticipation: {
      TOP: 0.7, // measured p90
      JUNGLE: 1.0, // measured p90
      MIDDLE: 0.8, // measured p90
      BOTTOM: 1.0, // measured p90
      UTILITY: 1.0, // measured p90
      DEFAULT: 0.8
    } as RoleScaled,
    /** Teamfight participation flagged as absent. Measured p10-p25 per role. */
    lowTeamfightParticipation: {
      TOP: 0.25, // measured p10-p25
      JUNGLE: 0.5, // measured p10
      MIDDLE: 0.35, // measured p10-p25
      BOTTOM: 0.5, // measured p10
      UTILITY: 0.6, // measured p10
      DEFAULT: 0.35
    } as RoleScaled,
    /** Teamfights needed before participation is worth reporting. */
    teamfightMinSample: 4,
    /** Tower dives for the dedicated achievement. */
    towerDives: 1,
    /** CC time in seconds for "Lockdown Artist". Measured p90 per role. */
    ccSeconds: {
      TOP: 48, // measured p90
      JUNGLE: 44, // measured p90
      MIDDLE: 50, // measured p90
      BOTTOM: 42, // measured p90
      UTILITY: 66, // measured p90: engage supports dominate this stat
      DEFAULT: 46
    } as RoleScaled
  },

  // --- Deaths and survival ---
  survival: {
    /**
     * At or below this counts as a clean game. Role-scaled: measured p10-p25
     * per role -- TOP/JUNGLE/MIDDLE/BOTTOM p10 is all 2, UTILITY p10 is also
     * 2 but its median (7) is high enough that 2 alone fires rarely, which is
     * fine for a "standout" tile.
     */
    fewDeaths: {
      TOP: 2, // measured p10
      JUNGLE: 2, // measured p10
      MIDDLE: 2, // measured p10
      BOTTOM: 2, // measured p10
      UTILITY: 3, // measured just above p10, since p10 alone is too rare
      DEFAULT: 2
    } as RoleScaled,
    /** At or above this is flagged as a rough game. Measured p90-p95 per role. */
    manyDeaths: {
      TOP: 11, // measured p90
      JUNGLE: 10, // measured p90
      MIDDLE: 11, // measured p90
      BOTTOM: 11, // measured p90
      UTILITY: 11, // measured p90
      DEFAULT: 11
    } as RoleScaled,
    /**
     * Laning-phase deaths signalling a rough start. Measured p90 per role.
     * (An earlier pass here used estimated values instead of the measured
     * ones and fired 32-53% of games -- corrected against the real
     * distribution.)
     */
    earlyDeaths: {
      TOP: 5, // measured p90
      JUNGLE: 4, // measured p90
      MIDDLE: 5, // measured p90
      BOTTOM: 5, // measured p90
      UTILITY: 5, // measured p90
      DEFAULT: 5
    } as RoleScaled,
    /** Estimated solo deaths worth flagging. Blended measured p90; fires ~10%. */
    soloDeaths: 3,
    /** Share of the match spent dead (0..1). Blended measured p90; fires ~10%. */
    deadTimeShare: 0.2,
    /** Seconds alive without dying for "Untouchable". Blended p90 936; fires ~10%. */
    longestLifeSeconds: 936,
    /**
     * Self-mitigated damage for "Iron Wall". Blended p90 is 48.4k, but this
     * is paired with the fewDeaths+2 cap, and tanky games skew toward more
     * deaths -- kept below the raw p90 so the combined condition still lands
     * in the standout band rather than going dead. Measured combined firing
     * at this value: ~2.7%.
     */
    selfMitigated: 40_000
  },

  // --- Early-game ganks ---
  //
  // Calibrated with scripts/verify-gank-stats.ts, which runs the shipped
  // analyzer over 6,739 laner-games from 843 cached Summoner's Rift matches.
  // That sample is all ten players in each game rather than one player's
  // history, so it describes the population rather than any one account.
  //
  // Re-checked against the larger scripts/build-dataset.ts corpus (~67,000
  // participant-games): firing rates held up (unfindable 1.9%, gank_turnaround
  // 4.0%, ganks_survived 4.0%, gank_punisher 19.2%, held_under_pressure 8.8%,
  // untouched_laning 2.7%, gank_magnet 5.9%, camped 10.8%, only_died_to_ganks
  // 4.6%) -- all inside their intended bands, so these values are unchanged.
  //
  // Caveat on flat values: gank exposure is not uniform by role. Mean sampled
  // attempts run 0.71 for MIDDLE and 0.66 for BOTTOM but only 0.47 for TOP,
  // which is the most isolated lane. The counts are small integers, so role
  // scaling would mostly move rules between "never fires" and "fires often"
  // with nothing in between; these are flat until there is a per-role sample
  // worth tuning against.
  ganks: {
    /**
     * Deaths to early ganks that mark a lane as hunted. Measured: 3+ fires in
     * 5.8% of laner-games (2+ would be 21.0%, too routine for a criticism).
     * Below the 10-15% the other negatives target, because the distribution is
     * coarse and over-firing a "you got camped" tile is the worse mistake.
     */
    manyGankDeaths: 3,
    /**
     * Sampled attempts survived without dying. Measured: 2+ fires in 4.5%.
     */
    ganksSurvived: 2,
    /** Gankers killed in your own lane. Measured: 2+ fires in 4.0%. */
    turnedAround: 2,
    /** A single turnaround, for the lower tier. Measured: fires in 22.0%. */
    turnedAroundOne: 1,
    /**
     * Attempts that must have been sampled before "never died to a gank" means
     * anything. Zero gank deaths alone is 42.9% of games and usually just means
     * nothing happened; pairing it with witnessed pressure drops it to 2.2%,
     * which is what makes it an achievement rather than a quiet game.
     */
    pressureWitnessed: 2,
    /**
     * Gank deaths that still count as holding the lane, when the player finished
     * laning ahead of their opponent anyway. Being ganked twice and still up on
     * gold is a different story from being ganked twice and falling behind.
     */
    heldUnderPressureDeaths: 2,
    /**
     * Sampled attempts that mark a lane as the enemy's focus.
     *
     * Two rather than three because attempts are sampled once a minute against a
     * ~10s gank, so the figure is a floor: a lane caught twice was almost
     * certainly visited more often than that. At 3 this fired in 0.7% of the
     * calibration player's games -- effectively dead, since top is the most
     * isolated lane (mean 0.47 attempts, against 0.71 for mid). At 2 it fires in
     * 12.3% of laner-games population-wide, inside the band the other negatives
     * aim for.
     */
    campedAttempts: 2,
    /**
     * Gank deaths needed before "every early death was a gank" is worth saying.
     * At 1 it would fire on any single early death that happened to be a gank,
     * which describes nothing.
     */
    allEarlyDeathsFromGanks: 2
  },

  // --- Damage ---
  damage: {
    /** Champion damage for "Ouch You Hurt". Measured p90 per role. */
    highDamage: {
      TOP: 42_000, // measured p90
      JUNGLE: 38_500, // measured p90
      MIDDLE: 43_500, // measured p90
      BOTTOM: 45_200, // measured p90
      UTILITY: 23_900, // measured p90
      DEFAULT: 42_000
    } as RoleScaled,
    /** Share of team damage (0..1) for the damage-carry tile. Blended p90 is 0.3. */
    teamDamageShare: 0.3,
    /** Damage/min flagged as low impact. Measured p10 per role. */
    lowDamagePerMinute: {
      TOP: 475, // measured p10
      JUNGLE: 370, // measured p10
      MIDDLE: 490, // measured p10
      BOTTOM: 460, // measured p10
      UTILITY: 195, // measured p10
      DEFAULT: 400
    } as RoleScaled
  },

  // --- Farming and economy ---
  farming: {
    /** CS/min for the top farming tile. Measured p90 per role. */
    strongCsPerMinute: {
      TOP: 8.8, // measured p90
      JUNGLE: 8.3, // measured p90
      MIDDLE: 8.7, // measured p90
      BOTTOM: 9.0, // measured p90
      UTILITY: 1.9, // measured p90
      DEFAULT: 8.5
    } as RoleScaled,
    /** CS/min flagged as slipping. Measured p10 per role. */
    weakCsPerMinute: {
      TOP: 5.5, // measured p10
      JUNGLE: 5.3, // measured p10
      MIDDLE: 5.6, // measured p10
      BOTTOM: 6.2, // measured p10
      // Zero exempts supports entirely: CS/min can't fall below 0, so the
      // rule never fires for them. Measured UTILITY p10 is 0.7, and even a
      // bar of that low still flags support for doing the job as designed.
      UTILITY: 0,
      DEFAULT: 5.8
    } as RoleScaled,
    /** CS at 10 min for a strong start. Measured p90 per role. */
    strongCsAt10: {
      TOP: 85, // measured p90
      JUNGLE: 6, // measured p90
      MIDDLE: 89, // measured p90
      BOTTOM: 79, // measured p90
      UTILITY: 20, // measured p90
      DEFAULT: 82
    } as RoleScaled,
    /**
     * Drop in CS/min from laning to the rest of the game that counts as
     * falling off. Blended measured p90 is 1.3; fires ~10%.
     */
    midGameDropoff: 1.3,
    /**
     * "Never Slacking" wants games where farming actually IMPROVED after
     * laning, which is why this is negative: most games already drift slightly
     * upward (blended measured median -0.5). Blended p25 is -1.9; fires ~23%.
     */
    consistentDropoff: -1.9,
    /** CS lead over the lane opponent. Blended measured p90 is 56; fires ~10%. */
    csLead: {
      TOP: 64, // measured p90
      JUNGLE: 70, // measured p90: jungle CS swings on camp routing, not lane state
      MIDDLE: 59, // measured p90
      BOTTOM: 56, // measured p90
      UTILITY: 25, // measured p90
      DEFAULT: 56
    } as RoleScaled,
    /** CS deficit vs the lane opponent. Measured p10 per role. */
    csDeficit: {
      TOP: 64, // measured |p10|
      JUNGLE: 70, // measured |p10|
      MIDDLE: 59, // measured |p10|
      BOTTOM: 56, // measured |p10|
      UTILITY: 999, // effectively exempt: support CS says nothing about play
      DEFAULT: 56
    } as RoleScaled,
    /** Gold lead over the lane opponent. Blended measured p90 is 4,224; fires ~10%. */
    goldLead: 4_200,
    /** Gold/min for "Goblin Hoarder". Measured p90 per role. */
    goldPerMinute: {
      TOP: 520, // measured p90
      JUNGLE: 559, // measured p90
      MIDDLE: 523, // measured p90
      BOTTOM: 590, // measured p90
      UTILITY: 378, // measured p90
      DEFAULT: 520
    } as RoleScaled
  },

  // --- Objectives and structures ---
  objectives: {
    /** Turret takedowns for "Siege Master". Blended measured p90 is 3; fires ~10%. */
    turretKills: 3,
    /** Structure damage for "Wrecking Ball". Blended measured p90 is 13,120; fires ~10%. */
    turretDamage: 13_000,
    /** Major objective participations. Blended measured p90 is 6; fires ~14%. */
    participations: 6,
    /** Dragon takedowns for "Dragon Tamer". Measured p95 per role. */
    dragonTakedowns: {
      TOP: 2, // measured p95
      JUNGLE: 4, // measured p95: the jungler is at nearly every dragon
      MIDDLE: 2, // measured p95
      BOTTOM: 3, // measured p95
      UTILITY: 3, // measured p95
      DEFAULT: 3
    } as RoleScaled,
    /** Baron takedowns for "Baron Slayer". Blended measured p90 is 1; p95 is 2. */
    baronTakedowns: 2
  },

  // --- Vision ---
  vision: {
    /**
     * Vision score for the vision tile, on top of leading the team. The
     * UTILITY figure is high because supports lead team vision almost by
     * default, so the "top on team" half of that rule adds nothing for them.
     * All measured p90 per role -- UTILITY's own p90 (126) was too loose
     * paired with isTopVisionOnTeam (fired 49% of UTILITY games), so it's
     * set above p95 (140) instead to land back in the standout band.
     */
    strongVisionScore: {
      TOP: 39, // measured p90
      JUNGLE: 46, // measured p90
      MIDDLE: 38, // measured p90
      BOTTOM: 35, // measured p90
      UTILITY: 145, // above measured p95 (140) -- see note above
      DEFAULT: 39
    } as RoleScaled,
    /** Vision score flagged as neglected. Measured p10 per role. */
    weakVisionScore: {
      TOP: 12, // measured p10
      JUNGLE: 14, // measured p10
      MIDDLE: 10, // measured p10
      BOTTOM: 10, // measured p10
      UTILITY: 45, // measured p10
      DEFAULT: 12
    } as RoleScaled,
    /** Enemy wards cleared. Measured p90 per role. */
    wardsKilled: {
      TOP: 4, // measured p90
      JUNGLE: 9, // measured p90
      MIDDLE: 5, // measured p90
      BOTTOM: 6, // measured p90
      UTILITY: 15, // measured p90: sweeping is core to the role
      DEFAULT: 6
    } as RoleScaled,
    /** Control wards placed. Measured p90 per role. */
    controlWards: {
      TOP: 2, // measured p90
      JUNGLE: 5, // measured p90
      MIDDLE: 3, // measured p90
      BOTTOM: 3, // measured p90
      UTILITY: 11, // measured p90
      DEFAULT: 3
    } as RoleScaled,
    /**
     * Wards placed. Measured p90 per role, except UTILITY: the raw p90 (51)
     * fired in 74% of UTILITY games since ward_provider has no "top on team"
     * gate, so it's set above p95 (57) instead.
     */
    wardsPlaced: {
      TOP: 15, // measured p90
      JUNGLE: 13, // measured p90
      MIDDLE: 16, // measured p90
      BOTTOM: 14, // measured p90
      UTILITY: 58, // above measured p95 (57) -- see note above
      DEFAULT: 15
    } as RoleScaled,
    /**
     * Games shorter than this are exempt from the control-ward and sweeping
     * criticisms: there genuinely isn't time or gold to spare in a 15-minute
     * game, and flagging it reads as unfair.
     */
    negativeMinMinutes: 25
  },

  // --- Support utility ---
  // Measured against ~13,400 real UTILITY participant-games in the dataset,
  // replacing the earlier all-zero top-laner sample.
  support: {
    /** Healing on teammates for "Field Medic". UTILITY measured p90 is 9,288. */
    healsOnTeammates: 9_000,
    /** Shielding on teammates for "Guardian". UTILITY measured p90 is 6,488. */
    shieldedOnTeammates: 6_500,
    /**
     * Minimum assists before leading the team in them counts for anything.
     * Role-scaled and calibrated: measured p75 per role, since combined with
     * isTopAssistsOnTeam the raw p90 was too tight everywhere except UTILITY
     * (which still fired 32% of games at the old bar of 18, well below its
     * own measured p75 of 20).
     */
    topAssistsMin: {
      TOP: 8, // measured p75
      JUNGLE: 11, // measured p75
      MIDDLE: 10, // measured p75
      BOTTOM: 11, // measured p75
      UTILITY: 20, // measured p75
      DEFAULT: 10
    } as RoleScaled
  },

  // --- Match outcome ---
  outcome: {
    /** Team gold difference for "Stomp". Blended measured p90 is 12,789; fires ~10%. */
    stompGoldDiff: 12_800,
    /**
     * Deficit the team recovered from, gated on a win. Measured against the
     * original 5,000 bar this already fires at ~4% (appropriately rare per
     * the marquee target), and the blended median deficit magnitude is 4,395
     * -- so 5,000 already sits just past the middle of the distribution
     * rather than needing to move. Left unchanged.
     */
    comebackDeficit: 5_000,
    /** Lead the team held before losing, gated on a loss. Same reasoning as
     * comebackDeficit -- already measured at ~4% and near the blended
     * median magnitude (4,397). Left unchanged. */
    throwLead: 5_000
  },

  // --- Filler tier ---
  // Bars for the routine observations that pad a thin panel out to
  // display.minTotal. These sit around the measured median rather than the
  // p90, so they're honest descriptions of an ordinary game rather than
  // praise. They only ever appear when real achievements ran short.
  filler: {
    /** KDA worth mentioning as a positive. Blended measured median is unchanged from before. */
    decentKda: 1.5,
    /** CS/min for "kept farming". Measured p50 per role. */
    steadyCsPerMinute: {
      TOP: 7.1, // measured p50
      JUNGLE: 6.7, // measured p50
      MIDDLE: 7.1, // measured p50
      BOTTOM: 7.6, // measured p50
      UTILITY: 1.1, // measured p50
      DEFAULT: 6.5
    } as RoleScaled,
    /** Share of team damage worth mentioning. Blended measured p25-p50 is 0.1-0.2. */
    fairDamageShare: 0.15,
    /** Wards placed worth mentioning. Measured p25 per role. */
    someWards: {
      TOP: 7, // measured p25
      JUNGLE: 3, // measured p25
      MIDDLE: 7, // measured p25
      BOTTOM: 7, // measured p25
      UTILITY: 25, // measured p25
      DEFAULT: 7
    } as RoleScaled,
    /** Structure damage worth mentioning. Blended measured p25 is 1,115; kept a bit higher for a meaningful floor. */
    someStructureDamage: 2_000,
    /** Seconds alive in one stretch worth mentioning. Blended measured p25 is 387. */
    decentLongestLife: 390,
    /** Damage taken worth mentioning as soaking up pressure. */
    someDamageTaken: 20_000,
    /** Kill participation worth mentioning. Around the blended measured median. */
    someKillParticipation: 0.35,
    /** CS gap within which the lane counts as having gone even. */
    evenLaneCsMargin: 25
  },

  // --- Display ---
  display: {
    /** Hard cap on tiles shown, matching the panel layout. */
    maxTotal: 6,
    /**
     * Floor on tiles shown, topped up from the filler tier when real
     * achievements ran short. A one-tile panel reads as broken rather than
     * as an honest "nothing much happened".
     */
    minTotal: 4,
    /** Negative tiles allowed when the game went well. */
    maxNegativeWhenWinning: 2,
    /** Negative tiles allowed when the game went badly. */
    maxNegativeWhenLosing: 4,
    /**
     * Keep at least this many positives when possible, so even a bad game
     * shows something the player did right.
     */
    minPositive: 2
  }
} as const
