import type {
  AppSettings,
  MatchPickerSummary,
  RecordingRow,
  VideoRow
} from '../../../shared/types'

// Fallback slack when a video's duration isn't known (older imports from
// before duration probing existed, or a single-file add that skipped it),
// so recordedAt still has to land close to the match's actual start/end
// instead of just "somewhere in a multi-hour window."
const NO_DURATION_SLACK_MS = 5 * 60 * 1000 // 5 minutes

// Search windows tried in order, centered on the video's recorded-at time.
// Starts tight (fast, few matches to fetch/check) and widens only when a
// window comes back completely empty. Every one of these is a live Riot
// call -- no result caching at this level, deliberately (see the comment on
// riot:fetchRecentMatches in main/riot/ipc.ts for why caching windowed id
// lists silently broke search).
const SEARCH_WINDOWS_MS = [
  1 * 24 * 60 * 60 * 1000, // ±1 day
  7 * 24 * 60 * 60 * 1000, // ±1 week
  30 * 24 * 60 * 60 * 1000, // ±1 month
  180 * 24 * 60 * 60 * 1000, // ±6 months
  730 * 24 * 60 * 60 * 1000 // ±2 years
]

// A recording this recent is very likely a match played moments ago -- one
// the background backfill service hasn't reached yet, since it only warms
// the cache gradually (see backfillService.ts). For a video this fresh,
// jump straight to a plain "most recent matches" lookup (also a live Riot
// call, with no date window at all) BEFORE trying the date-anchored windows
// below. That sidesteps two ways the windowed search could otherwise miss a
// just-played game: the file's parsed date being slightly off, or the ±1 day
// window returning some other, unrelated match played the same day and
// stopping the search there instead of widening.
const RECENTLY_RECORDED_THRESHOLD_MS = 24 * 60 * 60 * 1000

export type LinkedAccountRef = {
  platform: AppSettings['accounts'][number]['platform']
  puuid: string
  accountLabel: string
}

export function accountsFromSettings(settings: AppSettings): LinkedAccountRef[] {
  return settings.accounts.map((a) => ({
    platform: a.platform,
    puuid: a.puuid,
    accountLabel: `${a.gameName}#${a.tagLine}`
  }))
}

/**
 * Auto-link search: looks for matches near a video's recorded-at time,
 * widening the window progressively until something turns up (or all
 * windows are exhausted). Falls back to a plain "most recent matches"
 * lookup when the video has no recorded-at time to anchor a window.
 */
export async function searchMatchesForVideo(
  video: VideoRow,
  settings: AppSettings,
  onProgress?: (message: string) => void
): Promise<MatchPickerSummary[]> {
  const accounts = accountsFromSettings(settings)

  if (!video.recorded_at) {
    onProgress?.('No date on this file -- checking your most recent matches...')
    return window.api.riot.fetchRecentMatches({ accounts, count: 20 })
  }

  // A freshly-recorded video is checked against Riot's most-recent-matches
  // list FIRST, live, before doing any date-windowed search. This is what
  // makes re-linking a match played moments ago work: the background
  // downloader (backfillService.ts) only reaches a new game gradually, so
  // the local cache genuinely doesn't have it yet, but the plain "most
  // recent N matches" endpoint has no date window and no dependency on the
  // cache at all -- it always reflects what Riot has right now.
  const recordedRecently = Date.now() - video.recorded_at <= RECENTLY_RECORDED_THRESHOLD_MS
  if (recordedRecently) {
    onProgress?.('Recording looks recent -- checking your most recent matches first...')
    const recent = await window.api.riot.fetchRecentMatches({ accounts, count: 20 })
    if (recent.length > 0 && findBestMatch(recent, video) !== null) {
      return recent
    }
  }

  // Anchor the search on the earliest plausible recording start. When the
  // filename marks the END of the recording, the game began up to a full
  // duration earlier, so searching only forward from the timestamp can miss
  // the real match entirely.
  const windows = recordingWindows(video)
  const earliestStart = Math.min(...windows.map((w) => w.startMs), video.recorded_at)
  const latestEnd = Math.max(...windows.map((w) => w.endMs), video.recorded_at)

  for (const windowMs of SEARCH_WINDOWS_MS) {
    const days = Math.round(windowMs / (24 * 60 * 60 * 1000))
    onProgress?.(`Searching \u00b1${days} day(s) around the recording date...`)
    const fetched = await window.api.riot.fetchRecentMatches({
      accounts,
      startTimeMs: earliestStart - windowMs,
      endTimeMs: latestEnd + windowMs
    })
    if (fetched.length > 0) return fetched
  }

  return []
}

