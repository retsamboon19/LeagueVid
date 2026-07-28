import type { RoleScaled } from './types'

// Every tunable number for the achievement system, in one place.
//
// This file is meant to be edited freely. Changing a value here re-tunes an
// achievement without touching detection logic, fact extraction, or the UI.
//
// --- How these numbers were chosen ---
//
// Calibrated with scripts/tune-achievements.ts against 538 cached ranked
// Summoner's Rift games from a single top-lane player, measuring the real
// percentile distribution of every stat and then setting each threshold so
// the rule fires at a sensible rate. The targets were roughly:
//
//   positive, standout   ~10-15% of games  (around the p90 of the stat)
//   positive, routine    ~20-30% of games
//   negative             ~10-15% of games  (around the p10 of the stat)
//   rare/marquee         under 5%          (pentakill, comeback, perfect game)
//
// A rule firing in 70% of games isn't an achievement, it's a participation
// trophy. A rule firing in 0% is dead weight. Both were found and fixed this
// way -- see the git history for the before/after firing rates.
//
// --- Important caveat on role scaling ---
//
// Sample sizes per role in that calibration set:
//
//   TOP      538 games  -- data-backed
//   UTILITY   35 games  -- sanity-checked only; corrected the worst mismatches
//   MIDDLE    31 games  -- sanity-checked only
//   JUNGLE     6 games  -- UNVERIFIED, too small to measure
//   BOTTOM     0 games  -- UNVERIFIED, entirely derived
//
// Non-TOP columns are marked `// derived` and were reasoned from the known
// shape of each role (supports farm far less and ward far more, junglers hold
// more vision, ADCs farm hardest), then checked against whatever sample
// existed. They want re-calibrating against a player who mains those roles:
//
//   npx tsx scripts/tune-achievements.ts --role UTILITY --distributions
//
// Same applies to the `support` block: the calibration player is a top laner,
// so their healing and shielding numbers are zero at every percentile and
// those two thresholds are unverified guesses.

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
    /** Kills for "Bringer of Carnage". Measured p90; fires ~11%. */
    highKills: 10,
    /** Killing spree length for "Unstoppable". Measured p90; fires ~12%. */
    killingSpree: 6,
    /** Solo kills for "Solo Slayer". Measured p90 is 6; fires ~15%. */
    soloKills: 5,
    /** Laning-phase kills for "Early Aggressor". Measured p90; fires ~14%. */
    earlyKills: 5,
    /**
     * Kill participation (0..1) for "Team Player". Role-scaled because the
     * baseline differs structurally: a support is near every fight by nature,
     * so a flat TOP-calibrated bar fired for 34% of support games.
     */
    highKillParticipation: {
      TOP: 0.6, // measured p90
      JUNGLE: 0.68, // derived
      MIDDLE: 0.65, // derived
      BOTTOM: 0.65, // derived
      UTILITY: 0.75, // derived
      DEFAULT: 0.65
    } as RoleScaled,
    /** Kill participation flagged as disengaged. TOP measured p10. */
    lowKillParticipation: {
      TOP: 0.22,
      JUNGLE: 0.32, // derived
      MIDDLE: 0.28, // derived
      BOTTOM: 0.28, // derived
      UTILITY: 0.34, // derived
      DEFAULT: 0.27
    } as RoleScaled,
    /**
     * Estimated duel win rate for "Master Duelist". The measured median is
     * already 0.8 because most games contain only a handful of duels, so this
     * sits high deliberately and leans on the sample size below.
     */
    duelWinRate: 0.9,
    /** Duels needed before a win rate is worth reporting at all. */
    duelMinSample: 4,
    /**
     * Estimated teamfight participation for "Fight Anchor". Role-scaled for
     * the same reason as kill participation -- the flat TOP bar fired in 77%
     * of support games, where showing up to fights is the whole job.
     */
    teamfightParticipation: {
      TOP: 0.7, // measured p90
      JUNGLE: 0.8, // derived
      MIDDLE: 0.8, // derived
      BOTTOM: 0.8, // derived
      UTILITY: 0.88, // derived
      DEFAULT: 0.78
    } as RoleScaled,
    /** Teamfight participation flagged as absent. TOP measured p10-p25. */
    lowTeamfightParticipation: {
      TOP: 0.25,
      JUNGLE: 0.35, // derived
      MIDDLE: 0.3, // derived
      BOTTOM: 0.3, // derived
      UTILITY: 0.42, // derived
      DEFAULT: 0.3
    } as RoleScaled,
    /** Teamfights needed before participation is worth reporting. */
    teamfightMinSample: 4,
    /** Tower dives for the dedicated achievement. */
    towerDives: 1,
    /** CC time in seconds for "Lockdown Artist". TOP measured p95. */
    ccSeconds: {
      TOP: 30,
      JUNGLE: 35, // derived
      MIDDLE: 35, // derived
      BOTTOM: 25, // derived
      UTILITY: 60, // derived: engage supports dominate this stat
      DEFAULT: 32
    } as RoleScaled
  },

  // --- Deaths and survival ---
  survival: {
    /**
     * At or below this counts as a clean game. Role-scaled: a flat bar of 2
     * was unreachable for supports, who never earned the tile at all.
     */
    fewDeaths: {
      TOP: 2, // measured p10 is 2
      JUNGLE: 3, // derived
      MIDDLE: 3, // derived
      BOTTOM: 3, // derived
      UTILITY: 4, // derived
      DEFAULT: 3
    } as RoleScaled,
    /**
     * At or above this is flagged as a rough game. Role-scaled: the flat
     * TOP-calibrated bar of 10 fired in 46% of support games, where dying
     * more is an occupational hazard rather than a mistake.
     */
    manyDeaths: {
      TOP: 10, // measured p95
      JUNGLE: 11, // derived
      MIDDLE: 11, // derived
      BOTTOM: 11, // derived
      UTILITY: 13, // derived
      DEFAULT: 11
    } as RoleScaled,
    /** Laning-phase deaths signalling a rough start. TOP measured p90. */
    earlyDeaths: {
      TOP: 4,
      JUNGLE: 5, // derived
      MIDDLE: 5, // derived
      BOTTOM: 5, // derived
      UTILITY: 6, // derived
      DEFAULT: 5
    } as RoleScaled,
    /** Estimated solo deaths worth flagging. Measured p95; fires ~5%. */
    soloDeaths: 4,
    /** Share of the match spent dead (0..1). Measured p90; fires ~4%. */
    deadTimeShare: 0.19,
    /** Seconds alive without dying for "Untouchable". Measured p90; ~10%. */
    longestLifeSeconds: 1_050,
    /**
     * Self-mitigated damage for "Iron Wall". Sits below the measured p90 of
     * 59.7k because it's paired with a death cap, and tanky games tend to come
     * with more deaths -- at p90 the combination fired in under 2% of games.
     */
    selfMitigated: 45_000
  },

  // --- Damage ---
  damage: {
    /** Champion damage for "Ouch You Hurt". TOP measured p90; fires ~10%. */
    highDamage: {
      TOP: 43_000,
      JUNGLE: 40_000, // derived
      MIDDLE: 48_000, // derived
      BOTTOM: 50_000, // derived
      UTILITY: 22_000, // derived
      DEFAULT: 42_000
    } as RoleScaled,
    /** Share of team damage (0..1) for the damage-carry tile. Measured p90. */
    teamDamageShare: 0.32,
    /** Damage/min flagged as low impact. TOP measured p10; fires ~10%. */
    lowDamagePerMinute: {
      TOP: 550,
      JUNGLE: 400, // derived
      MIDDLE: 600, // derived
      BOTTOM: 600, // derived
      UTILITY: 180, // derived: 300 flagged 43% of support games
      DEFAULT: 450
    } as RoleScaled
  },

  // --- Farming and economy ---
  farming: {
    /** CS/min for the top farming tile. TOP measured p90; fires ~12%. */
    strongCsPerMinute: {
      TOP: 9,
      JUNGLE: 7.5, // derived
      MIDDLE: 9.5, // derived
      BOTTOM: 9.5, // derived
      UTILITY: 3.5, // derived
      DEFAULT: 8.5
    } as RoleScaled,
    /** CS/min flagged as slipping. TOP measured p10; fires ~10%. */
    weakCsPerMinute: {
      TOP: 6.2,
      JUNGLE: 5, // derived
      MIDDLE: 6.4, // derived
      BOTTOM: 6.6, // derived
      // Zero exempts supports entirely: CS/min can't fall below 0, so the
      // rule never fires for them. Support CS sits around 1/min by design,
      // and a bar of 1 flagged a third of their games for doing their job.
      UTILITY: 0,
      DEFAULT: 5.8
    } as RoleScaled,
    /** CS at 10 min for a strong start. TOP measured p90; fires ~12%. */
    strongCsAt10: {
      TOP: 86,
      JUNGLE: 72, // derived
      MIDDLE: 88, // derived
      BOTTOM: 88, // derived
      UTILITY: 30, // derived
      DEFAULT: 82
    } as RoleScaled,
    /**
     * Drop in CS/min from laning to the rest of the game that counts as
     * falling off. Measured p95; fires ~5%.
     */
    midGameDropoff: 2,
    /**
     * "Never Slacking" wants games where farming actually IMPROVED after
     * laning, which is why this is negative: most games already drift slightly
     * upward (measured median -0.8), so a flat bar of 0 fired in 77% of games.
     * Measured p25; fires ~22%.
     */
    consistentDropoff: -2,
    /** CS lead over the lane opponent. TOP measured p90; fires ~11%. */
    csLead: {
      TOP: 78,
      JUNGLE: 60, // derived: jungle CS swings on camp routing, not lane state
      MIDDLE: 78, // derived
      BOTTOM: 80, // derived
      UTILITY: 40, // derived
      DEFAULT: 70
    } as RoleScaled,
    /** CS deficit vs the lane opponent. TOP measured p10; fires ~10%. */
    csDeficit: {
      TOP: 38,
      JUNGLE: 60, // derived
      MIDDLE: 40, // derived
      BOTTOM: 45, // derived
      UTILITY: 999, // effectively exempt: support CS says nothing about play
      DEFAULT: 45
    } as RoleScaled,
    /** Gold lead over the lane opponent. Measured p90; fires ~11%. */
    goldLead: 5_400,
    /** Gold/min for "Goblin Hoarder". TOP measured p90; fires ~10%. */
    goldPerMinute: {
      TOP: 530,
      JUNGLE: 490, // derived
      MIDDLE: 550, // derived
      BOTTOM: 570, // derived
      UTILITY: 350, // derived: supports earn far less by design
      DEFAULT: 520
    } as RoleScaled
  },

  // --- Objectives and structures ---
  objectives: {
    /** Turret takedowns for "Siege Master". Measured p90; fires ~13%. */
    turretKills: 6,
    /** Structure damage for "Wrecking Ball". Measured p90; fires ~11%. */
    turretDamage: 21_000,
    /** Major objective participations. Measured p90; fires ~12%. */
    participations: 5,
    /** Dragon takedowns for "Dragon Tamer". TOP measured p95; fires ~6%. */
    dragonTakedowns: {
      TOP: 2,
      JUNGLE: 4, // derived: the jungler is at nearly every dragon
      MIDDLE: 3, // derived
      BOTTOM: 3, // derived
      UTILITY: 3, // derived
      DEFAULT: 3
    } as RoleScaled,
    /** Baron takedowns for "Baron Slayer". One fired in 35% of games. */
    baronTakedowns: 2
  },

  // --- Vision ---
  vision: {
    /**
     * Vision score for the vision tile, on top of leading the team. The
     * UTILITY figure is high because supports lead team vision almost by
     * default, so the "top on team" half of that rule adds nothing for them.
     */
    strongVisionScore: {
      TOP: 30, // measured p90
      JUNGLE: 42, // derived
      MIDDLE: 32, // derived
      BOTTOM: 28, // derived
      UTILITY: 85, // derived
      DEFAULT: 34
    } as RoleScaled,
    /** Vision score flagged as neglected. TOP measured p10; fires ~11%. */
    weakVisionScore: {
      TOP: 9,
      JUNGLE: 14, // derived
      MIDDLE: 10, // derived
      BOTTOM: 9, // derived
      UTILITY: 22, // derived
      DEFAULT: 11
    } as RoleScaled,
    /** Enemy wards cleared. TOP measured p95 is only 3, hence the low bar. */
    wardsKilled: {
      TOP: 4,
      JUNGLE: 7, // derived
      MIDDLE: 4, // derived
      BOTTOM: 4, // derived
      UTILITY: 13, // derived: sweeping is core to the role
      DEFAULT: 5
    } as RoleScaled,
    /** Control wards placed. TOP measured p90 is 2, so 3 is genuinely notable. */
    controlWards: {
      TOP: 3,
      JUNGLE: 4, // derived
      MIDDLE: 3, // derived
      BOTTOM: 3, // derived
      UTILITY: 6, // derived
      DEFAULT: 4
    } as RoleScaled,
    /** Wards placed. TOP measured p90; fires ~16%. */
    wardsPlaced: {
      TOP: 13,
      JUNGLE: 16, // derived
      MIDDLE: 13, // derived
      BOTTOM: 12, // derived
      UTILITY: 26, // derived
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
  // UNCALIBRATED: the calibration sample is a top laner, whose healing and
  // shielding on teammates is 0 at every percentile. These fire in under 1% of
  // that sample, which tells us nothing about whether they're right for an
  // actual support. Re-measure with --role UTILITY on a support's history.
  support: {
    healsOnTeammates: 5_000,
    shieldedOnTeammates: 5_000,
    /**
     * Minimum assists before leading the team in them counts for anything.
     * Role-scaled and calibrated: supports lead assists almost by default, so
     * the bare "most on team" check alone fired in 71% of their games.
     */
    topAssistsMin: {
      TOP: 8,
      JUNGLE: 12, // derived
      MIDDLE: 10, // derived
      BOTTOM: 10, // derived
      UTILITY: 18, // derived
      DEFAULT: 10
    } as RoleScaled
  },

  // --- Match outcome ---
  outcome: {
    /** Team gold difference for "Stomp". Measured p90; fires ~11%. */
    stompGoldDiff: 12_000,
    /** Deficit the team recovered from. Fires ~3%, appropriately rare. */
    comebackDeficit: 5_000,
    /** Lead the team held before losing. Fires ~5%. */
    throwLead: 5_000
  },

  // --- Filler tier ---
  // Bars for the routine observations that pad a thin panel out to
  // display.minTotal. These sit around the measured median rather than the
  // p90, so they're honest descriptions of an ordinary game rather than
  // praise. They only ever appear when real achievements ran short.
  filler: {
    /** KDA worth mentioning as a positive. Measured median is around 1.6. */
    decentKda: 1.5,
    /** CS/min for "kept farming". TOP measured p50. */
    steadyCsPerMinute: {
      TOP: 7,
      JUNGLE: 5.5, // derived
      MIDDLE: 7, // derived
      BOTTOM: 7.2, // derived
      UTILITY: 0.8, // derived
      DEFAULT: 6.5
    } as RoleScaled,
    /** Share of team damage worth mentioning. Measured p25-p50. */
    fairDamageShare: 0.15,
    /** Wards placed worth mentioning. TOP measured p25. */
    someWards: {
      TOP: 6,
      JUNGLE: 7, // derived
      MIDDLE: 6, // derived
      BOTTOM: 6, // derived
      UTILITY: 12, // derived
      DEFAULT: 7
    } as RoleScaled,
    /** Structure damage worth mentioning. TOP measured p10-p25. */
    someStructureDamage: 4_000,
    /** Seconds alive in one stretch worth mentioning. TOP measured p25. */
    decentLongestLife: 450,
    /** Damage taken worth mentioning as soaking up pressure. */
    someDamageTaken: 20_000,
    /** Kill participation worth mentioning. Around the measured median. */
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
