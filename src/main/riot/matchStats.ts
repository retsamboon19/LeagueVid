import type {
  ItemPurchaseGroup,
  MatchStats,
  MatchStatsResult,
  ObjectiveEvent,
  SkillLevelUp,
  StatsParticipant,
  StatsPerkSelection,
  StatsTeam,
  TimelineFrameStats
} from '../../shared/types'
import { getCachedApiValue } from '../db/repository'
import { matchRegionForPlatform } from './client'
import { analyzeAllParticipants } from './teamfightAnalyzer'
import type {
  MatchDto,
  MatchTimelineDto,
  ParticipantDto,
  PlatformRouting,
  TimelineFrameDto
} from './types'

// Derives everything the player page's stats panel renders, from data that
// is ALREADY on disk. Reads the cache directly rather than going through
// getMatchCached/getMatchTimelineCached, because those fall back to the
// network on a miss -- and a miss here must degrade gracefully instead of
// silently spending API budget while the user is just browsing their VODs.
//
// Everything is computed once per match and shipped as a single payload:
// timelines are large (often 1-5 MB), so parsing them per tab switch or on
// every focus-player change would be wasteful. The renderer slices the
// payload instead.

// Purchases inside this window are treated as one shop visit, so a build
// step ("bought boots + 2 pots") reads as one entry rather than three.
const SHOP_VISIT_GROUPING_MS = 5_000

function readCachedMatch(platform: PlatformRouting, matchId: string): MatchDto | null {
  const region = matchRegionForPlatform(platform)
  return getCachedApiValue<MatchDto>(`match:${region}:${matchId}`)
}

function readCachedTimeline(
  platform: PlatformRouting,
  matchId: string
): MatchTimelineDto | null {
  const region = matchRegionForPlatform(platform)
  return getCachedApiValue<MatchTimelineDto>(`timeline:${region}:${matchId}`)
}

function toPerkSelections(participant: ParticipantDto): StatsPerkSelection[] {
  const styles = participant.perks?.styles ?? []
  return styles.flatMap((style) =>
    (style.selections ?? []).map((selection) => ({
      perk: selection.perk,
      style: style.style,
      isPrimaryTree: style.description === 'primaryStyle',
      vars: [selection.var1 ?? 0, selection.var2 ?? 0, selection.var3 ?? 0] as [
        number,
        number,
        number
      ]
    }))
  )
}

function extractSkillOrder(frames: TimelineFrameDto[], participantId: number): SkillLevelUp[] {
  const levelUps: SkillLevelUp[] = []
  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (event.type !== 'SKILL_LEVEL_UP') continue
      if (event.participantId !== participantId) continue
      // levelUpType 'EVOLVE' (Kha'Zix/Viktor) isn't a skill point, so it
      // would misnumber the order if counted.
      if (event.levelUpType && event.levelUpType !== 'NORMAL') continue
      if (!event.skillSlot) continue
      levelUps.push({
        level: levelUps.length + 1,
        skillSlot: event.skillSlot,
        timestampMs: event.timestamp
      })
    }
  }
  return levelUps
}

/**
 * Item purchases with undos applied, grouped per shop visit.
 *
 * ITEM_UNDO reverses a purchase that already appeared as ITEM_PURCHASED, so
 * replaying the events in order and removing the undone item is the only way
 * to get a build history that matches what the player actually kept.
 */
