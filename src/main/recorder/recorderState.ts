import type {
  RecorderPhase,
  RecorderProgress,
  RecorderStateSnapshot
} from '../../shared/types'

export type { RecorderPhase, RecorderStateSnapshot }

// The recorder's state machine, as a pure reducer.
//
// Every transition lives here and nowhere else, so the lifecycle can be
// verified exhaustively -- including the transitions that must *not* happen --
// without spawning ffmpeg, starting a game, or waiting on a timer. The service
// that owns the capture child reads this and performs side effects; it never
// decides what state comes next.
//
//   disabled --enable--------> idle
//   idle     --game-detected-> arming        (waiting for the game to be up)
//   arming   --capture-armed-> starting      (child spawned, no frames yet)
//   starting --frames-flowing-> recording    (frames actually observed)
//   recording --game-ended---> stopping      (after the configured stop delay)
//   stopping --child-exited--> remuxing --> finalizing --> idle
//   any active phase --failure--> failed --reset--> idle
//
// 'arming' and 'starting' are separate because the readiness gate has two
// independent conditions -- the game responding, and frames arriving -- and
// collapsing them would lose the ability to say which one is outstanding.

export type RecorderEvent =
  | { type: 'enable' }
  | { type: 'disable' }
  /** League is running and a game is in progress. */
  | { type: 'game-detected'; championName?: string | null }
  /** The game went away before capture got going. */
  | { type: 'game-vanished' }
  /** Capture child spawned. */
  | { type: 'capture-armed'; recordingId: number; outputPath: string; manual?: boolean }
  /** Enough consecutive frames observed to call this a real recording. */
  | { type: 'frames-flowing'; at: number }
  | { type: 'progress'; sample: RecorderProgress }
  /** The game ended and the stop delay has already elapsed. */
  | { type: 'game-ended' }
  | { type: 'stop-requested'; reason: string }
  | { type: 'child-exited'; code: number | null; forced: boolean }
  | { type: 'remux-finished'; ok: boolean; error?: string | null }
  | { type: 'finalized'; discarded: boolean }
  | { type: 'failure'; message: string }
  /** Acknowledges a failure and returns to idle. */
  | { type: 'reset' }

export function initialRecorderState(enabled: boolean): RecorderStateSnapshot {
  return {
    phase: enabled ? 'idle' : 'disabled',
    recordingId: null,
    startedAt: null,
    outputPath: null,
    progress: null,
    error: null,
    detail: enabled ? 'Waiting for a game' : 'Automatic recording is off',
    enabled
  }
}

/** Phases in which a capture child exists and footage is at stake. */
const ACTIVE_PHASES: RecorderPhase[] = ['starting', 'recording', 'stopping']

export function isActive(phase: RecorderPhase): boolean {
  return ACTIVE_PHASES.includes(phase)
}

/** Phases where a session is in flight, including post-capture processing. */
export function isBusy(phase: RecorderPhase): boolean {
  return isActive(phase) || phase === 'arming' || phase === 'remuxing' || phase === 'finalizing'
}

/**
 * Applies an event.
 *
 * Returns the *same object* when the event is not legal in the current phase.
 * Identity is the signal: a caller can tell a no-op from a change without
 * comparing fields, and an event arriving out of order -- a late progress
 * sample after a stop, a second game-detected while already recording -- is
 * ignored rather than corrupting the sequence.
 */