/**
 * Manual linking pool: every match already downloaded to the local cache
 * that any linked account played in. Deliberately has NO date window and
 * makes no network calls -- manual mode exists for when the file's date is
 * wrong or auto-matching picked the wrong game, so anchoring it to a date
 * (guessed or user-entered) would just reintroduce the same failure mode.
 * Instead the user filters this pool by champion/kills/deaths/lane
 * opponent, which is enough to pin down a specific game.
 *
 * The pool is whatever the background backfill service has downloaded so
 * far; the caller surfaces that count so a partially-downloaded history is
 * visible rather than looking like "no such match exists".
 */
export async function loadCachedMatchPool(
  settings: AppSettings
): Promise<MatchPickerSummary[]> {
  const accounts = accountsFromSettings(settings)
  return window.api.riot.listCachedMatches({ accounts })
}

/**
 * How much a candidate match's [gameStartTimestamp, gameEndTimestamp]
 * window overlaps the video's actual recorded timeframe (recordedAt to
 * recordedAt + duration). This is the real test for "is this plausibly the
 * same game" -- a video recorded while a match was in progress must, by
 * definition, overlap that match's time window.
 *
 * The previous approach only compared recordedAt to gameEndTimestamp, which
 * doesn't catch a match that fully ended before the recording started, as
 * long as it ended "recently enough" (within AUTO_MATCH_WINDOW_MS). That's
 * exactly how a video can get linked to a game it was never part of: since
 * every event's computed video-position comes out negative, every bookmark
 * silently ends up clamped to 0:00 in the player -- which is the visible
 * symptom that flagged this bug.
 *
 * When the video's duration is unknown (older imports from before duration
 * probing existed), falls back to requiring recordedAt to land within
 * NO_DURATION_SLACK_MS of the match's start/end, returning a small positive
 * "valid" signal rather than a real overlap size.
 */
/**
 * A recording's filename timestamp can mean one of two things, and which one
 * depends on the capture tool:
 *
 *   - the moment recording STARTED (e.g. OBS-style naming), or
 *   - the moment recording FINISHED (e.g. Outplay, which names the file when
 *     it writes it out).
 *
 * Verified against real data in this project: a 26:06 recording of a 26:33
 * game had a filename timestamp 657ms after the game's END, not its start.
 * Assuming "start" for that file shifted every bookmark a whole game-length
 * negative (all clamped to 0:00) and made the match search look for a game
 * in the 26 minutes AFTER the real one finished.
 *
 * Rather than guessing a convention globally, both interpretations are
 * treated as candidates and whichever actually fits the match is used. With
 * no duration known there's only one interpretation available.
 */
export interface RecordingWindow {
  startMs: number
  endMs: number
  /** What the filename timestamp was taken to mean. */
  interpretation: 'filename-is-start' | 'filename-is-end'
}

export function recordingWindows(
  video: Pick<VideoRow, 'recorded_at' | 'duration_ms'>
): RecordingWindow[] {
  const recordedAt = video.recorded_at
  if (!recordedAt) return []
  const duration = video.duration_ms
  if (!duration) {
    return [{ startMs: recordedAt, endMs: recordedAt, interpretation: 'filename-is-start' }]
  }
  return [
    { startMs: recordedAt, endMs: recordedAt + duration, interpretation: 'filename-is-start' },
    { startMs: recordedAt - duration, endMs: recordedAt, interpretation: 'filename-is-end' }
  ]
}

