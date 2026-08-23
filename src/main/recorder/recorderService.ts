import { BrowserWindow } from 'electron'
import { basename, dirname, join } from 'path'
import { statSync, unlinkSync } from 'fs'
import type { RecorderProgress, RecordingSettings, VideoRow } from '../../shared/types'
import {
  getRecording,
  getRecordingSettings,
  insertRecording,
  insertVideo,
  updateRecording
} from '../db/repository'
import type { AudioInputSpec, CaptureTarget } from './ffmpegArgs'
import { ffmpegBinaryPath } from './ffmpegBinary'
import type { CaptureHandle } from './ffmpegProcess'
import { activeCaptureBackend, pinBackend } from './backendSelection'
import { DISPLAY_CAPTURE_SCOPE, LEAGUE_CAPTURE_SCOPE } from './obsConfig'
import type { CaptureBackend } from './captureBackend'
import { spawn } from 'child_process'
import { buildSessionPath } from './outputPaths'
import { assessCaptureHealth } from './progressParser'
import { remuxToMp4 } from './remux'
import {
  cleanupConcatList,
  listSegments,
  prepareRing,
  ringFor,
  selectRecentSegments,
  writeConcatList,
  type ReplayRing
} from './replayBuffer'
import {
  initialRecorderState,
  recorderReducer,
  type RecorderEvent,
  type RecorderStateSnapshot
} from './recorderState'

// Owns the capture child and is the only writer of recorder state.
//
// Everything about *what state comes next* lives in recorderState.ts; this
// module's job is the side effects -- spawning, remuxing, importing -- and
// telling the renderer what happened. Keeping those apart is what makes the
// lifecycle testable without ffmpeg.

/** Push channels. New pattern in this codebase: nothing else uses send. */
export const RECORDER_CHANNELS = {
  state: 'recorder:state',
  progress: 'recorder:progress',
  recordingSaved: 'recorder:recordingSaved',
  error: 'recorder:error'
} as const

export interface RecordingSavedPayload {
  recordingId: number
  video: VideoRow
  /** False when the remux failed and the Matroska file was imported instead. */
  converted: boolean
}

let state: RecorderStateSnapshot = initialRecorderState(false)
let handle: CaptureHandle | null = null
let currentSettings: RecordingSettings | null = null

/**
 * The backend recording the session in flight.
 *
 * Held for the whole session rather than re-resolved, because the post-capture
 * steps depend on which one wrote the file -- whether it needs remuxing, and
 * where a replay comes from. Re-asking after selection changed mid-game would
 * remux a file the other backend never wrote.
 */
let currentBackend: CaptureBackend | null = null

/**
 * Notified when frames start arriving.
 *
 * A registered callback rather than an import of the automatic-recording host,
 * which would make the two modules import each other. The host is the layer
 * above this one; it may know about the service, not the reverse.
 */
let framesFlowingListener: (() => void) | null = null

export function onFramesFlowing(listener: (() => void) | null): void {
  framesFlowingListener = listener
}

/**
 * Resolves when the current session has finished being written to the library.
 * Null when nothing is in flight.
 */
let sessionCompletion: Promise<void> | null = null
let resolveSessionCompletion: (() => void) | null = null

/** The replay ring for the session in flight, when the buffer is enabled. */
let activeRing: ReplayRing | null = null

/**
 * Sends to every open window.
 *
 * Every push channel also has a pull handler in ipc.ts. That pairing is not
 * redundancy: a renderer that mounts halfway through a recording has missed
 * every push so far, and without a pull it would sit blank until something
 * changed.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function dispatch(event: RecorderEvent): RecorderStateSnapshot {
  const next = recorderReducer(state, event)
  // Identity means the reducer rejected the event as illegal in this phase.
  // Broadcasting anyway would produce a stream of no-op updates.
  if (next === state) return state

  state = next
  broadcast(RECORDER_CHANNELS.state, state)
  for (const listener of stateListeners) {
    try {
      listener(state)
    } catch {
      // A misbehaving observer must not derail the recorder.
    }
  }
  return state
}

export function getRecorderState(): RecorderStateSnapshot {
  return state
}

/**
 * Main-process observers of recorder state: the tray tooltip and the power-save
 * blocker. Separate from the renderer broadcast because these have to work with
 * no window open at all, which is exactly when the tray matters most.
 */
const stateListeners = new Set<(state: RecorderStateSnapshot) => void>()

export function onRecorderStateChange(
  listener: (state: RecorderStateSnapshot) => void
): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

/** Called once at startup, after the database is available. */
export function initRecorderService(): void {
  const settings = getRecordingSettings()
  state = initialRecorderState(settings.enabled)
  // Applied at startup as well as on save, or a pinned backend would quietly
  // revert to automatic selection on every launch.
  pinBackend(settings.captureBackend ?? null)
}

