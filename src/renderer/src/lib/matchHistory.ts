import type {
  MatchHistoryParticipantSummary,
  MatchHistorySummary,
  MatchRosterData,
  RosterParticipant,
  VideoRow
} from '../../../shared/types'

function rosterParticipant(
  participant: MatchHistoryParticipantSummary,
  ownerPuuid: string
): RosterParticipant {
  return {
    puuid: participant.puuid,
    championName: participant.championName,
    displayName: participant.displayName,
    teamPosition: participant.teamPosition,
    isMe: participant.puuid === ownerPuuid,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    items: participant.items,
    summoner1Id: participant.summoner1Id,
    summoner2Id: participant.summoner2Id,
    keystoneId: participant.keystoneId,
    cs: participant.cs,
    goldEarned: participant.goldEarned
  }
}

/**
 * Adapts a cache-only match to the tile model already used by recordings.
 * The empty file fields are deliberate and never escape the stat-only card.
 */
export function historyMatchToVideoRow(match: MatchHistorySummary, id: number): VideoRow {
  const owner = match.participants.find((participant) => participant.puuid === match.puuid)
  const ownerTeamId = owner?.teamId
  const roster: MatchRosterData = {
    allies: match.participants
      .filter((participant) => participant.teamId === ownerTeamId)
      .map((participant) => rosterParticipant(participant, match.puuid)),
    enemies: match.participants
      .filter((participant) => participant.teamId !== ownerTeamId)
      .map((participant) => rosterParticipant(participant, match.puuid)),
    gameDurationSeconds: match.gameDuration
  }

  return {
    id,
    file_path: '',
    file_name: `${match.accountLabel} · ${match.matchId}`,
    recorded_at: match.gameStartTimestamp,
    duration_ms: match.gameDuration * 1000,
    match_id: match.matchId,
    sync_offset_ms: null,
    champion_name: match.championName,
    kda: `${match.kills}/${match.deaths}/${match.assists}`,
    win: match.win ? 1 : 0,
    kills: match.kills,
    deaths: match.deaths,
    assists: match.assists,
    cs: match.cs,
    gold_diff: match.goldDiff,
    enemy_champion_name: match.enemyChampionName,
    summoner1_id: match.summoner1Id,
    summoner2_id: match.summoner2Id,
    keystone_id: match.keystoneId,
    game_mode: match.gameMode,
    match_data: JSON.stringify(roster),
    team_position: match.teamPosition,
    queue_id: match.queueId,
    is_favorite: 0,
    last_position_ms: null,
    created_at: match.gameEndTimestamp
  }
}

export function historyMatchKey(match: Pick<MatchHistorySummary, 'matchId' | 'puuid'>): string {
  return `${match.matchId}:${match.puuid}`
}

/** Mirrors the persisted unlink operation for an immediate renderer update. */
export function detachedRecording(video: VideoRow): VideoRow {
  return {
    ...video,
    match_id: null,
    sync_offset_ms: null,
    champion_name: null,
    kda: null,
    win: null,
    kills: null,
    deaths: null,
    assists: null,
    cs: null,
    gold_diff: null,
    enemy_champion_name: null,
    summoner1_id: null,
    summoner2_id: null,
    keystone_id: null,
    game_mode: null,
    match_data: null,
    team_position: null,
    queue_id: null
  }
}
