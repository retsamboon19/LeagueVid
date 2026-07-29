import {
  medianGameStart,
  pollAllGameData,
  type GameSnapshot,
  type LiveEvent,
  type PollResult
} from './liveClientData'

// Turns a stream of poll results into game lifecycle events.
//
// The rule that matters most here: a single failed poll is not a finished game.
// Alt-tabbing, a frame hitch, a busy disk or the endpoint being briefly
// unresponsive can all drop one request, and treating that as game-over would
// cut a recording in half mid-teamfight. Three consecutive failures are
// required before the game is declared over.
//
// All the decision-making is in handlePollResult, which is a pure-ish method
// over injected time -- so the debounce, the anchoring and the event ordering
// are tested without waiting on real intervals.

/** Consecutive failures before a game is considered over. */
export const FAILURES_BEFORE_GAME_OVER = 3

/** Poll cadence while waiting for a game to start. */
export const IDLE_POLL_MS = 2000

/**
 * Poll cadence while recording. Slower on purpose: the recording is already
 * running, nothing is waiting on these samples except the game-start estimate
 * and the event feed, and polling less often leaves more headroom for capture.
 */
export const ACTIVE_POLL_MS = 5000

/** How many samples the game-start estimate is drawn from. */
export const ANCHOR_SAMPLE_TARGET = 12

export type GameWatcherEvent =
  /** The endpoint answered and no game was previously known. */
  | { type: 'game-detected'; snapshot: GameSnapshot }
  /** Enough samples gathered to anchor the game clock to wall time. */
  | { type: 'gameplay-started'; gameStartMs: number; snapshot: GameSnapshot }
  /** The endpoint stopped answering for long enough to mean the game ended. */
  | { type: 'game-ended'; lastSnapshot: GameSnapshot | null; events: LiveEvent[] }
  /**
   * The endpoint answered again after failures, but the clock went backwards --
   * a different game. Distinct from game-ended so the recorder can close one
   * session and open another rather than silently splicing two games together.
   */
  | { type: 'game-replaced'; snapshot: GameSnapshot }

export interface GameWatcherOptions {
  onEvent: (event: GameWatcherEvent) => void
  /** Injectable for tests. */
  poll?: () => Promise<PollResult>
  now?: () => number
}

export class GameWatcher {
  private readonly onEvent: (event: GameWatcherEvent) => void
  private readonly poll: () => Promise<PollResult>

  private timer: NodeJS.Timeout | null = null
  private stopped = true

  /** Samples kept for the median game-start estimate. */
  private anchorSamples: GameSnapshot[] = []
  private consecutiveFailures = 0
  private inGame = false
  private announcedGameplay = false
  private lastSnapshot: GameSnapshot | null = null
  /** Union of every event seen this game, deduplicated by EventID. */
  private events = new Map<number, LiveEvent>()
  /** True while a recording is running, which slows the poll cadence. */
  private recording = false

  constructor(options: GameWatcherOptions) {
    this.onEvent = options.onEvent
    this.poll = options.poll ?? (() => pollAllGameData())
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleNext(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Told by the recorder, so polling can back off while capturing. */
  setRecording(recording: boolean): void {
    this.recording = recording
  }

  get pollIntervalMs(): number {
    return this.recording ? ACTIVE_POLL_MS : IDLE_POLL_MS
  }

  /** Best game-start estimate so far, or null before any sample. */
  get gameStartMs(): number | null {
    return medianGameStart(this.anchorSamples)
  }

  get collectedEvents(): LiveEvent[] {
    return [...this.events.values()].sort((a, b) => a.EventTime - b.EventTime)
  }

  get isInGame(): boolean {
    return this.inGame
  }

  /**
   * Applies one poll result. Public so tests can drive the watcher directly
   * rather than through timers.
   */
  handlePollResult(result: PollResult): void {
    if (result.ok && result.snapshot) {
      this.handleSuccess(result.snapshot)
      return
    }
    this.handleFailure()
  }

  private handleSuccess(snapshot: GameSnapshot): void {
    this.consecutiveFailures = 0

    // The clock running backwards means this is a different game -- the
    // previous one ended during a gap in polling and a new one has begun.
    // Reported separately so two games never end up spliced into one session.
    if (this.inGame && this.lastSnapshot && snapshot.gameTime + 30 < this.lastSnapshot.gameTime) {
      this.resetGameState()
      this.inGame = true
      this.lastSnapshot = snapshot
      this.anchorSamples.push(snapshot)
      this.onEvent({ type: 'game-replaced', snapshot })
      return
    }

    if (!this.inGame) {
      this.inGame = true
      this.resetGameState()
      this.inGame = true
      this.onEvent({ type: 'game-detected', snapshot })
    }

    this.lastSnapshot = snapshot
    for (const event of snapshot.events) {
      this.events.set(event.EventID, event)
    }

    // Anchor samples are capped: once there are enough, more only add noise and
    // memory. Early samples are the ones worth keeping anyway, since they're
    // closest to the moment being estimated.
    if (this.anchorSamples.length < ANCHOR_SAMPLE_TARGET) {
      this.anchorSamples.push(snapshot)
    }

    // Announced once a few samples agree, which is the point at which the
    // estimate is stable enough to start a recording against.
    if (!this.announcedGameplay && this.anchorSamples.length >= 3) {
      const gameStartMs = medianGameStart(this.anchorSamples)
      if (gameStartMs != null) {
        this.announcedGameplay = true
        this.onEvent({ type: 'gameplay-started', gameStartMs, snapshot })
      }
    }
  }

  private handleFailure(): void {
    if (!this.inGame) return

    this.consecutiveFailures += 1
    // The debounce. Anything less and a momentary hitch ends the recording.
    if (this.consecutiveFailures < FAILURES_BEFORE_GAME_OVER) return

    const lastSnapshot = this.lastSnapshot
    const events = this.collectedEvents
    this.resetGameState()
    this.onEvent({ type: 'game-ended', lastSnapshot, events })
  }

  private resetGameState(): void {
    this.inGame = false
    this.announcedGameplay = false
    this.consecutiveFailures = 0
    this.anchorSamples = []
    this.lastSnapshot = null
    this.events = new Map()
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      this.handlePollResult(await this.poll())
    } catch {
      // pollAllGameData never rejects, but an injected poll might; treat it as
      // a failed poll rather than letting the loop die.
      this.handlePollResult({ ok: false, snapshot: null, reason: 'poll threw' })
    }
    this.scheduleNext(this.pollIntervalMs)
  }
}
