import type { StatsParticipant } from '../../../../shared/types'

// Shared formatting/derivation helpers for the match stats panel.
//
// The recurring theme here: absent data must never be rendered as 0. A
// missing challenge field means Riot didn't report it (older match, or a
// field Riot has since removed), which is different from the player scoring
// zero. Every helper below distinguishes the two by returning null.

export function formatGameClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(totalSeconds / 60)
  const ss = totalSeconds % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

export function formatCompactNumber(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`
  return value.toLocaleString()
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`
}

export function formatSigned(value: number): string {
  return value >= 0 ? `+${value.toLocaleString()}` : value.toLocaleString()
}

/** KDA ratio, or 'Perfect' on a deathless game. */
export function kdaRatioText(p: StatsParticipant): string {
  if (p.deaths === 0) return 'Perfect'
  return ((p.kills + p.assists) / p.deaths).toFixed(2)
}

/** Numeric KDA for sorting. Deathless games sort above everything else. */
export function kdaRatioValue(p: StatsParticipant): number {
  if (p.deaths === 0) return Number.POSITIVE_INFINITY
  return (p.kills + p.assists) / p.deaths
}

export function csPerMinute(p: StatsParticipant, gameDurationSeconds: number): number | null {
  if (!gameDurationSeconds) return null
  return p.cs / (gameDurationSeconds / 60)
}

/**
 * Reads a Riot "challenge" value, returning null when the field is absent.
 * Callers render null as "unavailable" rather than as a zero.
 */
export function challenge(p: StatsParticipant, key: string): number | null {
  const value = p.challenges?.[key]
  return typeof value === 'number' ? value : null
}

/** Enemy laner: same position, other team. */
export function findLaneOpponent(
  participants: StatsParticipant[],
  focus: StatsParticipant
): StatsParticipant | null {
  if (!focus.teamPosition || focus.teamPosition === 'Invalid') return null
  return (
    participants.find(
      (p) => p.teamId !== focus.teamId && p.teamPosition === focus.teamPosition
    ) ?? null
  )
}

export function positionLabel(teamPosition: string): string {
  switch (teamPosition) {
    case 'TOP':
      return 'Top'
    case 'JUNGLE':
      return 'Jungle'
    case 'MIDDLE':
      return 'Mid'
    case 'BOTTOM':
      return 'Bot'
    case 'UTILITY':
      return 'Support'
    default:
      return teamPosition || 'Unknown'
  }
}

export const SKILL_SLOT_LABELS: Record<number, string> = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' }
