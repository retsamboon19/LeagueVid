import type { GankEvent, GankStats } from '../../shared/types'
import {
  LANE_HALF_WIDTH,
  type Pt,
  distance,
  distanceToLane,
  expectedOpponentRoles,
  laneForRole
} from './laneGeometry'
import type { TimelineFrameDto } from './types'

// Derives early-game gank statistics, which Riot does not provide in any form.
//
// A gank is defined here as pressure from a THIRD PARTY -- someone who isn't
// part of your normal lane matchup -- inside your own lane during the laning
// phase. Both halves of that matter:
//
//   - "third party", not "more than one enemy". Bot lane is a 2v2 by default,
//     so dying to the enemy ADC and support is just lane. Reading any assisted
//     kill as a gank misclassified 3,084 deaths in the calibration probe, all
//     of them BOTTOM or UTILITY and none TOP or MIDDLE. Conversely a jungler
//     who dives in and does all the damage himself leaves no assist at all,
//     and that is the textbook gank -- 612 of those would have been missed.
//
//   - "in your own lane", from the corridor geometry in laneGeometry.ts.
//     Dropping this filter pulls in roams, invades and river skirmishes: it
//     accounts for 3,005 of 8,608 third-party early deaths, over a third.
//
// Gankers are not assumed to be junglers. Measured across 843 games, junglers
// were 74.4% of them, with mid roams at 11.1% and the rest spread over
// support, top and bottom.
//
// Everything here is a heuristic and must be surfaced with the UI's "est."
// marker, never as an official Riot number.

/** The laning phase, matching EARLY_PHASE_END_MS in matchStats.ts. */
const EARLY_PHASE_END_MS = 15 * 60 * 1000

/**
 * Riot's nominal minute frames drift a few milliseconds on every sample. In
 * almost every calibration timeline the frame representing 15:00 therefore
 * arrives just after 900,000ms. Admit only a small bounded overrun, then clamp
 * that approximate sample back to 15:00 so the laning window is not extended.
 */
const EARLY_FRAME_DRIFT_TOLERANCE_MS = 5_000

/**
 * How close a third party has to be to the player to count as ganking them,
 * rather than merely standing somewhere in the same long corridor.
 *
 * This proximity test is what makes attempt detection work at all. Requiring
 * only "both inside the lane corridor" gives a lift of 3.2x over the baseline
 * gank-death rate; adding proximity raises it to 6.2x, and the sampled frame's
 * gank-death rate from 20.0% to 43.9%. Tightening further to 1500 buys little
 * (6.5x) while missing gankers still closing the distance, since a frame can
 * catch them mid-approach.
 */
const GANK_PROXIMITY = 2000

/**
 * A sampled attempt is treated as fatal if a gank death lands within this long
 * either side of the frame. Frames are 60s apart, so the window has to be
 * generous enough to bridge a gank that started before the frame and resolved
 * after it.
 */
const ATTEMPT_DEATH_WINDOW_MS = 45_000

/**
 * If the player dies this soon around killing a ganker, it was a trade rather
 * than a gank turned around.
 */
const TRADE_WINDOW_MS = 20_000

export interface GankParticipant {
  participantId: number
  teamId: number
  /** TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY, or '' when unknown. */
  role: string
}

interface EarlyKill {
  timestampMs: number
  victimId: number
  /** Enemies of the victim credited as killer or assister. */
  enemyIds: number[]
  /** Everyone credited on the killing side, used to check the player took part. */
  killerSideIds: number[]
  position: Pt
}

interface FramePositions {
  timestampMs: number
  positions: Map<number, Pt>
}

