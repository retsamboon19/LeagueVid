import type { HeuristicStats } from '../../shared/types'
import type { TimelineFrameDto } from './types'

// Derives teamfight and duel statistics that the Riot API does NOT provide.
//
// Riot exposes individual kill events with timestamps and map positions, but
// no notion of a "teamfight". League of Graphs-style stats (teamfight
// winrate, teamfight participation, duel winrate, solo deaths) are therefore
// inferred by grouping kills that happened close together in time and space
// and treating each group as one engagement.
//
// This is a heuristic, not a measurement. Two kills 8 seconds apart across
// the map are separate fights; two kills 8 seconds apart in the same brush
// are one. The thresholds below encode that judgment, and everything derived
// from them is surfaced in the UI with an explicit "estimate" marker so it
// is never mistaken for an official Riot statistic.

/** Kills further apart than this in time start a new engagement. */
const FIGHT_GAP_MS = 10_000

// Map units. Summoner's Rift is roughly 15000x15000, so this is a radius of
// about a screen's worth of action -- wide enough to keep a chase or a
// drawn-out skirmish together, tight enough to separate simultaneous fights
// happening in different lanes.
const FIGHT_RADIUS = 2_000

// What makes an engagement a "teamfight".
//
// These count every champion involved, victims included -- which is why the
// bar isn't 3. A single kill with one assist involves three champions (killer,
// assister, victim), so a bar of 3 would classify every routine 2v1 gank as a
// teamfight and report ~30 of them per game. Requiring five champions overall
// AND at least two per side means both teams genuinely committed bodies.
const MIN_TEAMFIGHT_PARTICIPANTS = 5
const MIN_TEAMFIGHT_PER_SIDE = 2

function isTeamfight(engagement: Engagement): boolean {
  if (engagement.participantIds.size < MIN_TEAMFIGHT_PARTICIPANTS) return false
  let blue = 0
  let red = 0
  for (const id of engagement.participantIds) {
    if (teamOf(id) === 100) blue++
    else red++
  }
  return blue >= MIN_TEAMFIGHT_PER_SIDE && red >= MIN_TEAMFIGHT_PER_SIDE
}

interface KillEvent {
  timestampMs: number
  killerId: number
  victimId: number
  assistIds: number[]
  x: number
  y: number
}

interface Engagement {
  kills: KillEvent[]
  /** Every participant who took part, as killer, assister, or victim. */
  participantIds: Set<number>
}

function collectKills(frames: TimelineFrameDto[]): KillEvent[] {
  const kills: KillEvent[] = []

  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (event.type !== 'CHAMPION_KILL') continue
      const victimId = event.victimId
      if (!victimId) continue
      kills.push({
        timestampMs: event.timestamp,
        // killerId 0 means an execution or neutral kill (turret, minion).
        killerId: event.killerId ?? 0,
        victimId,
        assistIds: event.assistingParticipantIds ?? [],
        x: event.position?.x ?? 0,
        y: event.position?.y ?? 0
      })
    }
  }

  return kills.sort((a, b) => a.timestampMs - b.timestampMs)
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Groups kills into engagements: a kill joins the current group when it
 * happens within FIGHT_GAP_MS of the previous kill in that group AND within
 * FIGHT_RADIUS of the group's running centroid. Otherwise it starts a new
 * group.
 */
