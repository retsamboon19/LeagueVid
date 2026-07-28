import type { MatchInfoDto, MatchTimelineDto } from './types'
import type { AutoTagEvent, AutoTagType } from '../../shared/types'
import { MULTIKILL_LABELS, multiKillTagType } from '../../shared/types'

export type { AutoTagEvent, AutoTagType }

/** Lane name as it reads in the client, e.g. TOP_LANE -> top. */
function laneName(laneType: string | undefined): string {
  if (!laneType) return ''
  return laneType.replace('_LANE', '').toLowerCase().replace('bot', 'bottom')
}

/**
 * Human-readable structure name, e.g. "Outer turret destroyed (bottom)" or
 * "Inhibitor destroyed (mid)".
 */
function describeBuilding(
  buildingType: string | undefined,
  towerType: string | undefined,
  laneType: string | undefined
): string {
  const lane = laneName(laneType)
  const suffix = lane ? ` (${lane})` : ''

  if (buildingType === 'INHIBITOR_BUILDING') return `Inhibitor destroyed${suffix}`

  switch (towerType) {
    case 'OUTER_TURRET':
      return `Outer turret destroyed${suffix}`
    case 'INNER_TURRET':
      return `Inner turret destroyed${suffix}`
    case 'BASE_TURRET':
      // The turret in front of the inhibitor -- the client calls this the
      // inhibitor turret, which is what the user recognises it as.
      return `Inhibitor turret destroyed${suffix}`
    case 'NEXUS_TURRET':
      return 'Nexus turret destroyed'
    default:
      return `Turret destroyed${suffix}`
  }
}

/**
 * Extracts tag-worthy events for a specific participant from a match timeline.
 * participantId is the 1-10 index used within timeline frames (NOT the puuid).
 */
// League's multikill window: a kill continues the streak if it lands within
// this long after the previous one.
//
// Riot's timeline does NOT report multikills -- verified against 3,363 kill
// events in cached data, none of which carried a multiKillLength field. They
// have to be derived. Deriving with this 10s window and counting every tier a
// streak passes through (a triple also counts as a double, which is how the
// game itself tallies them) reproduced Riot's own doubleKills/tripleKills/
// quadraKills/pentaKills totals for 202 of 203 players -- 99.5%. Wider
// windows fit progressively worse (11s: 92%, 12s: 88%, 15s: 77%), so this
// value isn't arbitrary.
const MULTIKILL_WINDOW_MS = 10_000

// Static Summoner's Rift turret coordinates (map11). These don't come from
// the API -- Riot's timeline only reports building kills, not where every
// standing turret is at any given moment -- so they're a fixed table
// sourced from the map's known bounds/positions (x: -120..14870, y: -120..
// 14980). teamId 100 = blue side, 200 = red side, matching Riot's
// participant.teamId values.
interface TurretPos {
  x: number
  y: number
  teamId: number
}

const TURRET_POSITIONS: TurretPos[] = [
  { x: 981, y: 10441, teamId: 100 }, // BLUE_TOP_LANE_OUTER_TURRET
  { x: 1512, y: 6699, teamId: 100 }, // BLUE_TOP_LANE_INNER_TURRET
  { x: 1169, y: 4287, teamId: 100 }, // BLUE_TOP_LANE_BASE_TURRET
  { x: 5846, y: 6396, teamId: 100 }, // BLUE_MID_LANE_OUTER_TURRET
  { x: 5048, y: 4812, teamId: 100 }, // BLUE_MID_LANE_INNER_TURRET
  { x: 3651, y: 3696, teamId: 100 }, // BLUE_MID_LANE_BASE_TURRET
  { x: 10504, y: 1029, teamId: 100 }, // BLUE_BOT_LANE_OUTER_TURRET
  { x: 6919, y: 1483, teamId: 100 }, // BLUE_BOT_LANE_INNER_TURRET
  { x: 4281, y: 1253, teamId: 100 }, // BLUE_BOT_LANE_BASE_TURRET
  { x: 1748, y: 2270, teamId: 100 }, // BLUE_TOP_LANE_NEXUS_TURRET
  { x: 2177, y: 1807, teamId: 100 }, // BLUE_BOT_LANE_NEXUS_TURRET
  { x: 4318, y: 13875, teamId: 200 }, // RED_TOP_LANE_OUTER_TURRET
  { x: 7943, y: 13411, teamId: 200 }, // RED_TOP_LANE_INNER_TURRET
  { x: 10481, y: 13650, teamId: 200 }, // RED_TOP_LANE_BASE_TURRET
  { x: 8955, y: 8510, teamId: 200 }, // RED_MID_LANE_OUTER_TURRET
  { x: 9767, y: 10113, teamId: 200 }, // RED_MID_LANE_INNER_TURRET
  { x: 11134, y: 11207, teamId: 200 }, // RED_MID_LANE_BASE_TURRET
  { x: 13866, y: 4505, teamId: 200 }, // RED_BOT_LANE_OUTER_TURRET
  { x: 13327, y: 8226, teamId: 200 }, // RED_BOT_LANE_INNER_TURRET
  { x: 13624, y: 10572, teamId: 200 }, // RED_BOT_LANE_BASE_TURRET
  { x: 12611, y: 13084, teamId: 200 }, // RED_TOP_LANE_NEXUS_TURRET
  { x: 13052, y: 12612, teamId: 200 } // RED_BOT_LANE_NEXUS_TURRET
]

