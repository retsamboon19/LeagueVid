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

/**
 * Kills and deaths inside the laning phase, counted from timeline events.
 *
 * Riot's challenge data has no early-deaths field (and its
 * `takedownsFirstXMinutes` blends kills with assists), so "how did the first
 * 15 minutes go" has to be counted from CHAMPION_KILL events directly.
 */
export interface EarlyPhaseStats {
  kills: number
  deaths: number
  assists: number
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
  /** Laning-phase kills/deaths, keyed by participantId. Empty without a timeline. */
  earlyPhaseByParticipant: Record<number, EarlyPhaseStats>
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

// --- Recording (automatic League match capture) ---
// Deliberately its own settings object rather than part of AppSettings,
// which is only the list of linked Riot accounts. Follows the
// PlayerPreferences precedent: one JSON row in the settings table, with
// these defaults merged over whatever is stored so adding a field later
// doesn't invalidate an existing row.

export type ResolutionScale = 'native' | '1440p' | '1080p' | '720p'
export type RecordingFramerate = 30 | 48 | 60
export type RateControlMode = 'quality' | 'bitrate'
export type AudioTrackMode = 'mixed' | 'separate'

export interface RecordingSettings {
  /** Master switch for automatic recording. Off until the user opts in. */
  enabled: boolean
  /** null = the default folder (a 'recordings' folder beside the app). */
  outputDir: string | null

  /** Electron display id to capture. null = primary. */
  displayId: number | null
  /**
   * 'native' keeps frames on the GPU for the whole pipeline. Anything else
   * costs a download to system memory plus a scale, so it's an explicit
   * choice rather than the default.
   */
  resolutionScale: ResolutionScale
  framerate: RecordingFramerate
  drawMouse: boolean

  /** null = whichever encoder capability probing ranked highest. */
  encoder: string | null
  rateControl: RateControlMode
  /**
   * One number across five encoders whose scales differ (NVENC cq, x264 crf,
   * AMF qp, QSV global_quality, MF quality). The argument builder owns the
   * translation; the UI labels it per encoder.
   */
  quality: number
  bitrateKbps: number
  /**
   * Also the granularity of the clip editor's lossless "fast" cut, since that
   * mode can only start on a keyframe -- which is why this is a labeled
   * setting and not a hidden constant.
   */
  keyframeIntervalSeconds: number

  micDeviceName: string | null
  desktopAudioDeviceName: string | null
  /**
   * Chromium loopback bridge for system audio. The bundled ffmpeg has no
   * WASAPI loopback input, so without either this or a virtual audio device
   * there is no way to capture game sound.
   */
  useLoopbackBridge: boolean
  audioTrackMode: AudioTrackMode

  /** Manual override only -- the real start trigger is render readiness. */
  startDelayMs: number
  /** Keep recording past game end so the post-game screen is captured. */
  stopDelayMs: number
  /** Anything shorter is discarded, which is what drops remakes. */
  minKeepDurationMs: number

  replayBufferEnabled: boolean
  replayBufferSeconds: number
  replayHotkey: string | null

  /** Opt-in. Deleting recordings is the one destructive behavior here. */
  retentionEnabled: boolean
  retentionMaxGb: number | null
  retentionMaxAgeDays: number | null
}

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  enabled: false,
  outputDir: null,

  displayId: null,
  resolutionScale: 'native',
  framerate: 60,
  drawMouse: false,

  encoder: null,
  rateControl: 'quality',
  // Visually clean for gameplay on every encoder's scale without the file
  // size of a near-lossless setting.
  quality: 21,
  bitrateKbps: 40000,
  keyframeIntervalSeconds: 1,

  micDeviceName: null,
  desktopAudioDeviceName: null,
  useLoopbackBridge: false,
  audioTrackMode: 'mixed',

  startDelayMs: 0,
  stopDelayMs: 20000,
  // A remake is called at 3 minutes, and the surrender vote plus the return
  // to lobby lands well inside 4 -- so anything under this is a game that
  // was never played.
  minKeepDurationMs: 4 * 60 * 1000,

  replayBufferEnabled: false,
  replayBufferSeconds: 120,
  replayHotkey: null,

  retentionEnabled: false,
  retentionMaxGb: null,
  retentionMaxAgeDays: null
}

/**
 * Turns a stored settings row into usable RecordingSettings.
 *
 * Pure, so the three cases that matter can be tested without a database:
 * no row yet (first run), a row written by an older version that predates
 * some fields, and a row that isn't valid JSON at all. All three resolve to
 * something usable -- a recorder that refuses to load its own configuration
 * would be a worse outcome than one that falls back to defaults.
 */
export function parseRecordingSettings(stored: string | null | undefined): RecordingSettings {
  if (!stored) return { ...DEFAULT_RECORDING_SETTINGS }
  try {
    const parsed = JSON.parse(stored)
    // Guards against a row holding a JSON array, number or null, any of
    // which would spread into nonsense rather than throwing.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_RECORDING_SETTINGS }
    }
    return { ...DEFAULT_RECORDING_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_RECORDING_SETTINGS }
  }
}

// --- Encoder capability detection ---
// Shared because the Settings screen reports what was found, and the argument
// builder in the main process decides what to emit from the same values.