/** Overlap in ms between a recording window and a match's time span. */
function windowOverlapMs(
  window: RecordingWindow,
  matchStart: number,
  matchEnd: number
): number {
  return Math.min(window.endMs, matchEnd) - Math.max(window.startMs, matchStart)
}

/**
 * Best overlap between this match and either interpretation of the video's
 * filename timestamp, plus which interpretation produced it.
 */
export function bestRecordingFit(
  match: Pick<MatchPickerSummary, 'gameStartTimestamp' | 'gameEndTimestamp'>,
  video: Pick<VideoRow, 'recorded_at' | 'duration_ms'>
): { overlapMs: number; window: RecordingWindow } | null {
  const windows = recordingWindows(video)
  if (windows.length === 0) return null

  const matchStart = match.gameStartTimestamp
  const matchEnd = match.gameEndTimestamp

  let best: { overlapMs: number; window: RecordingWindow } | null = null

  for (const window of windows) {
    // Zero-length window (duration unknown): fall back to "did the filename
    // timestamp land near the match at all", with a small tolerance.
    const overlap =
      window.startMs === window.endMs
        ? window.startMs >= matchStart - NO_DURATION_SLACK_MS &&
          window.startMs <= matchEnd + NO_DURATION_SLACK_MS
          ? 1
          : -1
        : windowOverlapMs(window, matchStart, matchEnd)

    if (!best || overlap > best.overlapMs) best = { overlapMs: overlap, window }
  }

  return best
}

function matchOverlapMs(match: MatchPickerSummary, video: VideoRow): number {
  return bestRecordingFit(match, video)?.overlapMs ?? -1
}

/**
 * Finds the best-fitting match for a video, skipping any match id already
 * claimed by another video -- otherwise two videos recorded close together
 * can both get auto-matched to the same game, silently producing a wrong
 * link for one of them. Requires the candidate's time window to actually
 * overlap the recording (see matchOverlapMs) rather than just ending
 * "recently"; ties are broken by whichever match starts closest to
 * recordedAt.
 */
export function findBestMatch(
  matches: MatchPickerSummary[],
  video: Pick<VideoRow, 'recorded_at' | 'duration_ms'>,
  excludeMatchIds: Set<string> = new Set()
): MatchPickerSummary | null {
  const recordedAt = video.recorded_at
  if (!recordedAt || matches.length === 0) return null

  let best: MatchPickerSummary | null = null
  let bestOverlap = -Infinity
  let bestStartDiff = Infinity

  for (const m of matches) {
    if (excludeMatchIds.has(m.matchId)) continue
    const overlap = matchOverlapMs(m, video as VideoRow)
    const startDiff = Math.abs(m.gameStartTimestamp - recordedAt)

    if (overlap > bestOverlap || (overlap === bestOverlap && startDiff < bestStartDiff)) {
      bestOverlap = overlap
      bestStartDiff = startDiff
      best = m
    }
  }

  // Require an actual overlap: matchOverlapMs returns a positive number
  // (real overlap span, or 1 for the no-duration slack case) only when the
  // recording's timeframe genuinely intersects the match's timeframe. A
  // non-positive result means they don't actually overlap, no matter how
  // "close" the raw timestamps looked -- so it's not a real candidate.
  return bestOverlap > 0 ? best : null
}

