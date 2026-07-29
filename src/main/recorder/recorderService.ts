import { BrowserWindow } from 'electron'
import { basename } from 'path'
import { statSync, unlinkSync } from 'fs'
import type { RecorderProgress, RecordingSettings, VideoRow } from '../../shared/types'
import {
  getRecording,
  getRecordingSettings,
  insertRecording,
  insertVideo,
  updateRecording
} from '../db/repository'
import { buildCaptureArgs, type AudioInputSpec, type CaptureTarget } from './ffmpegArgs'
import { ffmpegBinaryPath } from './ffmpegBinary'
import { startCapture, type CaptureHandle } from './ffmpegProcess'
import { buildSessionPath } from './outputPaths'
import { assessCaptureHealth } from './progressParser'
import { remuxToMp4 } from './remux'
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
  return state
}

export function getRecorderState(): RecorderStateSnapshot {
  return state
}

/** Called once at startup, after the database is available. */
export function initRecorderService(): void {
  const settings = getRecordingSettings()
  state = initialRecorderState(settings.enabled)
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

  const args = buildCaptureArgs(
    {
      settings,
      target: options.target,
      outputPath,
      audioInputs: options.audioInputs ?? []
    },
    options.fallbackEncoder
  )

  try {
    handle = startCapture({
      ffmpegPath: ffmpegBinaryPath(),
      args,
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
      }
    })
  } catch (err) {
    const message = (err as Error).message
    updateRecording(row.id, { state: 'failed', endedAt: Date.now(), ffmpegError: message })
    dispatch({ type: 'failure', message })
    broadcast(RECORDER_CHANNELS.error, message)
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
    return
  }

  const remux = await remuxToMp4({ ffmpegPath: ffmpegBinaryPath(), sourcePath: tempPath })
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

function discard(recordingId: number, tempPath: string): void {
  let size = 0
  try {
    size = statSync(tempPath).size
  } catch {
    // Already gone.
  }
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

/** Stores the in-game event feed against the session in flight. */
export function persistLiveEventsForCurrentSession(events: unknown[]): void {
  const recordingId = state.recordingId
  if (recordingId == null) return
  updateRecording(recordingId, { liveEvents: JSON.stringify(events) })
}

/** Reports a problem to every window without changing recorder state. */
export function reportRecorderProblem(message: string): void {
  broadcast(RECORDER_CHANNELS.error, message)
}

/**
 * Stops any capture and waits for the file to be finished and imported.
 * Used by the quit path, which must not leave a half-written recording.
 */
export async function shutdownRecorder(timeoutMs = 30000): Promise<void> {
  if (!handle) return

  const finished = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!handle) {
        clearInterval(check)
        resolve()
      }
    }, 100)
  })

  await stopRecording('Closing LeagueVid')
  await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}