function collectEarlyKills(
  frames: TimelineFrameDto[],
  teamById: Map<number, number>
): EarlyKill[] {
  const kills: EarlyKill[] = []

  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (event.type !== 'CHAMPION_KILL') continue
      if (event.timestamp > EARLY_PHASE_END_MS) continue
      const victimId = event.victimId
      // Position is required: without it there is no lane test. Measured
      // present on 100% of early kills, so this never discards real data.
      if (!victimId || !event.position) continue

      const victimTeam = teamById.get(victimId)
      // killerId 0 means an execution or a turret/minion kill.
      const credited = [event.killerId ?? 0, ...(event.assistingParticipantIds ?? [])].filter(
        (id) => id > 0
      )

      kills.push({
        timestampMs: event.timestamp,
        victimId,
        enemyIds: credited.filter((id) => teamById.get(id) !== victimTeam),
        killerSideIds: credited,
        position: event.position
      })
    }
  }

  return kills.sort((a, b) => a.timestampMs - b.timestampMs)
}

function collectEarlyFrames(frames: TimelineFrameDto[]): FramePositions[] {
  const out: FramePositions[] = []

  for (const frame of frames) {
    if (frame.timestamp > EARLY_PHASE_END_MS + EARLY_FRAME_DRIFT_TOLERANCE_MS) continue
    // The frame at 0ms has everyone stood in the fountain, which would read as
    // ten players sharing a lane.
    if (frame.timestamp === 0) continue

    const positions = new Map<number, Pt>()
    for (const pf of Object.values(frame.participantFrames ?? {})) {
      if (pf.position) positions.set(pf.participantId, pf.position)
    }
    if (positions.size > 0) {
      out.push({
        // A slightly late frame is still Riot's nominal 15:00 sample. Keep its
        // public event time inside the early-phase boundary too.
        timestampMs: Math.min(frame.timestamp, EARLY_PHASE_END_MS),
        positions
      })
    }
  }

  return out.sort((a, b) => a.timestampMs - b.timestampMs)
}

/**
 * Gank stats for every LANE participant, keyed by participantId.
 *
 * Junglers are deliberately absent from the result rather than present with
 * zeros: they have no lane, so the honest answer is "not applicable" and the
 * renderer should show it as unavailable.
 *
 * Only meaningful on Summoner's Rift -- the lane geometry is that map. Callers
 * must skip other modes.
 */