/** Fetches the full match bundle and writes the link + auto-tags for a video. */
export async function linkVideoToMatch(video: VideoRow, match: MatchPickerSummary): Promise<void> {
  const bundle = await window.api.riot.fetchMatchBundle({
    platform: match.platform,
    matchId: match.matchId,
    puuid: match.puuid
  })

  // video_time_ms = game_time_ms + sync_offset_ms, so the offset is
  // (gameStart - recordingStart). Getting recordingStart right is the whole
  // problem: the filename timestamp may mark either the start or the end of
  // the recording (see recordingWindows). Pick whichever interpretation
  // actually overlaps this match, so bookmarks land in the right place
  // instead of being shifted a whole game-length negative.
  const gameStart = bundle.match.info.gameStartTimestamp
  const fit = bestRecordingFit(
    { gameStartTimestamp: gameStart, gameEndTimestamp: bundle.match.info.gameEndTimestamp },
    video
  )
  const recordingStart = fit ? fit.window.startMs : (video.recorded_at ?? gameStart)
  const syncOffsetMs = gameStart - recordingStart

  await window.api.db.linkVideoToMatch({
    videoId: video.id,
    matchId: match.matchId,
    syncOffsetMs,
    championName: bundle.participant.championName,
    kda: `${bundle.participant.kills}/${bundle.participant.deaths}/${bundle.participant.assists}`,
    win: bundle.participant.win,
    kills: bundle.participant.kills,
    deaths: bundle.participant.deaths,
    assists: bundle.participant.assists,
    cs: bundle.derived.cs,
    goldDiff: bundle.derived.goldDiff,
    enemyChampionName: bundle.derived.enemyChampionName,
    summoner1Id: bundle.participant.summoner1Id,
    summoner2Id: bundle.participant.summoner2Id,
    keystoneId: bundle.derived.keystoneId,
    gameMode: bundle.match.info.gameMode,
    matchData: bundle.derived.rosterData,
    teamPosition: bundle.derived.teamPosition,
    queueId: bundle.derived.queueId
  })

  await window.api.db.clearAutoTags(video.id)
  await window.api.db.insertTags({
    videoId: video.id,
    tags: bundle.events.map((ev) => ({
      timestampMs: ev.gameTimestampMs + syncOffsetMs,
      type: ev.type,
      label: ev.label,
      detail: ev.detail ?? null,
      source: 'auto' as const
    }))
  })
}

/** Returns the set of match ids already linked to some video, for exclusion. */
export async function getClaimedMatchIds(excludeVideoId?: number): Promise<Set<string>> {
  const videos = await window.api.db.listVideos()
  const claimed = new Set<string>()
  for (const v of videos) {
    if (v.match_id && v.id !== excludeVideoId) claimed.add(v.match_id)
  }
  return claimed
}

/**
 * Regenerates a video's bookmarks from its EXISTING match link, without
 * searching for a match again.
 *
 * Needed whenever bookmark generation itself changes (new event types, a
 * corrected timing rule) -- the link is already right, it's the derived tags
 * that are stale. Runs entirely off cached match/timeline data, so it costs no
 * API budget and is fast enough to run across a whole library.
 *
 * Recomputes the sync offset too, since the old value may have come from the
 * mistaken assumption that a filename timestamp marks the start of a
 * recording. That does discard a manually-adjusted offset, which is the
 * trade-off for repairing the automatically-wrong ones.
 */
export async function rebuildBookmarks(video: VideoRow, settings: AppSettings): Promise<boolean> {
  if (!video.match_id) return false

  // Which linked account played this match isn't recorded on the video row,
  // so try each until one is found among the participants.
  for (const account of settings.accounts) {
    try {
      const bundle = await window.api.riot.fetchMatchBundle({
        platform: account.platform,
        matchId: video.match_id,
        puuid: account.puuid
      })

      const gameStart = bundle.match.info.gameStartTimestamp
      const fit = bestRecordingFit(
        { gameStartTimestamp: gameStart, gameEndTimestamp: bundle.match.info.gameEndTimestamp },
        video
      )
      const recordingStart = fit ? fit.window.startMs : (video.recorded_at ?? gameStart)
      const syncOffsetMs = gameStart - recordingStart

      await window.api.db.updateSyncOffset({ videoId: video.id, syncOffsetMs })
      await window.api.db.clearAutoTags(video.id)
      await window.api.db.insertTags({
        videoId: video.id,
        tags: bundle.events.map((ev) => ({
          timestampMs: ev.gameTimestampMs + syncOffsetMs,
          type: ev.type,
          label: ev.label,
          detail: ev.detail ?? null,
          source: 'auto' as const
        }))
      })
      return true
    } catch {
      // Wrong account for this match (or its data isn't cached) -- try the
      // next one rather than failing the whole rebuild.
      continue
    }
  }

  return false
}

