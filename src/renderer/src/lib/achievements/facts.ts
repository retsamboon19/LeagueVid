import type { MatchStats, StatsParticipant, TagRow } from '../../../../shared/types'
import type { MatchFacts } from './types'

// Turns a MatchStats payload into the flat number set that achievement rules
// read. All the awkwardness of "where does this stat actually come from" lives
// here, so rules stay one-liners.
//
// Three sources feed in:
//   - participant totals from the match DTO (always present)
//   - Riot's `challenges` map (often present, but fields come and go by patch)
//   - timeline-derived values, incl. LeagueVid's own heuristics (absent when
//     the timeline isn't cached)
//
// Anything unavailable becomes null, never 0. A support with no reported
// control-ward challenge must not earn "placed no control wards".

const EARLY_GAME_END_MS = 15 * 60 * 1000

/** ObjectiveEvent.kind values that count as a "major" objective. */
const MAJOR_OBJECTIVE_KINDS = ['dragon', 'baron', 'herald', 'atakhan']

function challenge(p: StatsParticipant, key: string): number | null {
  const value = p.challenges?.[key]
  return typeof value === 'number' ? value : null
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function findLaneOpponent(
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

/**
 * Team gold totals per timeline frame, used for comeback/throw detection.
 * Frames carry per-participant gold, so team totals are summed here rather
 * than trusting any single frame to be complete.
 */
function teamGoldSeries(
  stats: MatchStats,
  focusTeamId: number
): Array<{ timestampMs: number; diff: number }> {
  const teamByParticipant = new Map<number, number>()
  for (const p of stats.participants) teamByParticipant.set(p.participantId, p.teamId)

  return stats.frames.map((frame) => {
    let mine = 0
    let theirs = 0
    for (const pf of frame.participants) {
      const teamId = teamByParticipant.get(pf.participantId)
      if (teamId === undefined) continue
      if (teamId === focusTeamId) mine += pf.totalGold
      else theirs += pf.totalGold
    }
    return { timestampMs: frame.timestampMs, diff: mine - theirs }
  })
}

/** CS/min before and after the 15 minute mark, from timeline frames. */
function csPhases(
  stats: MatchStats,
  participantId: number
): { early: number | null; mid: number | null } {
  if (stats.frames.length === 0) return { early: null, mid: null }

  const csAt = (timestampMs: number): number | null => {
    // Nearest frame at or before the requested time.
    let best: number | null = null
    for (const frame of stats.frames) {
      if (frame.timestampMs > timestampMs) break
      const pf = frame.participants.find((p) => p.participantId === participantId)
      if (pf) best = pf.cs
    }
    return best
  }

  const lastFrame = stats.frames[stats.frames.length - 1]
  const totalMs = lastFrame.timestampMs
  if (totalMs <= EARLY_GAME_END_MS) {
    // Game ended inside the early window, so there's no mid phase to compare.
    const cs = csAt(totalMs)
    const minutes = totalMs / 60_000
    return { early: cs === null || minutes <= 0 ? null : cs / minutes, mid: null }
  }

  const csAtEarlyEnd = csAt(EARLY_GAME_END_MS)
  const csAtEnd = csAt(totalMs)
  if (csAtEarlyEnd === null || csAtEnd === null) return { early: null, mid: null }

  const earlyMinutes = EARLY_GAME_END_MS / 60_000
  const midMinutes = (totalMs - EARLY_GAME_END_MS) / 60_000

  return {
    early: earlyMinutes > 0 ? csAtEarlyEnd / earlyMinutes : null,
    mid: midMinutes > 0 ? (csAtEnd - csAtEarlyEnd) / midMinutes : null
  }
}

/** Minute at which the player first reached their final champion level. */
function finalLevelMinute(stats: MatchStats, participantId: number, finalLevel: number): number | null {
  if (stats.frames.length === 0 || finalLevel <= 0) return null
  for (const frame of stats.frames) {
    const pf = frame.participants.find((p) => p.participantId === participantId)
    if (pf && pf.level >= finalLevel) return Math.round(frame.timestampMs / 60_000)
  }
  return null
}

export interface BuildFactsArgs {
  stats: MatchStats
  focus: StatsParticipant
  /**
   * The video's auto-tags, when available. Used only for tower-dive counts,
   * which LeagueVid derives at link time (see extractEvents.ts) rather than
   * recomputing here. Omit to leave that fact null.
   */
  tags?: TagRow[]
}

export function buildMatchFacts({ stats, focus, tags }: BuildFactsArgs): MatchFacts {
  const durationMinutes = stats.gameDurationSeconds / 60
  const teammates = stats.participants.filter((p) => p.teamId === focus.teamId)
  const laneOpponent = findLaneOpponent(stats.participants, focus)

  const myTeam = stats.teams.find((t) => t.teamId === focus.teamId)
  const enemyTeam = stats.teams.find((t) => t.teamId !== focus.teamId)

  const teamKills = myTeam?.kills ?? 0
  const teamDamage = teammates.reduce((sum, p) => sum + p.damageToChampions, 0)

  // Prefer Riot's own kill participation; fall back to computing it, since
  // the challenge field is missing on older matches.
  const reportedKp = challenge(focus, 'killParticipation')
  const killParticipation =
    reportedKp ?? (teamKills > 0 ? (focus.kills + focus.assists) / teamKills : null)

  const heuristics = stats.heuristicsByParticipant[focus.participantId]
  const earlyPhase = stats.earlyPhaseByParticipant?.[focus.participantId]
  const goldSeries = stats.hasTimeline ? teamGoldSeries(stats, focus.teamId) : []
  const phases = csPhases(stats, focus.participantId)

  const towerDiveKills = tags
    ? tags.filter((t) => t.type === 'towerdive').length
    : null

  // Strictly highest, not tied-highest: level ties are common (measured in
  // 64% of games), and "highest level in the game" alongside four other
  // players at the same level isn't an achievement.
  const othersMaxLevel = Math.max(
    0,
    ...stats.participants
      .filter((p) => p.participantId !== focus.participantId)
      .map((p) => p.champLevel)
  )
  const topDamage = Math.max(...teammates.map((p) => p.damageToChampions))
  const topDamageTaken = Math.max(...teammates.map((p) => p.damageTaken))
  const topVision = Math.max(...teammates.map((p) => p.visionScore))
  // Strictly most, so a shared top spot doesn't count.
  const othersTopAssists = Math.max(
    0,
    ...teammates.filter((p) => p.participantId !== focus.participantId).map((p) => p.assists)
  )

  return {
    role: focus.teamPosition,
    durationMinutes,
    win: myTeam?.win ?? false,
    hasTimeline: stats.hasTimeline,

    kills: focus.kills,
    deaths: focus.deaths,
    assists: focus.assists,
    kdaRatio: focus.deaths > 0 ? (focus.kills + focus.assists) / focus.deaths : null,
    largestMultiKill: focus.largestMultiKill,
    largestKillingSpree: focus.largestKillingSpree,
    killParticipation,
    soloKills: challenge(focus, 'soloKills'),
    earlyKills: earlyPhase?.kills ?? null,
    earlyDeaths: earlyPhase?.deaths ?? null,

    damageToChampions: focus.damageToChampions,
    damagePerMinute: safeDivide(focus.damageToChampions, durationMinutes),
    teamDamageShare:
      challenge(focus, 'teamDamagePercentage') ??
      (teamDamage > 0 ? focus.damageToChampions / teamDamage : null),
    isTopDamageOnTeam: focus.damageToChampions >= topDamage && topDamage > 0,
    damageTaken: focus.damageTaken,
    damageSelfMitigated: focus.damageSelfMitigated,
    isTopDamageTakenOnTeam: focus.damageTaken >= topDamageTaken && topDamageTaken > 0,
    timeCCingOthers: focus.timeCCingOthers,
    isTopAssistsOnTeam: focus.assists > othersTopAssists && focus.assists > 0,

    cs: focus.cs,
    csPerMinute: safeDivide(focus.cs, durationMinutes),
    goldEarned: focus.goldEarned,
    goldPerMinute: safeDivide(focus.goldEarned, durationMinutes),
    csAt10Min: challenge(focus, 'laneMinionsFirst10Minutes'),
    csDiffVsLaneOpponent: laneOpponent ? focus.cs - laneOpponent.cs : null,
    goldDiffVsLaneOpponent: laneOpponent ? focus.goldEarned - laneOpponent.goldEarned : null,
    earlyCsPerMinute: phases.early,
    midCsPerMinute: phases.mid,

    turretKills: focus.turretKills,
    damageToTurrets: focus.damageToTurrets,
    damageToObjectives: focus.damageToObjectives,
    objectiveParticipations: stats.hasTimeline
      ? stats.objectives.filter((o) => o.participated && MAJOR_OBJECTIVE_KINDS.includes(o.kind))
          .length
      : null,
    majorObjectivesInGame: stats.hasTimeline
      ? stats.objectives.filter((o) => MAJOR_OBJECTIVE_KINDS.includes(o.kind)).length
      : null,
    dragonTakedowns: challenge(focus, 'dragonTakedowns'),
    baronTakedowns: challenge(focus, 'baronTakedowns'),
    heraldTakedowns: challenge(focus, 'riftHeraldTakedowns'),

    visionScore: focus.visionScore,
    visionPerMinute:
      challenge(focus, 'visionScorePerMinute') ?? safeDivide(focus.visionScore, durationMinutes),
    wardsPlaced: focus.wardsPlaced,
    wardsKilled: focus.wardsKilled,
    controlWardsPlaced: focus.controlWardsPlaced,
    isTopVisionOnTeam: focus.visionScore >= topVision && topVision > 0,

    totalTimeSpentDead: focus.totalTimeSpentDead,
    deadTimeShare: safeDivide(focus.totalTimeSpentDead, stats.gameDurationSeconds),
    longestTimeSpentLiving: focus.longestTimeSpentLiving,
    healsOnTeammates: focus.healsOnTeammates,
    shieldedOnTeammates: focus.shieldedOnTeammates,

    champLevel: focus.champLevel,
    isHighestLevelInGame: focus.champLevel > othersMaxLevel,
    finalLevelReachedAtMinute: finalLevelMinute(stats, focus.participantId, focus.champLevel),

    teamGoldDiff: (myTeam?.goldEarned ?? 0) - (enemyTeam?.goldEarned ?? 0),
    largestTeamGoldDeficit:
      goldSeries.length > 0 ? Math.min(0, ...goldSeries.map((p) => p.diff)) : null,
    largestTeamGoldLead:
      goldSeries.length > 0 ? Math.max(0, ...goldSeries.map((p) => p.diff)) : null,

    duelCount: heuristics?.duelCount ?? 0,
    duelWinRate: heuristics?.duelWinRate ?? null,
    teamfightCount: heuristics?.teamfightCount ?? 0,
    teamfightWinRate: heuristics?.teamfightWinRate ?? null,
    teamfightParticipation: heuristics?.teamfightParticipation ?? null,
    soloDeaths: heuristics?.soloDeaths ?? null,
    towerDiveKills
  }
}
