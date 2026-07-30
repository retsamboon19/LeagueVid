import type { MatchRosterData, RosterParticipant, VideoRow } from '../../../../shared/types'
import type { MatchFacts } from './types'

// Builds MatchFacts from what a library tile already has in hand: the VideoRow
// plus the roster snapshot stored on it. No IPC, no timeline parsing, no cache
// reads.
//
// Why a second fact source rather than reusing buildMatchFacts: the library
// renders every tile at once, and the full builder needs a MatchStats payload,
// which costs an IPC round trip plus parsing a 1-5 MB timeline per match.
// Doing that per tile would make scrolling the library crawl.
//
// The rules and thresholds are shared, so a chip means exactly what the same
// tile means in the player's Achievements tab. The only difference is coverage:
// facts that aren't on the tile are null, and null-guarded rules simply don't
// fire. That's why the vision and damage-rate facts had to become nullable --
// a 0 there would have made the tile claim "placed no control wards" for every
// match, purely because the tile doesn't carry ward data.
//
// Consequence worth knowing: chips are a subset. The authoritative panel is
// the Achievements tab, which runs the same rules over the full payload.

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function findMe(roster: MatchRosterData | null): RosterParticipant | null {
  return roster?.allies.find((p) => p.isMe) ?? null
}

function findLaneOpponent(
  roster: MatchRosterData | null,
  me: RosterParticipant | null
): RosterParticipant | null {
  if (!roster || !me || !me.teamPosition || me.teamPosition === 'Invalid') return null
  return roster.enemies.find((p) => p.teamPosition === me.teamPosition) ?? null
}

export interface BuildLiteFactsArgs {
  video: VideoRow
  roster: MatchRosterData | null
}

/**
 * Returns null when the row doesn't carry enough to say anything -- an
 * unlinked video, or one missing its KDA/duration. Callers render no chips
 * rather than guessing.
 */
export function buildLiteMatchFacts({ video, roster }: BuildLiteFactsArgs): MatchFacts | null {
  if (video.match_id === null) return null
  if (video.kills === null || video.deaths === null || video.assists === null) return null

  // Prefer the roster's own duration (game length) over the video file's, which
  // can include pre-game lobby and post-game footage.
  const durationSeconds =
    roster?.gameDurationSeconds ?? (video.duration_ms ? video.duration_ms / 1000 : 0)
  if (durationSeconds <= 0) return null

  const durationMinutes = durationSeconds / 60
  const me = findMe(roster)
  const laneOpponent = findLaneOpponent(roster, me)

  const kills = video.kills
  const deaths = video.deaths
  const assists = video.assists
  const cs = video.cs ?? me?.cs ?? 0
  const goldEarned = me?.goldEarned ?? 0

  const allies = roster?.allies ?? []
  const enemies = roster?.enemies ?? []
  const teamKills = allies.reduce((sum, p) => sum + p.kills, 0)
  const teamGold = allies.reduce((sum, p) => sum + p.goldEarned, 0)
  const enemyGold = enemies.reduce((sum, p) => sum + p.goldEarned, 0)

  const alliesExceptMe = allies.filter((p) => !p.isMe)
  const othersTopAssists = Math.max(0, ...alliesExceptMe.map((p) => p.assists))

  return {
    role: video.team_position ?? me?.teamPosition ?? '',
    durationMinutes,
    win: video.win === 1,
    // The timeline is never consulted here, so every timeline-fed fact below
    // is null and its rules stay silent.
    hasTimeline: false,

    kills,
    deaths,
    assists,
    kdaRatio: deaths > 0 ? (kills + assists) / deaths : null,
    largestMultiKill: 0,
    largestKillingSpree: 0,
    killParticipation: teamKills > 0 ? (kills + assists) / teamKills : null,
    soloKills: null,
    earlyKills: null,
    earlyDeaths: null,

    damageToChampions: 0,
    damagePerMinute: null,
    teamDamageShare: null,
    isTopDamageOnTeam: false,
    damageTaken: 0,
    damageSelfMitigated: 0,
    isTopDamageTakenOnTeam: false,
    timeCCingOthers: 0,
    isTopAssistsOnTeam: assists > othersTopAssists && assists > 0,

    cs,
    csPerMinute: safeDivide(cs, durationMinutes),
    goldEarned,
    goldPerMinute: safeDivide(goldEarned, durationMinutes),
    csAt10Min: null,
    csDiffVsLaneOpponent: laneOpponent ? cs - laneOpponent.cs : null,
    // The row's own gold_diff is already the lane-opponent delta and is
    // present even when the roster snapshot isn't.
    goldDiffVsLaneOpponent:
      video.gold_diff ?? (laneOpponent ? goldEarned - laneOpponent.goldEarned : null),
    earlyCsPerMinute: null,
    midCsPerMinute: null,

    turretKills: 0,
    damageToTurrets: 0,
    damageToObjectives: 0,
    objectiveParticipations: null,
    majorObjectivesInGame: null,
    dragonTakedowns: null,
    baronTakedowns: null,
    heraldTakedowns: null,

    visionScore: null,
    visionPerMinute: null,
    wardsPlaced: 0,
    wardsKilled: null,
    controlWardsPlaced: null,
    isTopVisionOnTeam: false,

    totalTimeSpentDead: 0,
    deadTimeShare: null,
    longestTimeSpentLiving: 0,
    healsOnTeammates: 0,
    shieldedOnTeammates: 0,

    champLevel: 0,
    isHighestLevelInGame: false,
    finalLevelReachedAtMinute: null,

    teamGoldDiff: teamGold - enemyGold,
    largestTeamGoldDeficit: null,
    largestTeamGoldLead: null,

    duelCount: 0,
    duelWinRate: null,
    teamfightCount: 0,
    teamfightWinRate: null,
    teamfightParticipation: null,
    soloDeaths: null,
    towerDiveKills: null,

    // Gank detection needs timeline positions, which a library tile never has.
    gankDeaths: null,
    gankAttempts: null,
    ganksSurvived: null,
    ganksTurnedAround: null
  }
}
