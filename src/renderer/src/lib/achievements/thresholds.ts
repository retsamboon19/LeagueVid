import type { RoleScaled } from './types'

// Every tunable number for the achievement system, in one place.
//
// This file is meant to be edited freely. Changing a value here re-tunes an
// achievement without touching detection logic, fact extraction, or the UI.
//
// Role-scaled entries exist because a flat threshold is nonsense across
// positions: 8 CS/min is a strong mid and an impossible support, 40 vision
// score is excellent for a top laner and mediocre for a support. Anything
// role-sensitive uses RoleScaled rather than a bare number.
//
// The starting values below are reasoned estimates, not measured percentiles
// -- Riot doesn't publish population distributions, so these want playtesting
// against real matches and adjusting from there.

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
    /** Kills for "Bringer of Carnage". */
    highKills: 10,
    /** Kills for the lesser volume tier. */
    goodKills: 6,
    /** Killing spree length for "Unstoppable". */
    killingSpree: 5,
    /** Solo kills (no ally assist) for "Solo Slayer". */
    soloKills: 3,
    /** Kills before the 15 minute mark for "Early Aggressor". */
    earlyKills: 3,
    /** Kill participation (0..1) for "Team Player". */
    highKillParticipation: 0.7,
    /** Kill participation below which the player looks disengaged. */
    lowKillParticipation: 0.35,
    /** Estimated duel win rate for "Master Duelist" (needs duelMinSample). */
    duelWinRate: 0.65,
    /** Duels needed before a win rate is worth reporting at all. */
    duelMinSample: 3,
    /** Estimated teamfight participation for "Fight Anchor". */
    teamfightParticipation: 0.7,
    /** Teamfight participation below which the player was absent. */
    lowTeamfightParticipation: 0.4,
    /** Teamfights needed before participation is worth reporting. */
    teamfightMinSample: 3,
    /** Tower dives for the dedicated achievement. */
    towerDives: 1,
    /** CC time in seconds for "Lockdown Artist". */
    ccSeconds: 35
  },

  // --- Deaths and survival ---
  survival: {
    /** At or below this counts as a clean game. */
    fewDeaths: 2,
    /** At or above this is flagged as a rough game. */
    manyDeaths: 10,
    /** Deaths before 15 min that signal a rough start. */
    earlyDeaths: 3,
    /** Estimated solo deaths (caught out alone) worth flagging. */
    soloDeaths: 4,
    /** Share of the match spent dead (0..1) worth flagging. */
    deadTimeShare: 0.18,
    /** Seconds alive without dying for "Untouchable". */
    longestLifeSeconds: 900,
    /** Self-mitigated damage for "Iron Wall". */
    selfMitigated: 30_000
  },

  // --- Damage ---
  damage: {
    /** Champion damage for "Ouch You Hurt". */
    highDamage: 30_000,
    /** Share of team damage (0..1) for the damage-carry tile. */
    teamDamageShare: 0.3,
    /** Damage/min, role-scaled, for the damage-rate tile. */
    damagePerMinute: {
      TOP: 700,
      JUNGLE: 650,
      MIDDLE: 800,
      BOTTOM: 850,
      UTILITY: 400,
      DEFAULT: 700
    } as RoleScaled,
    /** Damage/min below which the game reads as low impact. */
    lowDamagePerMinute: {
      TOP: 300,
      JUNGLE: 280,
      MIDDLE: 350,
      BOTTOM: 350,
      UTILITY: 150,
      DEFAULT: 300
    } as RoleScaled
  },

  // --- Farming and economy ---
  farming: {
    /** CS/min for the top farming tile. Supports are excluded in practice. */
    strongCsPerMinute: {
      TOP: 7.5,
      JUNGLE: 6.5,
      MIDDLE: 8,
      BOTTOM: 8.5,
      UTILITY: 3,
      DEFAULT: 7
    } as RoleScaled,
    /** CS/min below which farming slipped. */
    weakCsPerMinute: {
      TOP: 4,
      JUNGLE: 3.5,
      MIDDLE: 4.5,
      BOTTOM: 5,
      UTILITY: 1,
      DEFAULT: 4
    } as RoleScaled,
    /** CS at 10 min for a strong laning start. */
    strongCsAt10: {
      TOP: 70,
      JUNGLE: 60,
      MIDDLE: 75,
      BOTTOM: 75,
      UTILITY: 20,
      DEFAULT: 65
    } as RoleScaled,
    /**
     * Drop in CS/min from the first 15 min to the rest of the game that
     * counts as falling off. Positive number, compared as early - mid.
     */
    midGameDropoff: 2,
    /** Max drop in CS/min still counted as "held it together". */
    consistentDropoff: 0.75,
    /** CS lead over the lane opponent for "Out-Farmed" (positive tile). */
    csLead: 40,
    /** CS deficit vs the lane opponent worth flagging. */
    csDeficit: 40,
    /** Gold lead over the lane opponent for "Lane Dominator". */
    goldLead: 2_000,
    /** Gold/min for "Goblin Hoarder". */
    goldPerMinute: 450
  },

  // --- Objectives and structures ---
  objectives: {
    /** Turret takedowns for "Siege Master". */
    turretKills: 3,
    /** Structure damage for "Wrecking Ball". */
    turretDamage: 10_000,
    /** Objective damage for "Monster Hunter". */
    objectiveDamage: 20_000,
    /** Major objective participations for "Objective Hunter". */
    participations: 5,
    /** Dragon takedowns for "Dragon Tamer". */
    dragonTakedowns: 3
  },

  // --- Vision ---
  vision: {
    /** Vision score, role-scaled, for the vision tile. */
    strongVisionScore: {
      TOP: 25,
      JUNGLE: 35,
      MIDDLE: 28,
      BOTTOM: 25,
      UTILITY: 60,
      DEFAULT: 30
    } as RoleScaled,
    /** Vision score below which vision was neglected. */
    weakVisionScore: {
      TOP: 10,
      JUNGLE: 14,
      MIDDLE: 11,
      BOTTOM: 10,
      UTILITY: 25,
      DEFAULT: 12
    } as RoleScaled,
    /** Enemy wards cleared for "Servant of Darkness". */
    wardsKilled: 8,
    /** Control wards placed for "Control Freak". */
    controlWards: 5,
    /** Wards placed, role-scaled, for the ward-provider tile. */
    wardsPlaced: {
      TOP: 12,
      JUNGLE: 16,
      MIDDLE: 12,
      BOTTOM: 12,
      UTILITY: 25,
      DEFAULT: 14
    } as RoleScaled
  },

  // --- Support utility ---
  support: {
    /** Healing on teammates for "Field Medic". */
    healsOnTeammates: 5_000,
    /** Shielding on teammates for "Guardian". */
    shieldedOnTeammates: 5_000
  },

  // --- Match outcome ---
  outcome: {
    /** Team gold difference for "Stomp". */
    stompGoldDiff: 8_000,
    /** Deficit the team recovered from for "Comeback King". */
    comebackDeficit: 5_000,
    /** Lead the team held before losing, for "Slipped Away". */
    throwLead: 5_000
  },

  // --- Display ---
  display: {
    /** Hard cap on tiles shown, matching the panel layout. */
    maxTotal: 6,
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