function extractItemPurchases(
  frames: TimelineFrameDto[],
  participantId: number
): ItemPurchaseGroup[] {
  const purchases: Array<{ itemId: number; timestampMs: number }> = []

  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (event.participantId !== participantId) continue

      if (event.type === 'ITEM_PURCHASED' && event.itemId) {
        purchases.push({ itemId: event.itemId, timestampMs: event.timestamp })
        continue
      }

      if (event.type === 'ITEM_UNDO') {
        // beforeId is the item that was returned to the shop.
        const undoneId = event.beforeId
        if (!undoneId) continue
        for (let i = purchases.length - 1; i >= 0; i--) {
          if (purchases[i].itemId === undoneId) {
            purchases.splice(i, 1)
            break
          }
        }
      }
    }
  }

  const groups: ItemPurchaseGroup[] = []
  for (const purchase of purchases) {
    const last = groups[groups.length - 1]
    if (last && purchase.timestampMs - last.timestampMs <= SHOP_VISIT_GROUPING_MS) {
      last.itemIds.push(purchase.itemId)
    } else {
      groups.push({ timestampMs: purchase.timestampMs, itemIds: [purchase.itemId] })
    }
  }
  return groups
}

function prettyMonster(event: {
  monsterType?: string
  monsterSubType?: string
}): { kind: string; label: string } {
  const type = event.monsterType ?? ''
  if (type === 'DRAGON') {
    const sub = (event.monsterSubType ?? '').replace(/_DRAGON$/, '').toLowerCase()
    const name = sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : 'Elemental'
    return { kind: 'dragon', label: `${name} Dragon` }
  }
  if (type === 'RIFTHERALD') return { kind: 'herald', label: 'Rift Herald' }
  if (type === 'BARON_NASHOR') return { kind: 'baron', label: 'Baron Nashor' }
  if (type === 'ATAKHAN') return { kind: 'atakhan', label: 'Atakhan' }
  if (type === 'HORDE') return { kind: 'herald', label: 'Voidgrub' }
  return { kind: 'objective', label: type ? type.toLowerCase() : 'Objective' }
}

function prettyBuilding(event: {
  buildingType?: string
  towerType?: string
  laneType?: string
}): { kind: string; label: string } {
  const lane = (event.laneType ?? '')
    .replace('_LANE', '')
    .toLowerCase()
    .replace('bot', 'bottom')
  if (event.buildingType === 'INHIBITOR_BUILDING') {
    return { kind: 'inhibitor', label: lane ? `${lane} inhibitor` : 'Inhibitor' }
  }
  const tower = (event.towerType ?? '').replace('_TURRET', '').toLowerCase()
  const towerName = tower ? `${tower} turret` : 'turret'
  return { kind: 'turret', label: lane ? `${lane} ${towerName}` : towerName }
}

function extractObjectives(
  frames: TimelineFrameDto[],
  focusParticipantId: number
): ObjectiveEvent[] {
  const objectives: ObjectiveEvent[] = []

  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      const isMonster = event.type === 'ELITE_MONSTER_KILL'
      const isBuilding = event.type === 'BUILDING_KILL'
      if (!isMonster && !isBuilding) continue

      const { kind, label } = isMonster ? prettyMonster(event) : prettyBuilding(event)

      // Riot reports killerId plus assisting ids on these events. For
      // buildings, teamId is the team that LOST the structure, so the taking
      // team is the other one.
      const killerId = event.killerId ?? 0
      const assistIds = event.assistingParticipantIds ?? []
      const participated =
        killerId === focusParticipantId || assistIds.includes(focusParticipantId)

      const takingTeam = isBuilding
        ? event.teamId === 100
          ? 200
          : 100
        : (event.killerId ?? 0) <= 5
          ? 100
          : 200

      objectives.push({
        timestampMs: event.timestamp,
        kind,
        label,
        teamId: takingTeam,
        participated
      })
    }
  }

  return objectives.sort((a, b) => a.timestampMs - b.timestampMs)
}

function extractFrames(timeline: MatchTimelineDto): TimelineFrameStats[] {
  return (timeline.info?.frames ?? []).map((frame) => {
    const participantFrames = frame.participantFrames ?? {}
    return {
      timestampMs: frame.timestamp,
      participants: Object.values(participantFrames).map((pf) => ({
        participantId: pf.participantId,
        totalGold: pf.totalGold ?? 0,
        xp: pf.xp ?? 0,
        cs: (pf.minionsKilled ?? 0) + (pf.jungleMinionsKilled ?? 0),
        level: pf.level ?? 0,
        damageToChampions: pf.damageStats?.totalDamageDoneToChampions ?? 0
      }))
    }
  })
}

