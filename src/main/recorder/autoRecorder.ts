import type { RecordingSettings } from '../../shared/types'
import type { GameWatcherEvent } from '../league/gameWatcher'
import type { CaptureTarget } from './ffmpegArgs'

// Decides when a recording starts and stops in response to game events.
//
// Kept separate from recorderService (which owns the child) and from
// GameWatcher (which owns the polling) so the decisions -- and only the
// decisions -- can be driven by scripted event sequences in a test, including
// the sequences that are awkward in real life: a game that vanishes mid-session,
// a remake, a disk that fills, a capture that produces no frames at all.
//
// The rule this module exists to enforce (R15.2): a recording is not declared
// started because time passed. It requires the game to be genuinely up -- which
// is what the Live Client endpoint answering means -- *and* frames actually
// arriving from the capture pipeline. Outplayed's own manifest asks for
// `wait_for_stable_framerate: 30` for the same reason; this is the equivalent
// without hooking the game.

/**
 * How long capture may sit in 'starting' without producing frames before the
 * attempt is abandoned.
 *
 * This is not a theoretical safeguard. On the development machine ddagrab
 * reported opening the display at the right resolution and then delivered zero
 * frames, while gdigrab captured normally -- Desktop Duplication only produces
 * output when the desktop is actually being composited. Without this timeout
 * the recorder would sit in 'starting' forever, reporting that it was about to
 * record something it was never going to capture.
 */
export const FRAMES_TIMEOUT_MS = 20_000

export interface AutoRecorderDeps {
  getSettings: () => RecordingSettings
  /** Resolves the display to capture; null when there is none. */
  resolveTarget: () => CaptureTarget | null
  /** Free-space gate. Returns a reason when there isn't room. */
  checkDisk: (target: CaptureTarget) => { ok: boolean; reason: string | null }
  /** Looks up the exact match id. Best-effort; may resolve to nulls. */
  fetchMatchHint: () => Promise<{ matchId: string | null; queueId: number | null }>
  startRecording: (options: {
    championName: string | null
    matchIdHint: string | null
    queueId: number | null
    gameStartMs: number | null
    target: CaptureTarget
  }) => Promise<void>
  stopForGameEnd: () => Promise<void>
  stopWithReason: (reason: string) => Promise<void>
  /** True while a capture child exists. */
  isCapturing: () => boolean
  /** True once frames have actually been observed. */
  isProducingFrames: () => boolean
  /**
   * Records the collected in-game event feed against the session.
   *
   * The active player's name goes with it: kill/death/assist attribution is
   * impossible without knowing who "you" were, and by the time the fallback
   * runs the game is long gone.
   */
  persistLiveEvents: (payload: { activePlayerName: string | null; events: unknown[] }) => void
  /** Told when to slow its polling down. */
  setWatcherRecording: (recording: boolean) => void
  reportProblem: (message: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (timer: NodeJS.Timeout) => void
}

export class AutoRecorder {
  private readonly deps: AutoRecorderDeps
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (timer: NodeJS.Timeout) => void

  /** Set while waiting out the configured delay after a game ends. */
  private stopDelayTimer: NodeJS.Timeout | null = null
  /** Set while waiting for the first frames to arrive. */
  private framesTimer: NodeJS.Timeout | null = null
  /** Guards against two starts racing on overlapping game events. */
  private starting = false

