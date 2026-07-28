// Types shared between main, preload, and renderer processes.
// Kept dependency-free (no Electron/Node imports) so the renderer's
// tsconfig can safely include this file.

export type RegionalRouting = 'americas' | 'asia' | 'europe' | 'sea' | 'esports'

export type PlatformRouting =
  | 'na1'
  | 'euw1'
  | 'eun1'
  | 'kr'
  | 'jp1'
  | 'br1'
  | 'la1'
  | 'la2'
  | 'oc1'
  | 'tr1'
  | 'ru'
  | 'ph2'
  | 'sg2'
  | 'th2'
  | 'tw2'
  | 'vn2'

export interface RiotAccountLink {
  gameName: string
  tagLine: string
  platform: PlatformRouting
  puuid: string
}

// Wraps one or more linked Riot accounts. Multiple accounts let LeagueVid
// search match history across all of them when auto-detecting which match a
// recording belongs to (useful if you play on more than one account).
export interface AppSettings {
  accounts: RiotAccountLink[]
}

export interface VideoRow {
  id: number
  file_path: string
  file_name: string
  recorded_at: number | null
  duration_ms: number | null
  match_id: string | null
  sync_offset_ms: number | null
  champion_name: string | null
  kda: string | null
  win: number | null
  kills: number | null
  deaths: number | null
  assists: number | null
  cs: number | null
  gold_diff: number | null
  enemy_champion_name: string | null
  summoner1_id: number | null
  summoner2_id: number | null
  keystone_id: number | null
  game_mode: string | null
  match_data: string | null // JSON-encoded MatchRosterData
  team_position: string | null // TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY
  queue_id: number | null // Riot queue id (420 ranked solo, 450 ARAM, etc.)
  is_favorite: number // 0/1
  last_position_ms: number | null
  created_at: number
}

export interface RosterParticipant {
  puuid: string
  championName: string
  teamPosition: string
  isMe: boolean
  kills: number
  deaths: number
  assists: number
  items: number[] // item ids, 0 = empty slot
  summoner1Id: number
  summoner2Id: number
  keystoneId: number | null
  cs: number
  goldEarned: number
}

export interface MatchRosterData {
  allies: RosterParticipant[]
  enemies: RosterParticipant[]
  gameDurationSeconds: number
}

export interface TagRow {
  id: number
  video_id: number
  timestamp_ms: number
  type: string
  label: string
  detail: string | null
  source: 'auto' | 'manual'
  created_at: number
}

export type AutoTagType =
  | 'kill'
  | 'death'
  | 'assist'
  // Multikill tiers are separate types rather than one 'multikill' so the
  // player can colour-code them by how big the streak was.
  | 'doublekill'
  | 'triplekill'
  | 'quadrakill'
  | 'pentakill'
  | 'multikill' // legacy rows written before the tiers above existed
  | 'turret'
  | 'inhibitor'
  | 'dragon'
  | 'baron'
  | 'herald'
  | 'other_objective'
  // A kill landed solo (no ally assist) within an enemy turret's attack
  // range -- derived from timeline kill position vs. static turret
  // coordinates, since Riot's API doesn't flag this itself.
  | 'towerdive'

/** Multikill length (2-5) -> tag type. Anything above 5 is still a penta. */
export function multiKillTagType(length: number): AutoTagType {
  if (length >= 5) return 'pentakill'
  if (length === 4) return 'quadrakill'
  if (length === 3) return 'triplekill'
  return 'doublekill'
}

export const MULTIKILL_LABELS: Record<number, string> = {
  2: 'Double kill',
  3: 'Triple kill',
  4: 'Quadra kill',
  5: 'Penta kill'
}

// The four multikill tag types the library's filter buttons match against.
// Each streak gets exactly ONE tag at its own tier (see findKillStreaks in
// extractEvents.ts) -- a pentakill produces a 'pentakill' tag, not also a
// 'doublekill'/'triplekill'/'quadrakill' tag. So these filters are exact
// ("has a triple kill" means a streak of exactly 3), not "at least" -- that
// keeps "show me my triple kills" from being swamped by every quadra/penta
// as well, and lets the four tiers be combined (OR) meaningfully: selecting
// Triple + Penta finds the standout plays without the routine doubles.
export const MULTIKILL_FILTER_TYPES = ['doublekill', 'triplekill', 'quadrakill', 'pentakill'] as const
export type MultikillFilterType = (typeof MULTIKILL_FILTER_TYPES)[number]