function toStatsParticipant(
  participant: ParticipantDto,
  frames: TimelineFrameDto[]
): StatsParticipant {
  return {
    puuid: participant.puuid,
    participantId: participant.participantId,
    teamId: participant.teamId,
    displayName: participant.riotIdGameName ?? null,
    championName: participant.championName,
    champLevel: participant.champLevel ?? 0,
    teamPosition: participant.teamPosition || participant.individualPosition || '',

    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
    goldEarned: participant.goldEarned,
    damageToChampions: participant.totalDamageDealtToChampions ?? 0,
    damageTaken: participant.totalDamageTaken ?? 0,
    damageSelfMitigated: participant.damageSelfMitigated ?? 0,
    damageToObjectives: participant.damageDealtToObjectives ?? 0,
    damageToTurrets: participant.damageDealtToTurrets ?? 0,
    visionScore: participant.visionScore ?? 0,
    wardsPlaced: participant.wardsPlaced ?? 0,
    wardsKilled: participant.wardsKilled ?? 0,
    controlWardsPlaced: participant.detectorWardsPlaced ?? 0,
    turretKills: participant.turretKills ?? 0,
    largestMultiKill: participant.largestMultiKill ?? 0,
    largestKillingSpree: participant.largestKillingSpree ?? 0,
    timeCCingOthers: participant.timeCCingOthers ?? 0,
    totalHeal: participant.totalHeal ?? 0,
    healsOnTeammates: participant.totalHealsOnTeammates ?? 0,
    shieldedOnTeammates: participant.totalDamageShieldedOnTeammates ?? 0,
    longestTimeSpentLiving: participant.longestTimeSpentLiving ?? 0,
    totalTimeSpentDead: participant.totalTimeSpentDead ?? 0,

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
    perks: toPerkSelections(participant),
    challenges: participant.challenges ?? null,

    skillOrder: extractSkillOrder(frames, participant.participantId),
    itemPurchases: extractItemPurchases(frames, participant.participantId)
  }
}

function buildTeams(participants: ParticipantDto[]): StatsTeam[] {
  const byTeam = new Map<number, ParticipantDto[]>()
  for (const p of participants) {
    const list = byTeam.get(p.teamId) ?? []
    list.push(p)
    byTeam.set(p.teamId, list)
  }

  return [...byTeam.entries()].map(([teamId, members]) => ({
    teamId,
    win: members[0]?.win ?? false,
    kills: members.reduce((sum, p) => sum + p.kills, 0),
    deaths: members.reduce((sum, p) => sum + p.deaths, 0),
    assists: members.reduce((sum, p) => sum + p.assists, 0),
    goldEarned: members.reduce((sum, p) => sum + p.goldEarned, 0)
  }))
}

export interface GetMatchStatsArgs {
  matchId: string
  /**
   * Every linked account. Which one actually played this match is resolved
   * here by looking for a participating puuid, rather than assumed by the
   * renderer -- with two accounts linked, guessing the first one would
   * attribute the whole panel to the wrong player.
   */
  accounts: Array<{ platform: PlatformRouting; puuid: string }>
}

/**
 * Finds the cached match (trying each linked account's platform, since the
 * cache key is region-scoped) and, if present, its cached timeline. Shared by
 * getMatchStats and getMatchActionTimeline so both agree on which account
 * owns a match and never drift on that logic.
 */
function resolveMatchAndTimeline(
  args: GetMatchStatsArgs
): { match: MatchDto; timeline: MatchTimelineDto | null; ownerPuuid: string } | null {
  let match: MatchDto | null = null
  let platform: PlatformRouting | null = null

  for (const account of args.accounts) {
    const candidate = readCachedMatch(account.platform, args.matchId)
    if (candidate) {
      match = candidate
      platform = account.platform
      break
    }
  }

  if (!match || !platform) return null

  const participantPuuids = new Set((match.info.participants ?? []).map((p) => p.puuid))
  const ownerPuuid =
    args.accounts.find((a) => participantPuuids.has(a.puuid))?.puuid ??
    args.accounts[0]?.puuid ??
    ''

  return { match, timeline: readCachedTimeline(platform, args.matchId), ownerPuuid }
}

