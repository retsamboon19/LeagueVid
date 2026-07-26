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
  const myKills: KillMoment[] = []

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
            myKills.push({
              timestampMs: ev.timestamp,
              hadAllyAssist: (ev.assistingParticipantIds ?? []).length > 0
            })
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
