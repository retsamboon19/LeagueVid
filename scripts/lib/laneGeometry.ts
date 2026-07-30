// Summoner's Rift lane geometry, shared by the gank probes.
//
// The app has no lane regions -- only the static turret table in
// src/main/riot/extractEvents.ts. Lanes are modelled here as polylines
// threaded through those known turret coordinates, plus the two outside
// corners the lanes bend around (top-left and bottom-right), which no turret
// sits on. A point is "in lane" when its perpendicular distance to the
// polyline is within a corridor half-width.
//
// Validated by probe-gank-deaths.ts against a falsifiable control: deaths
// whose only enemy is the victim's own lane opponent are fair lane duels and
// so should be in-lane. They land 93.6% inside a 1500-unit corridor
// (89.7% at 1000, 97.6% at 2500), which is why LANE_HALF_WIDTH is 1500.
//
// If this moves into src/main/riot/ for the real implementation, the turret
// table in extractEvents.ts should become the single source of the anchor
// coordinates rather than them being repeated here.

export interface Pt {
  x: number
  y: number
}

export const TOP_LANE: Pt[] = [
  { x: 1748, y: 2270 },
  { x: 1169, y: 4287 },
  { x: 1512, y: 6699 },
  { x: 981, y: 10441 },
  { x: 1800, y: 12800 }, // top-left corner, no turret here
  { x: 4318, y: 13875 },
  { x: 7943, y: 13411 },
  { x: 10481, y: 13650 },
  { x: 12611, y: 13084 }
]

export const BOT_LANE: Pt[] = [
  { x: 2177, y: 1807 },
  { x: 4281, y: 1253 },
  { x: 6919, y: 1483 },
  { x: 10504, y: 1029 },
  { x: 12800, y: 1800 }, // bottom-right corner
  { x: 13866, y: 4505 },
  { x: 13327, y: 8226 },
  { x: 13624, y: 10572 },
  { x: 13052, y: 12612 }
]

export const MID_LANE: Pt[] = [
  { x: 2200, y: 2200 },
  { x: 3651, y: 3696 },
  { x: 5048, y: 4812 },
  { x: 5846, y: 6396 },
  { x: 8955, y: 8510 },
  { x: 9767, y: 10113 },
  { x: 11134, y: 11207 },
  { x: 12600, y: 12600 }
]

export const LANE_HALF_WIDTH = 1500

/** End of the laning phase, matching EARLY_PHASE_END_MS in the app. */
export const EARLY_MS = 15 * 60 * 1000

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function distToLane(p: Pt, lane: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < lane.length - 1; i++) {
    const d = distToSegment(p, lane[i], lane[i + 1])
    if (d < best) best = d
  }
  return best
}

/** The lane a role is responsible for. JUNGLE has none. */
export function laneForRole(role: string): Pt[] | null {
  switch (role) {
    case 'TOP':
      return TOP_LANE
    case 'MIDDLE':
      return MID_LANE
    case 'BOTTOM':
    case 'UTILITY':
      return BOT_LANE
    default:
      return null
  }
}

/**
 * Enemy roles whose presence in a fight is "expected" for a given role, i.e.
 * the normal lane matchup. Anyone outside this set is a third party.
 *
 * Bot lane returns both BOTTOM and UTILITY because a 2v2 there is the normal
 * state, not a gank -- treating an assisted kill as a gank misclassified
 * 3,084 deaths, all of them in those two roles (see probe-gank-deaths.ts).
 */
export function expectedOpponentRoles(role: string): string[] {
  switch (role) {
    case 'TOP':
      return ['TOP']
    case 'MIDDLE':
      return ['MIDDLE']
    case 'BOTTOM':
    case 'UTILITY':
      return ['BOTTOM', 'UTILITY']
    default:
      return []
  }
}

export const LANE_ROLES = ['TOP', 'MIDDLE', 'BOTTOM', 'UTILITY']