export function getMatchStats(args: GetMatchStatsArgs): MatchStatsResult {
  const resolved = resolveMatchAndTimeline(args)
  if (!resolved) {
    // Not an error: the background download simply hasn't reached this match
    // yet. The UI says so rather than showing an empty or zeroed panel.
    return { unavailable: true, reason: 'not-cached' }
  }

  const { match, timeline, ownerPuuid } = resolved
  const frames = timeline?.info?.frames ?? []
  const hasTimeline = frames.length > 0

  const participants = match.info.participants ?? []
  const owner = participants.find((p) => p.puuid === ownerPuuid)
  const focusParticipantId = owner?.participantId ?? participants[0]?.participantId ?? 0

  const stats: MatchStats = {
    matchId: args.matchId,
    gameDurationSeconds: match.info.gameDuration,
    gameMode: match.info.gameMode,
    gameVersion: match.info.gameVersion,
    hasTimeline,
    ownerPuuid,
    teams: buildTeams(participants),
    participants: participants.map((p) => toStatsParticipant(p, frames)),
    frames: timeline && hasTimeline ? extractFrames(timeline) : [],
    heuristicsByParticipant: hasTimeline
      ? analyzeAllParticipants(
          frames,
          participants.map((p) => p.participantId)
        )
      : {},
    objectives: hasTimeline ? extractObjectives(frames, focusParticipantId) : []
  }

  return stats
}

// --- Match-wide action timeline (all 10 players, for the "where's the
// action" curve on the player page and clip editor) ---
//
// This is deliberately NOT the per-player bookmark density: a video's
// bookmarks only ever cover the recording owner's own kills/deaths/
// objectives, which misses everything the other 9 participants did. A
// teamfight the owner wasn't even in should still show up as a spike.

export interface MatchActionEvent {
  timestampMs: number
  weight: number
}

export interface MatchActionTimelineResult {
  hasTimeline: boolean
  events: MatchActionEvent[]
}

// A kill's weight scales with how many players took part, so a quiet 1-for-1
// trade and a five-man teamfight don't register the same. Because nearby
// kills' falloff windows sum together on the renderer side (see
// actionDensity.ts), a burst of kills -- a teamfight, or one player's
// multikill -- naturally produces a taller combined spike with no special
// "is this a multikill" detection needed here.
const KILL_BASE_WEIGHT = 2
const KILL_PER_PARTICIPANT_WEIGHT = 0.6
const KILL_WEIGHT_CAP = 6

function killWeight(assistCount: number): number {
  return Math.min(KILL_BASE_WEIGHT + assistCount * KILL_PER_PARTICIPANT_WEIGHT, KILL_WEIGHT_CAP)
}

function objectiveWeight(event: { monsterType?: string }): number {
  const type = (event.monsterType ?? '').toUpperCase()
  if (type === 'BARON_NASHOR' || type === 'ATAKHAN') return 4 // game-defining
  if (type === 'DRAGON') return 2.5
  return 2 // herald / void grubs / anything else epic
}

function buildingWeight(event: { buildingType?: string; towerType?: string }): number {
  if (event.buildingType === 'INHIBITOR_BUILDING') return 2.5
  if (event.towerType === 'NEXUS_TURRET') return 3 // the game-ending turret
  return 1.5
}

// --- Lead swing (comeback / lead-throw) data ---
//
// Powers the library's "Comeback" / "Threw the lead" filters: was the focus
// player behind (or ahead) by at least X gold vs their lane opponent at a
// given minute, and did that flip by game end? Computed once per match as a
// full gold-diff series so the renderer can apply any minute/threshold
// combination the user types without re-reading match data per keystroke.