// --- Linking LeagueVid's own recordings ---
//
// A recording LeagueVid made knows two things an imported file never can: the
// exact match id, read from the League client, and the wall-clock time its
// first frame landed. That makes linking a lookup rather than a search, and the
// sync offset a measurement rather than an inference.
//
// Everything above this line exists because an imported file offers neither. It
// stays as the fallback: a custom game has no match id, the League client may
// not have been running, and Riot occasionally never publishes a match at all.

/**
 * Retry schedule for the hinted lookup.
 *
 * Riot's match-v5 endpoint does not publish a match the instant it ends -- the
 * lag is seconds to minutes, and longer when their platform is busy. So the
 * first attempt failing is the normal case rather than an error, and these
 * delays are spaced to cover the usual window without hammering the API.
 */
export const RECORDED_LINK_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000]

/** Delay before attempt N (0-based), or null once the schedule is exhausted. */
export function nextRetryDelayMs(attempt: number): number | null {
  return RECORDED_LINK_BACKOFF_MS[attempt] ?? null
}

export function hasExhaustedRetries(attempts: number): boolean {
  return attempts >= RECORDED_LINK_BACKOFF_MS.length
}

/**
 * The recording's true start: the moment the first frame landed.
 *
 * Falls back to the spawn time for rows written before first_frame_ms existed,
 * or for a session that never reached the frames-flowing state.
 */
export function recordingStartMs(
  recording: Pick<RecordingRow, 'first_frame_ms' | 'started_at'>
): number {
  return recording.first_frame_ms ?? recording.started_at
}

/**
 * The measured sync offset.
 *
 * Same relationship the rest of the app uses -- video_time = game_time +
 * offset -- but both terms are now known rather than guessed at. No filename
 * parsing, no overlap search, no choosing between "the timestamp means the
 * start" and "the timestamp means the end".
 */
export function measuredSyncOffsetMs(
  gameStartTimestamp: number,
  recording: Pick<RecordingRow, 'first_frame_ms' | 'started_at'>
): number {
  return gameStartTimestamp - recordingStartMs(recording)
}

export interface RecordedLinkResult {
  linked: boolean
  /** Which path produced the link, for logging and for the pending queue. */
  via: 'hint' | 'search' | 'none'
  /** Set when nothing could be linked, phrased for a person. */
  reason: string | null
  /** True when it's worth trying again later. */
  retryable: boolean
}

/**
 * Links a recorded video using its match-id hint, falling back to the search.
 *
 * The hint path is a single fetch of a known match id -- no windowed search, no
 * candidate scoring, no exclusion set, because there is nothing to disambiguate.
 */
export async function linkRecordedVideo(
  video: VideoRow,
  recording: RecordingRow,
  settings: AppSettings
): Promise<RecordedLinkResult> {
  const hint = recording.match_id_hint

  if (hint) {
    // The account that played it is recorded on the session, but fall back to
    // trying each linked account: a puuid is minted per API key, so a key
    // change between recording and linking would otherwise strand the video.
    const candidates = recording.puuid
      ? [
          {
            platform: (recording.platform ?? settings.accounts[0]?.platform) as
              | AppSettings['accounts'][number]['platform']
              | undefined,
            puuid: recording.puuid
          },
          ...settings.accounts.map((a) => ({ platform: a.platform, puuid: a.puuid }))
        ]
      : settings.accounts.map((a) => ({ platform: a.platform, puuid: a.puuid }))

    for (const candidate of candidates) {
      if (!candidate.platform || !candidate.puuid) continue
      try {
        const bundle = await window.api.riot.fetchMatchBundle({
          platform: candidate.platform,
          matchId: hint,
          puuid: candidate.puuid
        })

        await applyRecordedLink(video, recording, hint, bundle)
        return { linked: true, via: 'hint', reason: null, retryable: false }
      } catch {
        // Almost always "not published yet". Try the next account, then retry
        // later on the backoff schedule.
        continue
      }
    }
  }

  // No hint, or the hint never resolved. The search path is less precise but it
  // is the only option for a custom game or a match Riot never published.
  const matches = await searchMatchesForVideo(video, settings)
  const claimed = await getClaimedMatchIds(video.id)
  const best = findBestMatch(matches, video, claimed)

  if (best) {
    await linkVideoToMatch(video, best)
    return { linked: true, via: 'search', reason: null, retryable: false }
  }

  return {
    linked: false,
    via: 'none',
    reason: hint
      ? `Riot hasn't published match ${hint} yet.`
      : 'No matching game was found for this recording.',
    retryable: true
  }
}

