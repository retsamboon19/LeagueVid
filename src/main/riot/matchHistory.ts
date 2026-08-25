import type {
  MatchHistoryParticipantSummary,
  MatchHistorySummary,
  PlatformRouting
} from '../../shared/types'
import type { MatchInfoDto, ParticipantDto } from './types'

interface AccountRef {
  platform: PlatformRouting
  puuid: string
  accountLabel: string
}

function findLaneOpponent(
  participants: ParticipantDto[],
  participant: ParticipantDto
): ParticipantDto | undefined {
  const myPosition = participant.teamPosition || participant.individualPosition
  if (!myPosition || myPosition === 'Invalid') return undefined
  return participants.find((candidate) => {
    const theirPosition = candidate.teamPosition || candidate.individualPosition
    return candidate.teamId !== participant.teamId && theirPosition === myPosition
  })
}

function keystoneId(participant: ParticipantDto): number | null {
  return (
    participant.perks?.styles.find((style) => style.description === 'primaryStyle')?.selections[0]
      ?.perk ?? null
  )
}

function participantSummary(participant: ParticipantDto): MatchHistoryParticipantSummary {
  const gameName = participant.riotIdGameName?.trim()
  const tagLine = participant.riotIdTagline?.trim()
  const riotId = gameName ? (tagLine ? `${gameName}#${tagLine}` : gameName) : null
  return {
    puuid: participant.puuid,
    teamId: participant.teamId,
    championName: participant.championName,
    displayName: riotId,
    teamPosition: participant.teamPosition || participant.individualPosition,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
    goldEarned: participant.goldEarned,
    items: [
      participant.item0,
      participant.item1,
      participant.item2,
      participant.item3,
      participant.item4,
      participant.item5,
      participant.item6
    ],
    summoner1Id: participant.summoner1Id,
    summoner2Id: participant.summoner2Id,
    keystoneId: keystoneId(participant)
  }
}

export function buildMatchHistorySummary(
  matchId: string,
  info: MatchInfoDto,
  participant: ParticipantDto,
  account: AccountRef
): MatchHistorySummary {
  const opponent = findLaneOpponent(info.participants, participant)
  return {
    matchId,
    gameStartTimestamp: info.gameStartTimestamp,
    gameEndTimestamp: info.gameEndTimestamp,
    gameDuration: info.gameDuration,
    gameMode: info.gameMode,
    gameVersion: info.gameVersion,
    championName: participant.championName,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    win: participant.win,
    teamPosition: participant.teamPosition || participant.individualPosition,
    enemyChampionName: opponent?.championName ?? null,
    puuid: account.puuid,
    platform: account.platform,
    accountLabel: account.accountLabel,
    queueId: info.queueId ?? null,
    cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
    goldEarned: participant.goldEarned,
    goldDiff: opponent ? participant.goldEarned - opponent.goldEarned : null,
    damageToChampions: participant.totalDamageDealtToChampions ?? null,
    visionScore: participant.visionScore ?? null,
    summoner1Id: participant.summoner1Id,
    summoner2Id: participant.summoner2Id,
    keystoneId: keystoneId(participant),
    items: [
      participant.item0,
      participant.item1,
      participant.item2,
      participant.item3,
      participant.item4,
      participant.item5,
      participant.item6
    ],
    participants: info.participants.map(participantSummary)
  }
}