// Turret attack range is 775 units. A little slack is added since the kill
// position is the victim's death spot, not necessarily exactly where the
// turret's hitbox line is drawn -- without it, dives that were obviously
// "under tower" by eye were landing just outside 775 and getting missed.
const TOWER_DIVE_RANGE = 775 + 100

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * True if the given position is within an enemy turret's attack range.
 * `standingTurrets` should already exclude turrets destroyed by this point
 * in the game (see standingEnemyTurrets) -- a dead turret can't be why a
 * kill happened under it.
 */
function isUnderEnemyTurret(
  position: { x: number; y: number } | undefined,
  myTeamId: number,
  standingTurrets: TurretPos[]
): boolean {
  if (!position) return false
  return standingTurrets.some(
    (t) => t.teamId !== myTeamId && distance(position, t) <= TOWER_DIVE_RANGE
  )
}

interface TurretDestruction {
  timestampMs: number
  turretIndex: number
}

/**
 * Matches every non-inhibitor BUILDING_KILL in the timeline to the nearest
 * still-standing turret in TURRET_POSITIONS, in chronological order. This is
 * needed because a turret that's already down by the time of a later kill
 * can't be the reason that kill happened "under tower" -- without tracking
 * this, a dive into a lane whose outer turret fell at minute 8 would still
 * get flagged at minute 25.
 */
function computeTurretDestructions(timeline: MatchTimelineDto): TurretDestruction[] {
  const buildingKills: Array<{ timestamp: number; position?: { x: number; y: number } }> = []
  for (const frame of timeline.info.frames) {
    for (const ev of frame.events) {
      if (ev.type === 'BUILDING_KILL' && ev.buildingType !== 'INHIBITOR_BUILDING') {
        buildingKills.push({ timestamp: ev.timestamp, position: ev.position })
      }
    }
  }
  buildingKills.sort((a, b) => a.timestamp - b.timestamp)

  const destroyed = new Set<number>()
  const destructions: TurretDestruction[] = []
  for (const bk of buildingKills) {
    if (!bk.position) continue
    let bestIndex = -1
    let bestDist = Infinity
    for (let i = 0; i < TURRET_POSITIONS.length; i++) {
      if (destroyed.has(i)) continue
      const d = distance(bk.position, TURRET_POSITIONS[i])
      if (d < bestDist) {
        bestDist = d
        bestIndex = i
      }
    }
    if (bestIndex !== -1) {
      destroyed.add(bestIndex)
      destructions.push({ timestampMs: bk.timestamp, turretIndex: bestIndex })
    }
  }
  return destructions
}

/** Enemy turrets still standing at a given game timestamp. */
function standingEnemyTurrets(
  destructions: TurretDestruction[],
  timestampMs: number,
  myTeamId: number
): TurretPos[] {
  return TURRET_POSITIONS.filter((t, i) => {
    if (t.teamId === myTeamId) return false
    return !destructions.some((d) => d.turretIndex === i && d.timestampMs <= timestampMs)
  })
}

interface KillMoment {
  timestampMs: number
  hadAllyAssist: boolean
}

interface KillStreak {
  kills: KillMoment[]
  /** Timestamp of the kill that completed the streak. */
  completedAtMs: number
  length: number
  /** True when no ally assisted on any kill in the streak. */
  solo: boolean
}

/** Groups one player's kills into streaks using the multikill window. */
function findKillStreaks(kills: KillMoment[]): KillStreak[] {
  const streaks: KillStreak[] = []
  let current: KillMoment[] = []

  const flush = (): void => {
    if (current.length === 0) return
    streaks.push({
      kills: current,
      completedAtMs: current[current.length - 1].timestampMs,
      length: current.length,
      solo: current.every((k) => !k.hadAllyAssist)
    })
    current = []
  }

  for (const kill of kills) {
    const previous = current[current.length - 1]
    if (previous && kill.timestampMs - previous.timestampMs <= MULTIKILL_WINDOW_MS) {
      current.push(kill)
    } else {
      flush()
      current = [kill]
    }
  }
  flush()

  return streaks
}

