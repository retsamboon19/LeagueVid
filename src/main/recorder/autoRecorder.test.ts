import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/types'
import type { GameWatcherEvent } from '../league/gameWatcher'
import type { GameSnapshot } from '../league/liveClientData'
import { AutoRecorder, FRAMES_TIMEOUT_MS, type AutoRecorderDeps } from './autoRecorder'
import type { CaptureTarget } from './ffmpegArgs'

const TARGET: CaptureTarget = { outputIdx: 0, width: 2560, height: 1440, isHdr: false }

function snapshot(championName: string | null = 'Yorick'): GameSnapshot {
  return {
    gameTime: 30,
    gameMode: 'CLASSIC',
    mapNumber: 11,
    championName,
    activePlayerName: 'Yorickenjoyer#EUW',
    events: [],
    sampledAt: 1_030_000
  }
}

/**
 * Harness with every dependency stubbed and timers under test control, so a
 * whole game can be played out in a few microseconds.
 */
function harness(settingsOverrides: Partial<RecordingSettings> = {}) {
  const settings: RecordingSettings = {
    ...DEFAULT_RECORDING_SETTINGS,
    enabled: true,
    ...settingsOverrides
  }

  const timers: Array<{ id: number; fn: () => void; ms: number; cancelled: boolean }> = []
  let nextTimerId = 1

  let capturing = false
  let framesFlowing = false

  const deps: AutoRecorderDeps = {
    getSettings: () => settings,
    resolveTarget: vi.fn(() => TARGET),
    checkDisk: vi.fn(() => ({ ok: true, reason: null })),
    fetchMatchHint: vi.fn(async () => ({ matchId: 'EUW1_123', queueId: 420 })),
    startRecording: vi.fn(async () => {
      capturing = true
    }),
    stopForGameEnd: vi.fn(async () => {
      capturing = false
    }),
    stopWithReason: vi.fn(async () => {
      capturing = false
    }),
    isCapturing: () => capturing,
    isProducingFrames: () => framesFlowing,
    persistLiveEvents: vi.fn(),
    setWatcherRecording: vi.fn(),
    reportProblem: vi.fn(),
    setTimer: (fn, ms) => {
      const id = nextTimerId++
      timers.push({ id, fn, ms, cancelled: false })
      return id as unknown as NodeJS.Timeout
    },
    clearTimer: (timer) => {
      const entry = timers.find((t) => t.id === (timer as unknown as number))
      if (entry) entry.cancelled = true
    }
  }

  const recorder = new AutoRecorder(deps)

  return {
    recorder,
    deps,
    settings,
    /** Runs the first pending timer scheduled for the given duration. */
    fireTimer(ms: number): boolean {
      const entry = timers.find((t) => t.ms === ms && !t.cancelled)
      if (!entry) return false
      entry.cancelled = true
      entry.fn()
      return true
    },
    pendingTimers: (): number[] => timers.filter((t) => !t.cancelled).map((t) => t.ms),
    setFramesFlowing(value: boolean): void {
      framesFlowing = value
    },
    setCapturing(value: boolean): void {
      capturing = value
    }
  }
}

const gameplayStarted: GameWatcherEvent = {
  type: 'gameplay-started',
  gameStartMs: 1_000_000,
  snapshot: snapshot()
}

/**
 * Deliberately different from FRAMES_TIMEOUT_MS so a test firing "the 20s
 * timer" can't hit the readiness timeout by accident.
 */
const STOP_DELAY_MS = 15_000