function findLaneOpponentParticipant(
  participants: ParticipantDto[],
  me: ParticipantDto
): ParticipantDto | null {
  const myPos = me.teamPosition || me.individualPosition
  if (!myPos || myPos === 'Invalid') return null
  return (
    participants.find(
      (p) => p.teamId !== me.teamId && (p.teamPosition || p.individualPosition) === myPos
    ) ?? null
  )
}

const EMPTY_LEAD_SWING: import('../../shared/types').LeadSwingResult = {
  hasTimeline: false,
  hasLaneOpponent: false,
  series: [],
  finalGoldDiff: null
}

export function getLeadSwing(
  args: GetMatchStatsArgs
): import('../../shared/types').LeadSwingResult {
  const resolved = resolveMatchAndTimeline(args)
  if (!resolved) return EMPTY_LEAD_SWING

  const { match, timeline, ownerPuuid } = resolved
  const participants = match.info.participants ?? []
  const me = participants.find((p) => p.puuid === ownerPuuid)
  if (!me) return EMPTY_LEAD_SWING

  const opponent = findLaneOpponentParticipant(participants, me)
  if (!opponent) {
    // No comparable opponent at all -- distinct from "no timeline", since
    // this can't be evaluated even with full match data.
    return { hasTimeline: !!timeline, hasLaneOpponent: false, series: [], finalGoldDiff: null }
  }

  const finalGoldDiff = me.goldEarned - opponent.goldEarned
  const frames = timeline?.info?.frames ?? []
  if (frames.length === 0) {
    return { hasTimeline: false, hasLaneOpponent: true, series: [], finalGoldDiff }
  }

  const series = frames.map((frame) => {
    const myGold = frame.participantFrames?.[String(me.participantId)]?.totalGold ?? 0
    const oppGold = frame.participantFrames?.[String(opponent.participantId)]?.totalGold ?? 0
    return { timestampMs: frame.timestamp, goldDiff: myGold - oppGold }
  })

  return { hasTimeline: true, hasLaneOpponent: true, series, finalGoldDiff }
}

export interface GetLeadSwingBulkArgs {
  matches: Array<{ videoId: number; matchId: string }>
  accounts: Array<{ platform: PlatformRouting; puuid: string }>
}

/**
 * Lead swing data for many matches in one call, so the library's filter
 * doesn't make one IPC round trip per video. Each match still costs reading
 * and parsing its cached files, so this is only worth calling when the
 * filter is actually in use (see Library.tsx).
 */
export function getLeadSwingBulk(
  args: GetLeadSwingBulkArgs
): Record<number, import('../../shared/types').LeadSwingResult> {
  const result: Record<number, import('../../shared/types').LeadSwingResult> = {}
  for (const { videoId, matchId } of args.matches) {
    result[videoId] = getLeadSwing({ matchId, accounts: args.accounts })
  }
  return result
}

export function getMatchActionTimeline(args: GetMatchStatsArgs): MatchActionTimelineResult {
  const resolved = resolveMatchAndTimeline(args)
  if (!resolved?.timeline) return { hasTimeline: false, events: [] }

  const events: MatchActionEvent[] = []

  for (const frame of resolved.timeline.info?.frames ?? []) {
    for (const ev of frame.events ?? []) {
      if (ev.type === 'CHAMPION_KILL') {
        events.push({
          timestampMs: ev.timestamp,
          weight: killWeight((ev.assistingParticipantIds ?? []).length)
        })
      } else if (ev.type === 'ELITE_MONSTER_KILL') {
        events.push({ timestampMs: ev.timestamp, weight: objectiveWeight(ev) })
      } else if (ev.type === 'BUILDING_KILL') {
        events.push({ timestampMs: ev.timestamp, weight: buildingWeight(ev) })
      }
    }
  }

  return { hasTimeline: true, events: events.sort((a, b) => a.timestampMs - b.timestampMs) }
}