export function setRecordingEnabled(enabled: boolean): RecorderStateSnapshot {
  return dispatch({ type: enabled ? 'enable' : 'disable' })
}

export interface StartRecordingOptions {
  /** True when the user pressed record rather than a game being detected. */
  manual?: boolean
  championName?: string | null
  matchIdHint?: string | null
  platform?: string | null
  puuid?: string | null
  queueId?: number | null
  gameStartMs?: number | null
  /** Capture target; resolved by the caller from the display list. */
  target: CaptureTarget
  audioInputs?: AudioInputSpec[]
  /** Encoder to fall back on when settings pin none. */
  fallbackEncoder?: string
}

/**
 * Spawns the capture child and wires its lifecycle back into the reducer.
 *
 * Returns the state after the attempt. A refusal (already busy, spawn failed)
 * is reported through state rather than thrown: the caller is often a game
 * event, not a user action, and there is nobody to catch an exception.
 */
export async function startRecording(
  options: StartRecordingOptions
): Promise<RecorderStateSnapshot> {
  if (handle) return state

  const settings = getRecordingSettings()
  currentSettings = settings

  const outputPath = buildSessionPath({ championName: options.championName })
  const startedAt = Date.now()

  const row = insertRecording({
    tempPath: outputPath,
    startedAt,
    settingsJson: JSON.stringify(settings),
    platform: options.platform,
    puuid: options.puuid,
    matchIdHint: options.matchIdHint,
    gameStartMs: options.gameStartMs,
    queueId: options.queueId,
    championName: options.championName
  })

  const backend = await activeCaptureBackend()
  currentBackend = backend

  // The replay ring is written by the same encode as the session file, so it
  // has to be decided before the child is spawned -- it cannot be switched on
  // mid-recording.
  //
  // Skipped entirely for a backend that owns its replay buffer: preparing a ring
  // it will never write into would create an empty directory and, worse, make
  // isReplayBufferActive() claim a buffer that nothing is filling.
  activeRing =
    settings.replayBufferEnabled && !backend.ownsReplayBuffer
      ? ringFor(join(dirname(outputPath), 'replay-buffer'), settings.replayBufferSeconds)
      : null
  if (activeRing) prepareRing(activeRing)

  // Created before the child so the quit path can never observe a capture with
  // no completion promise attached to it.
  sessionCompletion = new Promise<void>((resolve) => {
    resolveSessionCompletion = resolve
  })

  try {
    handle = await backend.start(
      {
        settings,
        target: options.target,
        outputPath,
        // Pressing Record by hand means "record what I am doing", so it takes the
        // whole screen. Automatic recording exists to capture League matches, so
        // it follows the game and nothing else -- alt-tabbing to a browser
        // mid-game should not end up in the VOD.
        scope: options.manual ? DISPLAY_CAPTURE_SCOPE : LEAGUE_CAPTURE_SCOPE,
        audioInputs: options.audioInputs ?? [],
        // Only described for a backend that implements the buffer with a segment
        // ring. One that owns its own must not be handed a ring to write into as
        // well, or the footage would be captured twice.
        replay:
          activeRing && !backend.ownsReplayBuffer
            ? {
                segmentPattern: activeRing.pattern,
                segmentSeconds: activeRing.segmentSeconds,
                segmentCount: activeRing.segmentCount
              }
            : undefined,
        fallbackEncoder: options.fallbackEncoder
      },
      {
        onProgress: (sample) => {
          dispatch({ type: 'progress', sample })
          broadcast(RECORDER_CHANNELS.progress, sample)
          reportHealth(sample)
        },
        onFirstFrames: () => {
          const at = Date.now()
          dispatch({ type: 'frames-flowing', at })
          // Persisted because this is the timestamp the sync offset is computed
          // from when the recording is linked to its match.
          updateRecording(row.id, { firstFrameMs: at })
          // Cancels the readiness timeout: frames are arriving, so this capture
          // is real rather than a pipeline that opened a display and stalled.
          framesFlowingListener?.()
        },
        onWarning: reportRecorderProblem
      }
    )
  } catch (err) {
    const message = (err as Error).message
    updateRecording(row.id, { state: 'failed', endedAt: Date.now(), ffmpegError: message })
    dispatch({ type: 'failure', message })
    broadcast(RECORDER_CHANNELS.error, message)
    finishSessionCompletion()
    return state
  }

  dispatch({
    type: 'capture-armed',
    recordingId: row.id,
    outputPath,
    manual: options.manual
  })

  // Deliberately not awaited: this resolves when the recording ends, which is
  // up to forty minutes away.
  void handle.exited.then((exit) => finishSession(row.id, outputPath, exit))

  return state
}

/** Warns once per problem rather than every second it persists. */
let lastHealthWarning = ''