export interface AutoTagEvent {
  type: AutoTagType
  gameTimestampMs: number
  label: string
  detail?: string
}

export interface RiotAccountDto {
  puuid: string
  gameName: string
  tagLine: string
}

export interface ParticipantSummaryDto {
  puuid: string
  participantId: number
  championName: string
  kills: number
  deaths: number
  assists: number
  win: boolean
  teamPosition: string
}

export interface MatchSummaryDto {
  matchId: string
  gameStartTimestamp: number
  gameEndTimestamp: number
  gameDuration: number
  gameMode: string
  gameVersion: string
  participants: ParticipantSummaryDto[]
}

export interface VideoFileInfo {
  filePath: string
  fileName: string
  recordedAt: number
  sizeBytes: number
}

export interface MatchPickerSummary {
  matchId: string
  gameStartTimestamp: number
  gameEndTimestamp: number
  gameDuration: number
  gameMode: string
  gameVersion: string
  championName: string
  kills: number
  deaths: number
  assists: number
  win: boolean
  teamPosition: string
  // Opposing laner's championName (Riot's internal id form), or null if it
  // couldn't be determined (missing/invalid position data). Lets the manual
  // re-link picker narrow candidates by "who was I laning against" without
  // an extra API call per candidate -- it's derived from the same match
  // data already fetched to build this summary.
  enemyChampionName: string | null
  // Which linked account this match came from -- needed when searching
  // across multiple accounts, so linking/fetching the full bundle later
  // uses the right puuid/platform.
  puuid: string
  platform: PlatformRouting
  accountLabel: string // "gameName#tagLine", for display when disambiguating
}

export interface PlayerPreferences {
  // How many seconds before a bookmarked moment to jump to, so you see the
  // lead-up to a kill/death/objective instead of landing right on the result.
  bookmarkLeadInSeconds: number
  // Seconds moved by the back/forward skip buttons.
  seekStepSeconds: number
  // Whether jumping to a bookmark also starts playback automatically.
  autoPlayOnJump: boolean
}

export const DEFAULT_PLAYER_PREFERENCES: PlayerPreferences = {
  bookmarkLeadInSeconds: 15,
  seekStepSeconds: 5,
  autoPlayOnJump: true
}

// --- Data Dragon (Riot's static asset CDN) ---

export interface DDragonChampionInfo {
  id: string // e.g. "MonkeyKing" -- used in image URLs
  key: string // numeric championId as a string, matches match-v5's championId
  name: string // display name, e.g. "Wukong"
}

export interface DDragonItemInfo {
  name: string
  image: string // filename, e.g. "1001.png"
}

export interface DDragonSummonerSpellInfo {
  name: string
  image: string // filename, e.g. "SummonerFlash.png"
}

export interface DDragonRuneInfo {
  name: string
  icon: string // relative path, e.g. "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png"
}

export interface DDragonBundle {
  version: string
  championIconBase: string
  itemIconBase: string
  summonerSpellIconBase: string
  runeIconBase: string
  champions: Record<string, DDragonChampionInfo> // keyed by championId (name-based id, e.g. "Yorick")
  items: Record<string, DDragonItemInfo> // keyed by numeric item id as string
  summonerSpells: Record<string, DDragonSummonerSpellInfo> // keyed by numeric spell id as string
  runes: Record<string, DDragonRuneInfo> // keyed by keystone perk id as string
}

// --- Match stats (player page stats panel) ---
// Derived in the main process from the already-cached match + timeline DTOs
// (see main/riot/matchStats.ts). Nothing here triggers a Riot API call --
// browsing your own VODs must never consume API budget.

export interface StatsPerkSelection {
  perk: number
  style: number
  isPrimaryTree: boolean
  /** Rune performance values. Unlabeled by Riot; see lib/runeLabels.ts. */
  vars: [number, number, number]
}

export interface SkillLevelUp {
  /** Champion level at which the point was spent (1-18). */
  level: number
  /** 1=Q, 2=W, 3=E, 4=R. */
  skillSlot: number
  timestampMs: number
}

export interface ItemPurchaseGroup {
  /** Game time of the shop visit these purchases share. */
  timestampMs: number
  itemIds: number[]
}