/**
 * Writes the link and bookmarks for a recorded video.
 *
 * Split out from linkVideoToMatch rather than reusing it because that function
 * derives the recording start from the filename, which is precisely the step
 * this whole path exists to skip.
 */
async function applyRecordedLink(
  video: VideoRow,
  recording: RecordingRow,
  matchId: string,
  bundle: Awaited<ReturnType<typeof window.api.riot.fetchMatchBundle>>
): Promise<void> {
  const syncOffsetMs = measuredSyncOffsetMs(bundle.match.info.gameStartTimestamp, recording)

  await window.api.db.linkVideoToMatch({
    videoId: video.id,
    matchId,
    syncOffsetMs,
    championName: bundle.participant.championName,
    kda: `${bundle.participant.kills}/${bundle.participant.deaths}/${bundle.participant.assists}`,
    win: bundle.participant.win,
    kills: bundle.participant.kills,
    deaths: bundle.participant.deaths,
    assists: bundle.participant.assists,
    cs: bundle.derived.cs,
    goldDiff: bundle.derived.goldDiff,
    enemyChampionName: bundle.derived.enemyChampionName,
    summoner1Id: bundle.participant.summoner1Id,
    summoner2Id: bundle.participant.summoner2Id,
    keystoneId: bundle.derived.keystoneId,
    gameMode: bundle.match.info.gameMode,
    matchData: bundle.derived.rosterData,
    teamPosition: bundle.derived.teamPosition,
    queueId: bundle.derived.queueId
  })

  await window.api.db.clearAutoTags(video.id)
  await window.api.db.insertTags({
    videoId: video.id,
    tags: bundle.events.map((ev) => ({
      timestampMs: ev.gameTimestampMs + syncOffsetMs,
      type: ev.type,
      label: ev.label,
      detail: ev.detail ?? null,
      source: 'auto' as const
    }))
  })
}

/**
 * Attempts every recording still waiting to be linked.
 *
 * Called when the library mounts, which covers the case the push channels
 * cannot: recordings made while the window was closed, or while the app was
 * running in the tray with no renderer alive to react to them.
 */
export async function drainPendingRecordingLinks(
  settings: AppSettings,
  onProgress?: (message: string) => void
): Promise<number> {
  if (settings.accounts.length === 0) return 0

  const pending = await window.api.recorder.getPendingLinks()
  if (pending.length === 0) return 0

  let linked = 0
  for (const recording of pending) {
    if (recording.video_id == null) continue

    const video = await window.api.db.getVideo(recording.video_id)
    if (!video) {
      // The library row was deleted; there is nothing left to link.
      await window.api.recorder.setLinkState({ recordingId: recording.id, state: 'skipped' })
      continue
    }
    if (video.match_id) {
      await window.api.recorder.setLinkState({ recordingId: recording.id, state: 'linked' })
      continue
    }

    onProgress?.(`Linking ${video.file_name}...`)
    await window.api.recorder.bumpLinkAttempt(recording.id)

    try {
      const result = await linkRecordedVideo(video, recording, settings)
      if (result.linked) {
        await window.api.recorder.setLinkState({ recordingId: recording.id, state: 'linked' })
        linked++
        continue
      }

      // Give up only once the schedule is exhausted, so a match Riot publishes
      // late still gets picked up on a later visit to the library.
      if (hasExhaustedRetries(recording.link_attempts + 1)) {
        await window.api.recorder.setLinkState({ recordingId: recording.id, state: 'failed' })
      }
    } catch {
      // Network or API trouble. Left pending for the next attempt.
    }
  }

  return linked
}