function reportHealth(sample: RecorderProgress): void {
  const health = assessCaptureHealth(sample)
  if (health.healthy) {
    lastHealthWarning = ''
    return
  }
  const message = health.reasons.join(' ')
  if (message === lastHealthWarning) return
  lastHealthWarning = message

  // Logged as well as broadcast. Automatic recording is the normal case and it
  // runs with LeagueVid in the tray, where there is no window to receive the
  // broadcast -- so without this the one warning that matters would be delivered
  // to nobody during exactly the sessions it was written for.
  console.warn(`[recorder] capture health: ${message}`)
  broadcast(RECORDER_CHANNELS.error, message)
}

export async function stopRecording(reason = 'Stopped by hand'): Promise<RecorderStateSnapshot> {
  if (!handle) return state
  dispatch({ type: 'stop-requested', reason })
  await handle.stop()
  return state
}

/** Signals that the game is over; the stop delay is applied by the caller. */
export async function stopForGameEnd(): Promise<RecorderStateSnapshot> {
  if (!handle) return state
  dispatch({ type: 'game-ended' })
  await handle.stop()
  return state
}

/**
 * Post-capture: remux, decide whether the recording is worth keeping, import.
 */
async function finishSession(
  recordingId: number,
  tempPath: string,
  exit: Awaited<CaptureHandle['exited']>
): Promise<void> {
  handle = null

  dispatch({ type: 'child-exited', code: exit.code, forced: exit.forced })

  const settings = currentSettings ?? getRecordingSettings()
  const durationMs = exit.lastProgress?.outTimeMs ?? 0

  updateRecording(recordingId, {
    state: 'remuxing',
    endedAt: Date.now(),
    droppedFrames: exit.lastProgress?.dropFrames ?? null,
    avgFps: exit.lastProgress?.fps ?? null,
    ffmpegError: exit.code === 0 ? null : exit.stderrTail.trim() || null
  })

  // A remake, or a session that never really got going. Discarding is the
  // point of the minimum: nobody wants a library full of 90-second remakes.
  // Judged before remuxing, so a discard costs no conversion work.
  if (durationMs > 0 && durationMs < settings.minKeepDurationMs) {
    discard(recordingId, tempPath)
    dispatch({ type: 'remux-finished', ok: true })
    dispatch({ type: 'finalized', discarded: true })
    finishSessionCompletion()
    return
  }

  // Only Matroska needs converting. A backend that already writes a playable
  // MP4 must not be re-containerised: it would cost a full copy of a
  // multi-gigabyte file for no change in what plays.
  const remux =
    (currentBackend?.sessionContainer ?? 'matroska') === 'mp4'
      ? { ok: true, importPath: tempPath, sizeBytes: sizeOf(tempPath), error: null }
      : await remuxToMp4({ ffmpegPath: ffmpegBinaryPath(), sourcePath: tempPath })
  dispatch({ type: 'remux-finished', ok: remux.ok, error: remux.error })

  // On failure remuxToMp4 hands back the Matroska file, so the footage is
  // still imported -- in the wrong container, which beats losing it.
  const video = insertVideo({
    filePath: remux.importPath,
    fileName: basename(remux.importPath),
    recordedAt: recordedAtFor(recordingId),
    durationMs: durationMs > 0 ? durationMs : null,
    source: 'recorded'
  })

  updateRecording(recordingId, {
    state: 'complete',
    finalPath: remux.ok ? remux.importPath : null,
    sizeBytes: remux.sizeBytes,
    videoId: video.id,
    linkState: 'pending',
    ffmpegError: remux.error
  })

  broadcast(RECORDER_CHANNELS.recordingSaved, {
    recordingId,
    video,
    converted: remux.ok
  } satisfies RecordingSavedPayload)

  dispatch({ type: 'finalized', discarded: false })
  finishSessionCompletion()
}

function finishSessionCompletion(): void {
  resolveSessionCompletion?.()
  resolveSessionCompletion = null
  sessionCompletion = null
  currentBackend = null
  // The ring belongs to the session that just ended. Left in place, a later
  // replay save would reach back into the previous game's footage.
  activeRing = null
}

/**
 * Recording time for the library row.
 *
 * The measured game start is preferable to the moment capture began: it's the
 * number bookmarks are placed against, and it's what the user thinks of as
 * when they played.
 */
function recordedAtFor(recordingId: number): number {
  const row = getRecording(recordingId)
  return row?.game_start_ms ?? row?.started_at ?? Date.now()
}

/** Size on disk, or 0 when the file is not there. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function discard(recordingId: number, tempPath: string): void {
  const size = sizeOf(tempPath)
  try {
    unlinkSync(tempPath)
  } catch {
    // Leaving the file costs disk but nothing else.
  }
  updateRecording(recordingId, {
    state: 'discarded',
    linkState: 'skipped',
    sizeBytes: size,
    finalPath: null
  })
}

/** True while a capture child exists -- used by the quit path. */
export function hasActiveCapture(): boolean {
  return handle !== null
}