export function analyzeGanks(
  frames: TimelineFrameDto[],
  participants: GankParticipant[]
): Record<number, GankStats> {
  const result: Record<number, GankStats> = {}
  if (frames.length === 0) return result

  const teamById = new Map<number, number>()
  const roleById = new Map<number, string>()
  for (const p of participants) {
    teamById.set(p.participantId, p.teamId)
    roleById.set(p.participantId, p.role)
  }

  const kills = collectEarlyKills(frames, teamById)
  const earlyFrames = collectEarlyFrames(frames)

  for (const me of participants) {
    const lane = laneForRole(me.role)
    if (!lane) continue // jungle, or an unknown position

    const expected = expectedOpponentRoles(me.role)
    const isThirdParty = (id: number): boolean =>
      teamById.get(id) !== me.teamId && !expected.includes(roleById.get(id) ?? '')

    const thirdPartyIds = participants
      .map((p) => p.participantId)
      .filter((id) => isThirdParty(id))

    // --- Deaths to ganks: a third party helped kill me inside my own lane ---
    const gankDeaths = kills.filter(
      (k) =>
        k.victimId === me.participantId &&
        distanceToLane(k.position, lane) <= LANE_HALF_WIDTH &&
        k.enemyIds.some(isThirdParty)
    )
    const gankDeathTimes = gankDeaths.map((k) => k.timestampMs)

    const myDeathTimes = kills
      .filter((k) => k.victimId === me.participantId)
      .map((k) => k.timestampMs)

    // Each detected gank is also emitted as a reviewable row, so the counts can
    // be checked against the video rather than taken on trust.
    const events: GankEvent[] = gankDeaths.map((k) => ({
      timestampMs: k.timestampMs,
      outcome: 'died' as const,
      gankerParticipantIds: k.enemyIds.filter(isThirdParty),
      approximateTime: false
    }))

    // --- Attempts: exact fatal ganks plus sampled nonfatal pressure ---
    //
    // Every fatal gank is definitionally an attempt, even when it begins and
    // ends between Riot's 60s position samples. Seed the count from exact kill
    // events, then add sampled attempts only when they do not cover one of
    // those deaths. Consecutive firing frames are still merged into one attempt,
    // otherwise a support parked in lane for three minutes would read as three.
    let attempts = gankDeaths.length
    let survived = 0
    let firedOnPreviousFrame = false
    const matchedDeathIndexes = new Set<number>()
    // Survived attempts, held aside so a turnaround can absorb the one it
    // belongs to instead of the list showing the same gank twice.
    const survivedEvents: GankEvent[] = []

    for (const frame of earlyFrames) {
      const myPos = frame.positions.get(me.participantId)
      // No position means dead or not yet reported; either way not being ganked.
      if (!myPos) {
        firedOnPreviousFrame = false
        continue
      }

      let gankersHere: number[] = []
      if (distanceToLane(myPos, lane) <= LANE_HALF_WIDTH) {
        gankersHere = thirdPartyIds.filter((id) => {
          const theirPos = frame.positions.get(id)
          if (!theirPos) return false
          if (distanceToLane(theirPos, lane) > LANE_HALF_WIDTH) return false
          return distance(theirPos, myPos) <= GANK_PROXIMITY
        })
      }
      const fired = gankersHere.length > 0

      if (fired && !firedOnPreviousFrame) {
        // Match at most one exact death to this sampled presence. The death has
        // already seeded attempts, so counting the frame too would report one
        // fatal gank twice. Nearest wins if a rare window contains two deaths.
        let fatalIndex = -1
        let nearestDeathDistance = Number.POSITIVE_INFINITY
        for (let i = 0; i < gankDeathTimes.length; i++) {
          if (matchedDeathIndexes.has(i)) continue
          const deathDistance = Math.abs(gankDeathTimes[i] - frame.timestampMs)
          if (
            deathDistance <= ATTEMPT_DEATH_WINDOW_MS &&
            deathDistance < nearestDeathDistance
          ) {
            fatalIndex = i
            nearestDeathDistance = deathDistance
          }
        }

        if (fatalIndex >= 0) {
          matchedDeathIndexes.add(fatalIndex)
        } else {
          attempts++
          survived++
          survivedEvents.push({
            timestampMs: frame.timestampMs,
            outcome: 'survived',
            gankerParticipantIds: gankersHere,
            // A frame boundary, not the gank itself.
            approximateTime: true
          })
        }
      }
      firedOnPreviousFrame = fired
    }

    // --- Turned around: a third party died in my lane and I helped, and lived ---
    let turnedAround = 0
    for (const k of kills) {
      if (!isThirdParty(k.victimId)) continue
      if (distanceToLane(k.position, lane) > LANE_HALF_WIDTH) continue
      // Must be my kill, not my jungler cleaning up a lane I wasn't in.
      if (!k.killerSideIds.includes(me.participantId)) continue
      const tradedMyLife = myDeathTimes.some(
        (t) => Math.abs(t - k.timestampMs) <= TRADE_WINDOW_MS
      )
      if (tradedMyLife) continue

      turnedAround++

      // If a sampled attempt covers this same moment, upgrade that row rather
      // than adding a second one: "you survived it" and "you killed them" are
      // the same gank, and the kill has the exact timestamp of the two.
      const coveringIndex = survivedEvents.findIndex(
        (e) => Math.abs(e.timestampMs - k.timestampMs) <= ATTEMPT_DEATH_WINDOW_MS
      )
      if (coveringIndex >= 0) {
        survivedEvents.splice(coveringIndex, 1)
      }
      events.push({
        timestampMs: k.timestampMs,
        outcome: 'turned_around',
        gankerParticipantIds: [k.victimId],
        approximateTime: false
      })
    }

    events.push(...survivedEvents)
    events.sort((a, b) => a.timestampMs - b.timestampMs)

    result[me.participantId] = {
      gankDeaths: gankDeathTimes.length,
      gankAttempts: attempts,
      ganksSurvived: survived,
      ganksTurnedAround: turnedAround,
      gankEvents: events
    }
  }

  return result
}