/** Lets pending promise callbacks run before asserting on timers. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('starting a recording', () => {
  // The endpoint answering is only half the gate. Recording waits for enough
  // samples to agree on where the game clock began, which is what
  // gameplay-started means.
  it('does not start on game-detected alone', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent({ type: 'game-detected', snapshot: snapshot() })
    expect(h.deps.startRecording).not.toHaveBeenCalled()
  })

  it('starts once gameplay is confirmed', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)

    expect(h.deps.startRecording).toHaveBeenCalledOnce()
    expect(h.deps.startRecording).toHaveBeenCalledWith({
      championName: 'Yorick',
      matchIdHint: 'EUW1_123',
      queueId: 420,
      gameStartMs: 1_000_000,
      target: TARGET
    })
  })

  it('tells the watcher to slow its polling once recording', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    expect(h.deps.setWatcherRecording).toHaveBeenCalledWith(true)
  })

  it('does nothing when recording is switched off', async () => {
    const h = harness({ enabled: false })
    await h.recorder.handleWatcherEvent(gameplayStarted)
    expect(h.deps.startRecording).not.toHaveBeenCalled()
  })

  it('does not start a second session while one is running', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    await h.recorder.handleWatcherEvent(gameplayStarted)
    expect(h.deps.startRecording).toHaveBeenCalledOnce()
  })

  // The hint is nice to have, never required. Waiting on the League client, or
  // refusing to record without it, would cost the opening of the game.
  it('records anyway when the match hint is unavailable', async () => {
    const h = harness()
    h.deps.fetchMatchHint = vi.fn(async () => ({ matchId: null, queueId: null }))
    await h.recorder.handleWatcherEvent(gameplayStarted)

    expect(h.deps.startRecording).toHaveBeenCalledOnce()
    expect(vi.mocked(h.deps.startRecording).mock.calls[0][0].matchIdHint).toBeNull()
  })

  it('records anyway when the match hint lookup throws', async () => {
    const h = harness()
    h.deps.fetchMatchHint = vi.fn(async () => {
      throw new Error('lockfile gone')
    })
    await h.recorder.handleWatcherEvent(gameplayStarted)
    expect(h.deps.startRecording).toHaveBeenCalledOnce()
  })

  it('refuses to start with no display and says so', async () => {
    const h = harness()
    h.deps.resolveTarget = vi.fn(() => null)
    await h.recorder.handleWatcherEvent(gameplayStarted)

    expect(h.deps.startRecording).not.toHaveBeenCalled()
    expect(h.deps.reportProblem).toHaveBeenCalledWith('No display was available to record.')
  })

  it('refuses to start without disk space and passes the reason on', async () => {
    const h = harness()
    h.deps.checkDisk = vi.fn(() => ({ ok: false, reason: 'Only 1.2 GB free' }))
    await h.recorder.handleWatcherEvent(gameplayStarted)

    expect(h.deps.startRecording).not.toHaveBeenCalled()
    expect(h.deps.reportProblem).toHaveBeenCalledWith('Only 1.2 GB free')
  })
})

describe('the frames readiness timeout', () => {
  // Not a theoretical safeguard: on the development machine ddagrab opened the
  // display at the right resolution and then delivered no frames at all, while
  // gdigrab captured normally. Without this the recorder sits in 'starting'
  // forever, claiming to record something it never captures.
  it('abandons a capture that never produces frames', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    h.setFramesFlowing(false)

    expect(h.fireTimer(FRAMES_TIMEOUT_MS)).toBe(true)

    expect(h.deps.stopWithReason).toHaveBeenCalledWith('No video frames were captured')
    expect(vi.mocked(h.deps.reportProblem).mock.calls.join(' ')).toContain('produced no frames')
  })

  it('says what usually causes it', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    h.fireTimer(FRAMES_TIMEOUT_MS)

    const message = vi.mocked(h.deps.reportProblem).mock.calls.join(' ')
    expect(message).toContain('asleep or inactive')
  })

  it('leaves a healthy capture alone', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    h.setFramesFlowing(true)

    h.fireTimer(FRAMES_TIMEOUT_MS)

    expect(h.deps.stopWithReason).not.toHaveBeenCalled()
    expect(h.deps.reportProblem).not.toHaveBeenCalled()
  })

  it('cancels the timeout once frames arrive', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    h.recorder.notifyFramesFlowing()

    expect(h.pendingTimers()).not.toContain(FRAMES_TIMEOUT_MS)
  })

  it('does nothing if the capture already ended', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    h.setCapturing(false)

    h.fireTimer(FRAMES_TIMEOUT_MS)
    expect(h.deps.stopWithReason).not.toHaveBeenCalled()
  })
})

describe('stopping when the game ends', () => {
  // The delay is what keeps the post-game scoreboard and damage graphs in the
  // recording instead of cutting the instant the game stops answering.
  it('waits out the stop delay before stopping', async () => {
    const h = harness({ stopDelayMs: STOP_DELAY_MS })
    await h.recorder.handleWatcherEvent(gameplayStarted)

    await h.recorder.handleWatcherEvent({ type: 'game-ended', lastSnapshot: null, events: [] })
    expect(h.deps.stopForGameEnd).not.toHaveBeenCalled()

    h.fireTimer(STOP_DELAY_MS)
    expect(h.deps.stopForGameEnd).toHaveBeenCalledOnce()
  })

  it('stops immediately when no delay is configured', async () => {
    const h = harness({ stopDelayMs: 0 })
    await h.recorder.handleWatcherEvent(gameplayStarted)
    await h.recorder.handleWatcherEvent({ type: 'game-ended', lastSnapshot: null, events: [] })

    expect(h.deps.stopForGameEnd).toHaveBeenCalledOnce()
  })

  it('keeps the in-game event feed before stopping', async () => {
    const h = harness()
    const events = [{ EventID: 1, EventName: 'ChampionKill', EventTime: 120 }]
    await h.recorder.handleWatcherEvent(gameplayStarted)
    await h.recorder.handleWatcherEvent({ type: 'game-ended', lastSnapshot: null, events })

    expect(h.deps.persistLiveEvents).toHaveBeenCalledWith(events)
  })

  it('ignores a game ending when nothing is being recorded', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent({ type: 'game-ended', lastSnapshot: null, events: [] })
    expect(h.deps.stopForGameEnd).not.toHaveBeenCalled()
  })

  it('lets the polling cadence return to idle after stopping', async () => {
    const h = harness({ stopDelayMs: 0 })
    await h.recorder.handleWatcherEvent(gameplayStarted)
    await h.recorder.handleWatcherEvent({ type: 'game-ended', lastSnapshot: null, events: [] })

    expect(h.deps.setWatcherRecording).toHaveBeenLastCalledWith(false)
  })
})

describe('a game that vanishes and is replaced mid-session', () => {
  // Polling can miss the end of one game and the start of the next -- a remake
  // and a fast requeue. The session in flight belongs to the previous game, so
  // it is closed first: splicing two games into one file would misplace every
  // bookmark in the second.
  it('closes the old session before starting the new one', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)

    const callOrder: string[] = []
    h.deps.stopWithReason = vi.fn(async (reason: string) => {
      callOrder.push(`stop:${reason}`)
      h.setCapturing(false)
    })
    h.deps.startRecording = vi.fn(async () => {
      callOrder.push('start')
      h.setCapturing(true)
    })

    await h.recorder.handleWatcherEvent({ type: 'game-replaced', snapshot: snapshot('Malphite') })

    expect(callOrder).toEqual(['stop:A new game started, so the previous recording was saved', 'start'])
  })

  it('records the new game with its own champion', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent({ type: 'game-replaced', snapshot: snapshot('Malphite') })
    expect(vi.mocked(h.deps.startRecording).mock.calls[0][0].championName).toBe('Malphite')
  })

  // A stop already scheduled belongs to the finished game. Left running, it
  // would fire into the middle of the new recording.
  it('cancels a pending stop when a new game starts', async () => {
    const h = harness({ stopDelayMs: STOP_DELAY_MS })
    await h.recorder.handleWatcherEvent(gameplayStarted)
    await h.recorder.handleWatcherEvent({ type: 'game-ended', lastSnapshot: null, events: [] })

    // The old game's stop is pending; a new game arrives first.
    h.setCapturing(false)
    await h.recorder.handleWatcherEvent(gameplayStarted)

    expect(h.fireTimer(STOP_DELAY_MS)).toBe(false)
    expect(h.deps.stopForGameEnd).not.toHaveBeenCalled()
  })
})

describe('running out of disk space mid-recording', () => {
  it('stops the recording and reports why', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)

    await h.recorder.stopForDiskSpace('Only 1.8 GB left')

    expect(h.deps.reportProblem).toHaveBeenCalledWith('Only 1.8 GB left')
    expect(h.deps.stopWithReason).toHaveBeenCalledWith('Ran out of disk space')
    expect(h.deps.setWatcherRecording).toHaveBeenLastCalledWith(false)
  })
})

describe('the manual start delay override', () => {
  it('is not used by default', async () => {
    const h = harness()
    await h.recorder.handleWatcherEvent(gameplayStarted)
    // Only the frames timeout should be pending.
    expect(h.pendingTimers()).toEqual([FRAMES_TIMEOUT_MS])
  })

  it('is honoured when the user sets one', async () => {
    const h = harness({ startDelayMs: 3000 })
    const started = h.recorder.handleWatcherEvent(gameplayStarted)

    // The match-hint lookup is awaited first, so let that settle before
    // asserting the start is genuinely waiting on the override.
    await flush()
    expect(h.deps.startRecording).not.toHaveBeenCalled()

    expect(h.fireTimer(3000)).toBe(true)
    await started

    expect(h.deps.startRecording).toHaveBeenCalledOnce()
  })
})