export function recorderReducer(
  state: RecorderStateSnapshot,
  event: RecorderEvent
): RecorderStateSnapshot {
  switch (event.type) {
    case 'enable':
      if (state.enabled && state.phase !== 'disabled') return state
      return {
        ...state,
        enabled: true,
        phase: state.phase === 'disabled' ? 'idle' : state.phase,
        detail: state.phase === 'disabled' ? 'Waiting for a game' : state.detail
      }

    case 'disable':
      // Turning recording off must never abandon a session mid-flight: the
      // switch takes effect, but a recording in progress still finishes and
      // gets saved. Only an inactive recorder goes straight to disabled.
      if (isBusy(state.phase)) {
        return { ...state, enabled: false, detail: 'Finishing the current recording' }
      }
      return { ...initialRecorderState(false) }

    case 'game-detected':
      if (state.phase !== 'idle') return state
      return {
        ...state,
        phase: 'arming',
        detail: event.championName
          ? `Game detected (${event.championName}), waiting for it to render`
          : 'Game detected, waiting for it to render'
      }

    case 'game-vanished':
      // Only meaningful before capture started. Once recording, the game
      // disappearing is a normal end and comes through as game-ended.
      if (state.phase !== 'arming') return state
      return { ...state, phase: 'idle', detail: 'The game ended before recording started' }

    case 'capture-armed':
      if (state.phase !== 'arming' && state.phase !== 'idle') return state
      return {
        ...state,
        phase: 'starting',
        recordingId: event.recordingId,
        outputPath: event.outputPath,
        progress: null,
        error: null,
        detail: event.manual ? 'Starting a manual recording' : 'Waiting for the first frames'
      }

    case 'frames-flowing':
      if (state.phase !== 'starting') return state
      return { ...state, phase: 'recording', startedAt: event.at, detail: 'Recording' }

    case 'progress':
      // Accepted while starting too: those samples are how readiness is
      // measured in the first place.
      if (state.phase !== 'recording' && state.phase !== 'starting') return state
      return { ...state, progress: event.sample }

    case 'game-ended':
      if (state.phase !== 'recording' && state.phase !== 'starting') return state
      return { ...state, phase: 'stopping', detail: 'Game over, finishing the recording' }

    case 'stop-requested':
      if (!isActive(state.phase)) return state
      if (state.phase === 'stopping') return state
      return { ...state, phase: 'stopping', detail: event.reason }

    case 'child-exited': {
      if (!isActive(state.phase)) return state

      // An exit while still starting or recording is one nobody asked for:
      // ffmpeg died, or the disk filled, or the GPU driver reset. That is a
      // failure and has to be reported as one -- but the footage captured up
      // to that point is still worth having, so the session continues through
      // remux and import and only *then* settles into failed. Processing the
      // file and reporting the failure are not in conflict.
      const unexpected = state.phase !== 'stopping'

      // Remuxing is attempted even after a forced kill or a non-zero exit:
      // Matroska survives truncation, so there is usually a playable file to
      // convert. The remux result decides whether it worked, not the exit code.
      return {
        ...state,
        phase: 'remuxing',
        error: unexpected
          ? `The recorder stopped unexpectedly (exit ${event.code ?? 'unknown'}). ` +
            'Whatever was captured is being saved.'
          : state.error,
        detail: unexpected
          ? 'Recording stopped unexpectedly, saving what was captured'
          : event.forced
            ? 'Recording stopped forcibly, converting what was captured'
            : 'Converting the recording'
      }
    }

    case 'remux-finished':
      if (state.phase !== 'remuxing') return state
      return {
        ...state,
        phase: 'finalizing',
        detail: event.ok ? 'Adding to your library' : 'Converting failed, keeping the original'
      }

    case 'finalized': {
      if (state.phase !== 'finalizing') return state

      // A session that hit an unexpected exit has had its footage saved by
      // now, but it still ended badly and the user should be told. Settling
      // into idle here would hide it.
      if (state.error) {
        return { ...state, phase: 'failed', detail: 'Recording failed, partial footage saved' }
      }

      const next = initialRecorderState(state.enabled)
      return {
        ...next,
        detail: event.discarded ? 'Recording discarded -- too short to keep' : next.detail
      }
    }

    case 'failure':
      if (state.phase === 'disabled' || state.phase === 'failed') return state
      return { ...state, phase: 'failed', error: event.message, detail: 'Recording failed' }

    case 'reset':
      if (state.phase !== 'failed') return state
      return { ...initialRecorderState(state.enabled) }

    default:
      return state
  }
}

/** Short label for the tray tooltip and the header indicator. */
export function describePhase(state: RecorderStateSnapshot): string {
  switch (state.phase) {
    case 'disabled':
      return 'Recording off'
    case 'idle':
      return 'Ready'
    case 'arming':
      return 'Game detected'
    case 'starting':
      return 'Starting'
    case 'recording':
      return 'Recording'
    case 'stopping':
      return 'Finishing'
    case 'remuxing':
      return 'Converting'
    case 'finalizing':
      return 'Saving'
    case 'failed':
      return 'Recording failed'
    default:
      return 'Unknown'
  }
}