export interface ObjectiveEvent {
  timestampMs: number
  /** 'dragon' | 'herald' | 'baron' | 'atakhan' | 'turret' | 'inhibitor' */
  kind: string
  /** Human-readable subtype, e.g. 'Infernal Dragon', 'Outer turret'. */
  label: string
  teamId: number
  /** Whether the focus participant was the killer or an assister. */
  participated: boolean
}

// Stats LeagueVid computes itself because Riot does not provide them.
// Always surfaced with an "estimate" marker in the UI -- they come from
// clustering timeline kill events by time and map position, which is a
// judgment call, not an official number.
export interface HeuristicStats {
  teamfightCount: number
  /** null when the match recorded no teamfights (not the same as 0%). */
  teamfightWinRate: number | null
  teamfightParticipation: number | null
  duelCount: number
  duelWinRate: number | null
  soloDeaths: number
}

export interface StatsParticipant {
  puuid: string
  participantId: number
  teamId: number
  displayName: string | null
  championName: string
  champLevel: number
  teamPosition: string

  kills: number
  deaths: number
  assists: number
  cs: number
  goldEarned: number
  damageToChampions: number
  damageTaken: number
  damageSelfMitigated: number
  damageToObjectives: number
  damageToTurrets: number
  visionScore: number
  wardsPlaced: number
  wardsKilled: number
  controlWardsPlaced: number
  turretKills: number
  largestMultiKill: number
  largestKillingSpree: number
  timeCCingOthers: number
  totalHeal: number
  healsOnTeammates: number
  shieldedOnTeammates: number
  longestTimeSpentLiving: number
  totalTimeSpentDead: number

  items: number[]
  summoner1Id: number
  summoner2Id: number
  perks: StatsPerkSelection[]

  // Riot's computed challenge values. Deliberately a permissive record:
  // Riot adds and removes challenge fields between patches, and an absent
  // field must render as "unavailable" rather than 0, so presence is
  // checked per-field at the point of use.
  challenges: Record<string, number> | null

  skillOrder: SkillLevelUp[]
  itemPurchases: ItemPurchaseGroup[]
}

export interface StatsTeam {
  teamId: number
  win: boolean
  kills: number
  deaths: number
  assists: number
  goldEarned: number
}

/** One timeline frame's values for one participant. */
export interface TimelineParticipantFrame {
  participantId: number
  totalGold: number
  xp: number
  cs: number
  level: number
  damageToChampions: number
}

export interface TimelineFrameStats {
  timestampMs: number
  participants: TimelineParticipantFrame[]
}

export interface MatchStats {
  matchId: string
  gameDurationSeconds: number
  gameMode: string
  gameVersion: string
  /** False when the timeline DTO isn't cached -- timeline-fed views degrade. */
  hasTimeline: boolean
  /** puuid of the account the video is linked through. */
  ownerPuuid: string
  teams: StatsTeam[]
  participants: StatsParticipant[]
  frames: TimelineFrameStats[]
  /** Keyed by participantId. Empty when there's no timeline. */
  heuristicsByParticipant: Record<number, HeuristicStats>
  objectives: ObjectiveEvent[]
}

/** Returned instead of MatchStats when the match isn't cached locally. */
export interface MatchStatsUnavailable {
  unavailable: true
  reason: 'not-cached'
}

export type MatchStatsResult = MatchStats | MatchStatsUnavailable

// --- Lead swing (comeback / lead-throw) filter data ---
// One gold-difference-vs-lane-opponent series per match, computed once from
// the cached match+timeline and reused for however the user wants to slice
// it (any minute mark, any threshold) without re-reading the match data.

export interface LeadSwingPoint {
  /** Game time. */
  timestampMs: number
  /** Focus player's total gold minus their lane opponent's, at this frame. */
  goldDiff: number
}

export interface LeadSwingResult {
  hasTimeline: boolean
  /** False when no same-position enemy could be identified -- there's
   * nothing to compare against, so the filter can't evaluate this match. */
  hasLaneOpponent: boolean
  series: LeadSwingPoint[]
  /** Final gold diff at game end, from each participant's total goldEarned
   * (more reliable than trusting the last timeline frame landed exactly at
   * the buzzer). Null when there's no lane opponent to compare against. */
  finalGoldDiff: number | null
}

// Match-wide action events (every player, not just the recording owner), for
// the "where's the action" curve on the player page and clip editor.
export interface MatchActionEvent {
  timestampMs: number
  weight: number
}

export interface MatchActionTimelineResult {
  hasTimeline: boolean
  events: MatchActionEvent[]
}
