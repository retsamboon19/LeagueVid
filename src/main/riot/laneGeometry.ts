// Summoner's Rift map geometry: turret positions, lane corridors, and the
// role/lane relationships derived from them.
//
// None of this comes from the API. Riot's timeline reports building kills but
// never where a standing turret is, and it has no notion of a "lane region" at
// all, so both are static tables sourced from the map's known bounds
// (x: -120..14870, y: -120..14980).
//
// Lives in its own module because two features need the same coordinates:
// tower-dive detection (extractEvents.ts) and gank detection
// (gankAnalyzer.ts). Two copies of the map would eventually disagree.

export interface Pt {
  x: number
  y: number
}

export interface TurretPos extends Pt {
  /** 100 = blue side, 200 = red side, matching Riot's participant.teamId. */
  teamId: number
}

// Order matters: the lane polylines below index into this array, and
// computeTurretDestructions in extractEvents.ts tracks destroyed turrets by
// index. Append rather than reorder.
export const TURRET_POSITIONS: TurretPos[] = [
  { x: 981, y: 10441, teamId: 100 }, // 0  BLUE_TOP_LANE_OUTER_TURRET
  { x: 1512, y: 6699, teamId: 100 }, // 1  BLUE_TOP_LANE_INNER_TURRET
  { x: 1169, y: 4287, teamId: 100 }, // 2  BLUE_TOP_LANE_BASE_TURRET
  { x: 5846, y: 6396, teamId: 100 }, // 3  BLUE_MID_LANE_OUTER_TURRET
  { x: 5048, y: 4812, teamId: 100 }, // 4  BLUE_MID_LANE_INNER_TURRET
  { x: 3651, y: 3696, teamId: 100 }, // 5  BLUE_MID_LANE_BASE_TURRET
  { x: 10504, y: 1029, teamId: 100 }, // 6  BLUE_BOT_LANE_OUTER_TURRET
  { x: 6919, y: 1483, teamId: 100 }, // 7  BLUE_BOT_LANE_INNER_TURRET
  { x: 4281, y: 1253, teamId: 100 }, // 8  BLUE_BOT_LANE_BASE_TURRET
  { x: 1748, y: 2270, teamId: 100 }, // 9  BLUE_TOP_LANE_NEXUS_TURRET
  { x: 2177, y: 1807, teamId: 100 }, // 10 BLUE_BOT_LANE_NEXUS_TURRET
  { x: 4318, y: 13875, teamId: 200 }, // 11 RED_TOP_LANE_OUTER_TURRET
  { x: 7943, y: 13411, teamId: 200 }, // 12 RED_TOP_LANE_INNER_TURRET
  { x: 10481, y: 13650, teamId: 200 }, // 13 RED_TOP_LANE_BASE_TURRET
  { x: 8955, y: 8510, teamId: 200 }, // 14 RED_MID_LANE_OUTER_TURRET
  { x: 9767, y: 10113, teamId: 200 }, // 15 RED_MID_LANE_INNER_TURRET
  { x: 11134, y: 11207, teamId: 200 }, // 16 RED_MID_LANE_BASE_TURRET
  { x: 13866, y: 4505, teamId: 200 }, // 17 RED_BOT_LANE_OUTER_TURRET
  { x: 13327, y: 8226, teamId: 200 }, // 18 RED_BOT_LANE_INNER_TURRET
  { x: 13624, y: 10572, teamId: 200 }, // 19 RED_BOT_LANE_BASE_TURRET
  { x: 12611, y: 13084, teamId: 200 }, // 20 RED_TOP_LANE_NEXUS_TURRET
  { x: 13052, y: 12612, teamId: 200 } // 21 RED_BOT_LANE_NEXUS_TURRET
]

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// --- Lane corridors ------------------------------------------------------
//
// Each lane is a polyline threaded through its own turrets from one base to
// the other, and a point counts as "in lane" when its perpendicular distance
// to that polyline is within LANE_HALF_WIDTH. Top and bottom also need the
// outside corner they bend around, which no turret sits on; mid needs both
// base ends, since the lane continues past the base turrets into the fountain.
//
// This reproduces the light-green playable lane region of the minimap: an
// outer ring formed by top and bottom, crossed by the mid diagonal.

/** Top-left corner, where top lane turns from the left edge to the top edge. */
const CORNER_TOP_LEFT: Pt = { x: 1800, y: 12800 }
/** Bottom-right corner, where bottom lane turns from the bottom to the right. */
const CORNER_BOTTOM_RIGHT: Pt = { x: 12800, y: 1800 }
/** Lane ends inside each base, past the nexus turrets. */
const BLUE_BASE: Pt = { x: 2200, y: 2200 }
const RED_BASE: Pt = { x: 12600, y: 12600 }

const t = (index: number): Pt => TURRET_POSITIONS[index]

export const TOP_LANE: Pt[] = [t(9), t(2), t(1), t(0), CORNER_TOP_LEFT, t(11), t(12), t(13), t(20)]

export const BOT_LANE: Pt[] = [
  t(10),
  t(8),
  t(7),
  t(6),
  CORNER_BOTTOM_RIGHT,
  t(17),
  t(18),
  t(19),
  t(21)
]

export const MID_LANE: Pt[] = [BLUE_BASE, t(5), t(4), t(3), t(14), t(15), t(16), RED_BASE]

/**
 * Half the width of a lane corridor, in map units.
 *
 * Calibrated in scripts/probe-gank-deaths.ts against a falsifiable control:
 * deaths whose only enemy is the victim's own lane opponent are fair lane
 * duels, so they should register as in-lane. At this width 93.6% of them do
 * (89.7% at 1000, 97.6% at 2500). Going wider keeps swallowing river and
 * jungle fights that are not lane events, so this is the knee of that curve.
 */
export const LANE_HALF_WIDTH = 1500

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return distance(p, a)
  // Projection of p onto the segment, clamped to its ends.
  const tRaw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared
  const clamped = Math.max(0, Math.min(1, tRaw))
  return Math.hypot(p.x - (a.x + clamped * dx), p.y - (a.y + clamped * dy))
}

/** Shortest distance from a point to a lane's centre line. */
export function distanceToLane(p: Pt, lane: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < lane.length - 1; i++) {
    const d = distanceToSegment(p, lane[i], lane[i + 1])
    if (d < best) best = d
  }
  return best
}

export function isInLane(p: Pt, lane: Pt[], halfWidth = LANE_HALF_WIDTH): boolean {
  return distanceToLane(p, lane) <= halfWidth
}

/**
 * The lane a role is responsible for, or null when it has none.
 *
 * JUNGLE returns null deliberately: a jungler has no lane to be ganked in, so
 * every lane-relative stat must report "unavailable" for them rather than 0.
 * Otherwise every jungle game would look like a flawless no-gank performance.
 */
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
 * Enemy roles whose presence in a fight is the normal lane matchup for a given
 * role. Anyone outside this set is a third party -- the basis of gank
 * detection.
 *
 * Bot lane returns BOTTOM and UTILITY together because a 2v2 down there is the
 * default state of the game, not a gank. Counting "the kill had an assist" as
 * a gank instead misclassified 3,084 deaths in the probe, every one of them in
 * those two roles and none in TOP or MIDDLE.
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