export function extractPlayerEvents(
  timeline: MatchTimelineDto,
  participantId: number,
  matchInfo: MatchInfoDto
): AutoTagEvent[] {
  const events: AutoTagEvent[] = []
  const participant = matchInfo.participants.find((p) => p.participantId === participantId)
  const championName = participant?.championName ?? 'Unknown'
  const myTeamId = participant?.teamId
  const myKills: KillMoment[] = []
  const turretDestructions = computeTurretDestructions(timeline)

  for (const frame of timeline.info.frames) {
    for (const ev of frame.events) {
      switch (ev.type) {
        case 'CHAMPION_KILL': {
          if (ev.killerId === participantId) {
            events.push({
              type: 'kill',
              gameTimestampMs: ev.timestamp,
              label: `Kill (${championName})`
            })
            // Collected for streak detection after the whole timeline is
            // walked, since a streak can only be judged in context.
            const hadAllyAssist = (ev.assistingParticipantIds ?? []).length > 0
            myKills.push({
              timestampMs: ev.timestamp,
              hadAllyAssist
            })

            // "Tower dive" bookmark: a solo kill (no ally assist) landed
            // inside a still-standing enemy turret's attack range. Riot
            // doesn't report this directly -- it's derived from the kill's
            // map position against the static turret table above.
            if (
              !hadAllyAssist &&
              myTeamId !== undefined &&
              isUnderEnemyTurret(
                ev.position,
                myTeamId,
                standingEnemyTurrets(turretDestructions, ev.timestamp, myTeamId)
              )
            ) {
              events.push({
                type: 'towerdive',
                gameTimestampMs: ev.timestamp,
                label: `Solo kill under tower (${championName})`,
                detail: 'solo'
              })
            }
          } else if (ev.victimId === participantId) {
            events.push({
              type: 'death',
              gameTimestampMs: ev.timestamp,
              label: `Death (${championName})`
            })
          } else if (ev.assistingParticipantIds?.includes(participantId)) {
            events.push({
              type: 'assist',
              gameTimestampMs: ev.timestamp,
              label: `Assist (${championName})`
            })
          }
          break
        }
        case 'BUILDING_KILL': {
          if (ev.killerId === participantId) {
            const isInhibitor = ev.buildingType === 'INHIBITOR_BUILDING'
            events.push({
              type: isInhibitor ? 'inhibitor' : 'turret',
              gameTimestampMs: ev.timestamp,
              // "Building destroyed" was too vague to be useful -- name the
              // actual structure and lane, since which turret fell is the
              // whole point of the bookmark.
              label: describeBuilding(ev.buildingType, ev.towerType, ev.laneType),
              detail: ev.towerType ?? ev.buildingType
            })
          }
          break
        }
        case 'ELITE_MONSTER_KILL': {
          if (ev.killerId === participantId) {
            const monster = (ev.monsterType ?? '').toUpperCase()
            const type: AutoTagType = monster.includes('DRAGON')
              ? 'dragon'
              : monster.includes('BARON')
                ? 'baron'
                : monster.includes('RIFTHERALD')
                  ? 'herald'
                  : 'other_objective'
            events.push({
              type,
              gameTimestampMs: ev.timestamp,
              label: `${monster.replace(/_/g, ' ')} secured`
            })
          }
          break
        }
        default:
          break
      }
    }
  }

  // Multikills, derived from the collected kills (see MULTIKILL_WINDOW_MS).
  // One marker per streak, placed on the kill that completed it, so a
  // pentakill is a single "Penta kill" bookmark rather than four markers.
  for (const streak of findKillStreaks(myKills)) {
    if (streak.length < 2) continue
    const tier = Math.min(streak.length, 5)
    const name = MULTIKILL_LABELS[tier] ?? `${streak.length} kills`
    events.push({
      type: multiKillTagType(streak.length),
      gameTimestampMs: streak.completedAtMs,
      // "Solo" (no ally assisted on any kill in the streak) is called out
      // because an unassisted multikill is the interesting kind.
      label: `${name}${streak.solo ? ' (solo)' : ''} (${championName})`,
      detail: streak.solo ? 'solo' : undefined
    })
  }

  return events.sort((a, b) => a.gameTimestampMs - b.gameTimestampMs)
}