  constructor(deps: AutoRecorderDeps) {
    this.deps = deps
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  async handleWatcherEvent(event: GameWatcherEvent): Promise<void> {
    switch (event.type) {
      // Deliberately ignored as a start trigger. The endpoint answering is only
      // half the gate; the recording starts on gameplay-started, once enough
      // samples agree on where the game clock began.
      case 'game-detected':
        return

      case 'gameplay-started':
        await this.beginSession(event.gameStartMs, event.snapshot.championName)
        return

      case 'game-ended':
        this.deps.persistLiveEvents({
          activePlayerName: event.lastSnapshot?.activePlayerName ?? null,
          events: event.events
        })
        this.scheduleStop()
        return

      // A different game appeared during a gap in polling. The session in
      // flight belongs to the previous game, so it is closed before anything
      // else -- splicing two games into one recording would misplace every
      // bookmark in the second one.
      case 'game-replaced':
        if (this.deps.isCapturing()) {
          await this.deps.stopWithReason('A new game started, so the previous recording was saved')
        }
        await this.beginSession(null, event.snapshot.championName)
        return
    }
  }

  private async beginSession(
    gameStartMs: number | null,
    championName: string | null
  ): Promise<void> {
    const settings = this.deps.getSettings()
    if (!settings.enabled) return
    if (this.starting || this.deps.isCapturing()) return

    // A stop that was already scheduled belongs to a finished game; a new
    // session cancels it rather than letting it fire into this one.
    this.cancelStopDelay()

    const target = this.deps.resolveTarget()
    if (!target) {
      this.deps.reportProblem('No display was available to record.')
      return
    }

    const disk = this.deps.checkDisk(target)
    if (!disk.ok) {
      this.deps.reportProblem(disk.reason ?? 'Not enough disk space to record.')
      return
    }

    this.starting = true
    try {
      // The hint is nice to have, never required: with it, linking is a lookup;
      // without it, linking falls back to searching. Either way the recording
      // starts now rather than waiting on the League client.
      const hint = await this.deps.fetchMatchHint().catch(() => ({
        matchId: null,
        queueId: null
      }))

      // An optional manual override, not the start trigger. Zero by default.
      if (settings.startDelayMs > 0) {
        await new Promise((resolve) => this.setTimer(() => resolve(null), settings.startDelayMs))
      }

      await this.deps.startRecording({
        championName,
        matchIdHint: hint.matchId,
        queueId: hint.queueId,
        gameStartMs,
        target
      })

      this.deps.setWatcherRecording(true)
      this.watchForFrames()
    } finally {
      this.starting = false
    }
  }

  /**
   * Abandons a capture that never produced frames.
   *
   * See FRAMES_TIMEOUT_MS: a pipeline that starts, opens the display and
   * delivers nothing is a real observed failure, and reporting it beats sitting
   * in 'starting' indefinitely.
   */
  private watchForFrames(): void {
    this.framesTimer = this.setTimer(() => {
      this.framesTimer = null
      if (!this.deps.isCapturing()) return
      if (this.deps.isProducingFrames()) return

      void this.deps.stopWithReason('No video frames were captured')
      this.deps.reportProblem(
        'Recording stopped: the capture produced no frames. This usually means the ' +
          'selected monitor is asleep or inactive, or that another program has ' +
          'exclusive control of it.'
      )
    }, FRAMES_TIMEOUT_MS)
  }

  /**
   * Waits out the configured delay before stopping.
   *
   * The delay exists so the post-game screen -- final scoreboard, damage
   * graphs, the bit players actually want to look back at -- is captured
   * instead of being cut off the instant the game process stops answering.
   */
  private scheduleStop(): void {
    if (!this.deps.isCapturing()) return
    this.cancelStopDelay()

    const delay = this.deps.getSettings().stopDelayMs
    if (delay <= 0) {
      void this.finishSession()
      return
    }

    this.stopDelayTimer = this.setTimer(() => {
      this.stopDelayTimer = null
      void this.finishSession()
    }, delay)
  }

  private async finishSession(): Promise<void> {
    this.cancelFramesTimer()
    this.deps.setWatcherRecording(false)
    if (!this.deps.isCapturing()) return
    await this.deps.stopForGameEnd()
  }

  private cancelStopDelay(): void {
    if (this.stopDelayTimer) {
      this.clearTimer(this.stopDelayTimer)
      this.stopDelayTimer = null
    }
  }

  private cancelFramesTimer(): void {
    if (this.framesTimer) {
      this.clearTimer(this.framesTimer)
      this.framesTimer = null
    }
  }

  /** Frames arrived, so the readiness timeout is no longer needed. */
  notifyFramesFlowing(): void {
    this.cancelFramesTimer()
  }

  /** Called when the disk check during a recording says to stop. */
  async stopForDiskSpace(reason: string): Promise<void> {
    this.cancelStopDelay()
    this.cancelFramesTimer()
    this.deps.reportProblem(reason)
    if (this.deps.isCapturing()) await this.deps.stopWithReason('Ran out of disk space')
    this.deps.setWatcherRecording(false)
  }

  dispose(): void {
    this.cancelStopDelay()
    this.cancelFramesTimer()
  }
}