export function groupKillsIntoEngagements(frames: TimelineFrameDto[]): Engagement[] {
  const kills = collectKills(frames)
  const engagements: Engagement[] = []

  let current: KillEvent[] = []
  let centroid = { x: 0, y: 0 }

  const flush = (): void => {
    if (current.length === 0) return
    const participantIds = new Set<number>()
    for (const kill of current) {
      if (kill.killerId > 0) participantIds.add(kill.killerId)
      participantIds.add(kill.victimId)
      for (const id of kill.assistIds) participantIds.add(id)
    }
    engagements.push({ kills: current, participantIds })
    current = []
  }

  for (const kill of kills) {
    if (current.length === 0) {
      current = [kill]
      centroid = { x: kill.x, y: kill.y }
      continue
    }

    const previous = current[current.length - 1]
    const withinTime = kill.timestampMs - previous.timestampMs <= FIGHT_GAP_MS
    // Position data can be missing on some events; when it is, fall back to
    // time proximity alone rather than treating (0,0) as a real location.
    const hasPositions = (kill.x !== 0 || kill.y !== 0) && (centroid.x !== 0 || centroid.y !== 0)
    const withinRange = !hasPositions || distance(kill, centroid) <= FIGHT_RADIUS

    if (withinTime && withinRange) {
      current.push(kill)
      // Running mean keeps a moving fight (e.g. a chase) grouped without
      // letting it drift arbitrarily far from where it started.
      const n = current.length
      centroid = {
        x: centroid.x + (kill.x - centroid.x) / n,
        y: centroid.y + (kill.y - centroid.y) / n
      }
    } else {
      flush()
      current = [kill]
      centroid = { x: kill.x, y: kill.y }
    }
  }
  flush()

  return engagements
}

function teamOf(participantId: number): number {
  // Riot assigns participants 1-5 to team 100 and 6-10 to team 200.
  return participantId <= 5 ? 100 : 200
}

/**
 * Computes heuristic stats for one participant from the grouped engagements.
 * Returns nulls (not zeros) for rates with no qualifying sample, so the UI
 * can say "unavailable" instead of implying a real 0%.
 */
export function analyzeParticipant(
  engagements: Engagement[],
  participantId: number
): HeuristicStats {
  const myTeam = teamOf(participantId)

  const teamfights = engagements.filter(isTeamfight)
  const duels = engagements.filter((e) => e.participantIds.size === 2)

  let teamfightsWon = 0
  let teamfightsParticipated = 0

  for (const fight of teamfights) {
    let myTeamKills = 0
    let enemyTeamKills = 0
    for (const kill of fight.kills) {
      // A kill counts for the killer's team; attribute by victim when the
      // killer is neutral (executions), since the victim's team still lost
      // the trade.
      if (kill.killerId > 0) {
        if (teamOf(kill.killerId) === myTeam) myTeamKills++
        else enemyTeamKills++
      } else if (teamOf(kill.victimId) === myTeam) {
        enemyTeamKills++
      } else {
        myTeamKills++
      }
    }
    if (myTeamKills > enemyTeamKills) teamfightsWon++
    if (fight.participantIds.has(participantId)) teamfightsParticipated++
  }

  const myDuels = duels.filter((d) => d.participantIds.has(participantId))
  const duelsWon = myDuels.filter((d) =>
    d.kills.some((k) => k.killerId === participantId)
  ).length

  // A solo death: this participant died in an engagement involving exactly
  // one enemy and no ally of theirs -- i.e. caught out alone in a 1v1 they
  // lost, rather than dying in a group fight.
  const soloDeaths = engagements.filter((e) => {
    const diedHere = e.kills.some((k) => k.victimId === participantId)
    if (!diedHere) return false
    const others = [...e.participantIds].filter((id) => id !== participantId)
    const enemies = others.filter((id) => teamOf(id) !== myTeam)
    const allies = others.filter((id) => teamOf(id) === myTeam)
    return enemies.length === 1 && allies.length === 0
  }).length

  return {
    teamfightCount: teamfights.length,
    teamfightWinRate: teamfights.length > 0 ? teamfightsWon / teamfights.length : null,
    teamfightParticipation:
      teamfights.length > 0 ? teamfightsParticipated / teamfights.length : null,
    duelCount: myDuels.length,
    duelWinRate: myDuels.length > 0 ? duelsWon / myDuels.length : null,
    soloDeaths
  }
}

/** Heuristics for all 10 participants, keyed by participantId. */
export function analyzeAllParticipants(
  frames: TimelineFrameDto[],
  participantIds: number[]
): Record<number, HeuristicStats> {
  const engagements = groupKillsIntoEngagements(frames)
  const result: Record<number, HeuristicStats> = {}
  for (const id of participantIds) {
    result[id] = analyzeParticipant(engagements, id)
  }
  return result
}

