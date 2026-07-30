// Riot API response shapes (subset of fields we actually use)

export type { RiotAccountDto } from '../../shared/types'

export interface MatchMetadataDto {
  matchId: string
  participants: string[] // list of puuids
}

export interface ParticipantDto {
  puuid: string
  participantId: number
  championName: string
  championId: number
  champLevel: number
  teamId: number
  kills: number
  deaths: number
  assists: number
  win: boolean
  teamPosition: string
  individualPosition: string
  goldEarned: number
  totalMinionsKilled: number
  neutralMinionsKilled: number
  summoner1Id: number
  summoner2Id: number
  item0: number
  item1: number
  item2: number
  item3: number
  item4: number
  item5: number
  item6: number
  riotIdGameName?: string
  riotIdTagline?: string
  // Combat / vision / sustain fields used by the stats panel. Optional
  // because older cached matches predate some of them, and the panel must
  // distinguish "absent" from "zero" rather than inventing a 0.
  totalDamageDealtToChampions?: number
  totalDamageTaken?: number
  damageSelfMitigated?: number
  damageDealtToObjectives?: number
  damageDealtToTurrets?: number
  visionScore?: number
  wardsPlaced?: number
  wardsKilled?: number
  detectorWardsPlaced?: number
  turretKills?: number
  largestMultiKill?: number
  largestKillingSpree?: number
  timeCCingOthers?: number
  totalHeal?: number
  totalHealsOnTeammates?: number
  totalDamageShieldedOnTeammates?: number
  longestTimeSpentLiving?: number
  totalTimeSpentDead?: number
  // Riot's ~150 computed challenge values. Left as an index signature on
  // purpose: the field set shifts between patches, so callers check for the
  // specific keys they need instead of trusting a fixed interface.
  challenges?: Record<string, number>
  perks?: {
    styles: Array<{
      description: string // "primaryStyle" | "subStyle"
      selections: Array<{ perk: number; var1: number; var2: number; var3: number }>
      style: number
    }>
  }
}

export interface MatchInfoDto {
  gameStartTimestamp: number // epoch ms, real world time
  gameEndTimestamp: number
  gameDuration: number // seconds
  gameMode: string
  gameVersion: string
  queueId?: number // e.g. 420 ranked solo, 440 ranked flex, 450 ARAM, 400 normal draft
  participants: ParticipantDto[]
}

export interface MatchDto {
  metadata: MatchMetadataDto
  info: MatchInfoDto
}

export interface TimelineFrameEvent {
  type: string
  timestamp: number // ms since game start
  killerId?: number
  victimId?: number
  assistingParticipantIds?: number[]
  participantId?: number
  killType?: string
  multiKillLength?: number
  teamId?: number
  monsterType?: string
  monsterSubType?: string
  buildingType?: string
  towerType?: string
  laneType?: string
  itemId?: number
  afterId?: number
  beforeId?: number
  skillSlot?: number
  levelUpType?: string
  /** Map coordinates, present on kill and building events. */
  position?: { x: number; y: number }
}

/** Per-participant snapshot inside a timeline frame. */
export interface TimelineParticipantFrameDto {
  participantId: number
  /**
   * Where the player stood at this frame. Present on 100% of frames in cached
   * data, but frames are 60s apart (frameInterval), so this samples movement
   * rather than tracking it -- see gankAnalyzer.ts.
   */
  position?: { x: number; y: number }
  totalGold?: number
  currentGold?: number
  xp?: number
  level?: number
  minionsKilled?: number
  jungleMinionsKilled?: number
  damageStats?: {
    totalDamageDoneToChampions?: number
  }
}

export interface TimelineFrameDto {
  timestamp: number
  events: TimelineFrameEvent[]
  /** Keyed by participantId as a string, per Riot's shape. */
  participantFrames?: Record<string, TimelineParticipantFrameDto>
}

export interface MatchTimelineDto {
  metadata: MatchMetadataDto
  info: {
    frameInterval: number
    frames: TimelineFrameDto[]
    participants: { participantId: number; puuid: string }[]
  }
}

export type { RegionalRouting, PlatformRouting } from '../../shared/types'