export interface EncoderProbeOutcome {
  /** ffmpeg encoder name, e.g. 'h264_nvenc'. */
  name: string
  /** Reported as compiled into this ffmpeg build. */
  available: boolean
  /**
   * Actually initialized and encoded frames on this machine. A different
   * claim from `available`: a build advertising NVENC still advertises it on a
   * machine with no NVIDIA card.
   */
  passed: boolean
  /** Why it failed: ffmpeg's own message, or a timeout note. */
  error: string | null
  durationMs: number
}

export interface EncoderCapabilities {
  probedAt: number
  /** Every candidate, whether or not it was available to probe. */
  outcomes: EncoderProbeOutcome[]
  /** Highest-ranked passing encoder eligible for automatic selection. */
  chosen: string | null
  /** Without this there is no screen capture at all. */
  hasDdagrab: boolean
  hasScalingFilters: boolean
  hasTonemapFilters: boolean
}

/**
 * One capture health sample, parsed from ffmpeg's -progress stream.
 *
 * Reported to the renderer roughly once a second while recording, and kept on
 * the recordings row afterwards so "why does this one look bad" is answerable.
 */
export interface RecorderProgress {
  /** Frames encoded so far. */
  frame: number
  /** Instantaneous encode rate. Well below the target means trouble. */
  fps: number
  /** Bytes written so far. */
  totalSizeBytes: number
  /** Position in the output, milliseconds. */
  outTimeMs: number
  /**
   * Frames the capture pipeline threw away because it couldn't keep up. The
   * single most useful number for "is this recording actually healthy".
   */
  dropFrames: number
  /** Frames repeated to hold the constant output rate. */
  dupFrames: number
  /** Processing speed against real time. Under 1.0 means falling behind. */
  speed: number
  /** True on the final sample, when ffmpeg reports progress=end. */
  ended: boolean
}

// --- Capture targets ---

export interface CaptureDisplay {
  /** Electron display id, which is what gets persisted in settings. */
  id: number
  /**
   * ddagrab output index guess. DXGI enumerates the outputs of one adapter in
   * its own order, which no API reliably joins to Electron's display list --
   * so this is a guess from physical arrangement, presented as a picker rather
   * than applied silently.
   */
  outputIdx: number
  /** Physical pixel size: what actually gets captured. */
  width: number
  height: number
  scaleFactor: number
  isPrimary: boolean
  /** e.g. 'Display 1 (2560x1440, primary)'. */
  label: string
}

export interface AudioCaptureDevice {
  /** The name to pass as `-i audio=<name>`. */
  name: string
  /** DirectShow's unique id, which is what tells two identical headsets apart. */
  alternativeName: string | null
  /**
   * Whether the name suggests desktop audio rather than a microphone. A guess
   * from the name, which is all DirectShow offers, so it is surfaced as a hint
   * and never selected automatically.
   */
  likelyLoopback: boolean
}

// --- Recording sessions ---

/**
 * Where a video came from. Rows written before this column existed are null,
 * which every consumer treats as 'imported' -- the reading that keeps
 * retention away from files the user brought in themselves.
 */
export type VideoSource = 'imported' | 'recorded'

export type RecordingState =
  | 'recording'
  | 'stopping'
  | 'remuxing'
  | 'complete'
  | 'failed'
  | 'discarded'

/** Progress of attaching a finished recording to its Riot match. */
export type RecordingLinkState = 'pending' | 'linked' | 'failed' | 'skipped'

/**
 * One capture session. The row is created when capture starts, not when it
 * finishes, so that a session interrupted by a crash leaves a trace the next
 * launch can find and repair.
 */
export interface RecordingRow {
  id: number
  video_id: number | null
  /** The .mkv being written. */
  temp_path: string
  /** The .mp4 after remux, once there is one. */
  final_path: string | null
  state: RecordingState
  started_at: number
  ended_at: number | null
  /**
   * Measured wall-clock time at which the in-game clock read zero. This is
   * what makes the resulting sync offset a measurement rather than a guess.
   */
  game_start_ms: number | null
  /** platform_gameId, from the League client. */
  match_id_hint: string | null
  platform: string | null
  puuid: string | null
  queue_id: number | null
  champion_name: string | null
  /** JSON-encoded in-game event feed, used only if linking never succeeds. */
  live_events: string | null
  link_state: RecordingLinkState | null
  link_attempts: number
  /** The configuration this session actually ran with. */
  settings_json: string
  ffmpeg_error: string | null
  dropped_frames: number | null
  avg_fps: number | null
  size_bytes: number | null
  created_at: number
}

/**
 * What the recorder is doing. Shared because the header indicator, the tray
 * tooltip and the main-process reducer all describe the same value.
 *
 * 'arming' and 'starting' are separate on purpose: the readiness gate has two
 * independent conditions -- the game being up, and frames actually arriving --
 * and one phase could not say which is outstanding.
 */
export type RecorderPhase =
  | 'disabled'
  | 'idle'
  | 'arming'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'remuxing'
  | 'finalizing'
  | 'failed'

export interface RecorderStateSnapshot {
  phase: RecorderPhase
  /** recordings.id of the session in flight. */
  recordingId: number | null
  /** Wall clock at which capture was confirmed to be producing frames. */
  startedAt: number | null
  /** The .mkv being written. */
  outputPath: string | null
  progress: RecorderProgress | null
  /** Set in the failed phase. */
  error: string | null
  /** Short human-readable reason for the current phase. */
  detail: string | null
  /** Whether automatic recording is switched on. */
  enabled: boolean
}