/** Whether frames have actually been observed for the current capture. */
export function isProducingFrames(): boolean {
  return handle?.isProducingFrames() ?? false
}

/**
 * Stores the in-game event feed against the session in flight.
 *
 * Stored as an object with the player's own name rather than a bare array,
 * because kill/death/assist attribution needs to know who "you" were and the
 * game is long gone by the time the fallback runs.
 */
export function persistLiveEventsForCurrentSession(payload: {
  activePlayerName: string | null
  events: unknown[]
}): void {
  const recordingId = state.recordingId
  if (recordingId == null) return
  updateRecording(recordingId, { liveEvents: JSON.stringify(payload) })
}

/** Reports a problem to every window without changing recorder state. */
export function reportRecorderProblem(message: string): void {
  broadcast(RECORDER_CHANNELS.error, message)
}

export interface SaveReplayResult {
  outputPath: string
  durationSeconds: number
  sizeBytes: number
}

/**
 * Saves the last N seconds as its own file, without interrupting the recording.
 *
 * Reads the segment ring the tee muxer is already writing, so this costs a
 * stream copy of a couple of files rather than a second encode. The recording
 * carries on untouched -- pressing the hotkey after a good play must not risk
 * the rest of the game.
 */
export async function saveReplay(): Promise<SaveReplayResult> {
  const settings = currentSettings ?? getRecordingSettings()

  // A backend with its own replay buffer keeps the footage in memory and writes
  // it on request, so there are no segments to concatenate. Its file still has
  // to reach the library, which is the part that is the service's job either way.
  if (currentBackend?.ownsReplayBuffer && currentBackend.saveReplay) {
    const saved = await currentBackend.saveReplay()
    const video = insertVideo({
      filePath: saved.outputPath,
      fileName: basename(saved.outputPath),
      recordedAt: Date.now() - saved.durationSeconds * 1000,
      durationMs: saved.durationSeconds * 1000,
      source: 'recorded'
    })
    broadcast(RECORDER_CHANNELS.recordingSaved, {
      recordingId: -1,
      video,
      converted: true
    } satisfies RecordingSavedPayload)
    return {
      outputPath: saved.outputPath,
      durationSeconds: saved.durationSeconds,
      sizeBytes: sizeOf(saved.outputPath)
    }
  }

  if (!activeRing) {
    throw new Error('The replay buffer is not running. Turn it on in Settings before recording.')
  }

  const segments = selectRecentSegments(
    listSegments(activeRing.directory),
    settings.replayBufferSeconds,
    activeRing.segmentSeconds
  )

  if (segments.length === 0) {
    throw new Error('There is no buffered footage to save yet.')
  }

  const listPath = writeConcatList(activeRing.directory, segments)
  const outputPath = buildSessionPath({ championName: 'Replay' }).replace(/\.mkv$/i, '.mp4')

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpegBinaryPath(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'concat',
          // The list holds absolute paths, which concat refuses without this.
          '-safe',
          '0',
          '-i',
          listPath,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-y',
          outputPath
        ],
        { windowsHide: true }
      )
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.trim() || `Exited with code ${code}.`))
      )
    })
  } finally {
    cleanupConcatList(listPath)
  }

  const sizeBytes = statSync(outputPath).size
  const video = insertVideo({
    filePath: outputPath,
    fileName: basename(outputPath),
    recordedAt: Date.now() - settings.replayBufferSeconds * 1000,
    durationMs: settings.replayBufferSeconds * 1000,
    source: 'recorded'
  })

  broadcast(RECORDER_CHANNELS.recordingSaved, {
    recordingId: -1,
    video,
    converted: true
  } satisfies RecordingSavedPayload)

  return {
    outputPath,
    durationSeconds: segments.length * activeRing.segmentSeconds,
    sizeBytes
  }
}

export function isReplayBufferActive(): boolean {
  // Either the service is filling a segment ring, or the backend is holding a
  // buffer of its own. The hotkey has to work in both cases.
  if (activeRing !== null) return true
  return Boolean(handle && currentBackend?.ownsReplayBuffer && currentSettings?.replayBufferEnabled)
}

/** Which capture technology is recording, or would. For Settings and logs. */
export function currentBackendId(): string | null {
  return currentBackend?.id ?? null
}

/**
 * Resolves when the session in flight has been stopped, remuxed and imported.
 *
 * Waiting for the capture child to exit is not enough: the remux and the
 * library insert happen after it, and quitting between them would leave a
 * Matroska file with no library row -- recoverable on the next launch, but only
 * because of the recovery sweep. Waiting for the whole sequence is better.
 */
export function currentSessionCompletion(): Promise<void> | null {
  return sessionCompletion
}
