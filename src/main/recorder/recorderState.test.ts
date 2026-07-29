import { describe, expect, it } from 'vitest'
import type { RecorderProgress } from '../../shared/types'
import {
  describePhase,
  initialRecorderState,
  isActive,
  isBusy,
  recorderReducer,
  type RecorderEvent,
  type RecorderPhase,
  type RecorderStateSnapshot
} from './recorderState'

const SAMPLE: RecorderProgress = {
  frame: 600,
  fps: 60,
  totalSizeBytes: 1024,
  outTimeMs: 10000,
  dropFrames: 0,
  dupFrames: 0,
  speed: 1,
  ended: false
}

/** Drives the reducer through a sequence and returns the final state. */
function run(start: RecorderStateSnapshot, events: RecorderEvent[]): RecorderStateSnapshot {
  return events.reduce(recorderReducer, start)
}

/** A state parked in the given phase, reached legally. */
function stateIn(phase: RecorderPhase): RecorderStateSnapshot {
  const enabled = initialRecorderState(true)
  switch (phase) {
    case 'disabled':
      return initialRecorderState(false)
    case 'idle':
      return enabled
    case 'arming':
      return run(enabled, [{ type: 'game-detected' }])
    case 'starting':
      return run(enabled, [
        { type: 'game-detected' },
        { type: 'capture-armed', recordingId: 1, outputPath: 'a.mkv' }
      ])
    case 'recording':
      return run(stateIn('starting'), [{ type: 'frames-flowing', at: 1000 }])
    case 'stopping':
      return run(stateIn('recording'), [{ type: 'game-ended' }])
    case 'remuxing':
      return run(stateIn('stopping'), [{ type: 'child-exited', code: 0, forced: false }])
    case 'finalizing':
      return run(stateIn('remuxing'), [{ type: 'remux-finished', ok: true }])
    case 'failed':
      return run(stateIn('recording'), [{ type: 'failure', message: 'boom' }])
    default:
      return enabled
  }
}

const ALL_PHASES: RecorderPhase[] = [
  'disabled',
  'idle',
  'arming',
  'starting',
  'recording',
  'stopping',
  'remuxing',
  'finalizing',
  'failed'
]

describe('initialRecorderState', () => {
  it('starts disabled when recording is off', () => {
    const state = initialRecorderState(false)
    expect(state.phase).toBe('disabled')
    expect(state.enabled).toBe(false)
  })

  it('starts idle when recording is on', () => {
    const state = initialRecorderState(true)
    expect(state.phase).toBe('idle')
    expect(state.detail).toBe('Waiting for a game')
  })
})

describe('the happy path', () => {
  it('runs game detection through to a saved recording and back to idle', () => {
    const phases: RecorderPhase[] = []
    let state = initialRecorderState(true)
    const record = (event: RecorderEvent): void => {
      state = recorderReducer(state, event)
      phases.push(state.phase)
    }

    record({ type: 'game-detected', championName: 'Yorick' })
    record({ type: 'capture-armed', recordingId: 7, outputPath: 'session.mkv' })
    record({ type: 'frames-flowing', at: 1_700_000_000_000 })
    record({ type: 'progress', sample: SAMPLE })
    record({ type: 'game-ended' })
    record({ type: 'child-exited', code: 0, forced: false })
    record({ type: 'remux-finished', ok: true })
    record({ type: 'finalized', discarded: false })

    expect(phases).toEqual([
      'arming',
      'starting',
      'recording',
      'recording',
      'stopping',
      'remuxing',
      'finalizing',
      'idle'
    ])
    expect(state.recordingId).toBeNull()
    expect(state.error).toBeNull()
  })

  it('carries the session identity from arming to completion', () => {
    const state = run(initialRecorderState(true), [
      { type: 'game-detected' },
      { type: 'capture-armed', recordingId: 42, outputPath: 'H:\\rec\\a.mkv' },
      { type: 'frames-flowing', at: 5000 }
    ])
    expect(state.recordingId).toBe(42)
    expect(state.outputPath).toBe('H:\\rec\\a.mkv')
    expect(state.startedAt).toBe(5000)
  })

  it('mentions the champion once the game is detected', () => {
    const state = recorderReducer(initialRecorderState(true), {
      type: 'game-detected',
      championName: 'Yorick'
    })
    expect(state.detail).toContain('Yorick')
  })

  it('allows a manual start straight from idle, skipping arming', () => {
    const state = recorderReducer(initialRecorderState(true), {
      type: 'capture-armed',
      recordingId: 1,
      outputPath: 'a.mkv',
      manual: true
    })
    expect(state.phase).toBe('starting')
    expect(state.detail).toContain('manual')
  })
})

describe('readiness', () => {
  // Two separate gates: the game being up, and frames actually arriving. They
  // are distinct phases so the UI can say which one is outstanding -- and
  // because ddagrab can open a display and deliver nothing at all.
  it('does not reach recording until frames are observed', () => {
    const state = stateIn('starting')
    expect(state.phase).toBe('starting')
    expect(recorderReducer(state, { type: 'frames-flowing', at: 1 }).phase).toBe('recording')
  })

  it('accepts progress samples while still starting', () => {
    const state = recorderReducer(stateIn('starting'), { type: 'progress', sample: SAMPLE })
    expect(state.phase).toBe('starting')
    expect(state.progress?.frame).toBe(600)
  })

  it('returns to idle when the game vanishes before capture starts', () => {
    const state = recorderReducer(stateIn('arming'), { type: 'game-vanished' })
    expect(state.phase).toBe('idle')
    expect(state.detail).toContain('ended before recording started')
  })

  // A game that ends during startup still has to stop the child cleanly, or
  // the process leaks and the file is never finalized.
  it('stops cleanly when the game ends during startup', () => {
    expect(recorderReducer(stateIn('starting'), { type: 'game-ended' }).phase).toBe('stopping')
  })
})

describe('stopping and failure', () => {
  it('remuxes even after a forced kill', () => {
    const state = recorderReducer(stateIn('stopping'), {
      type: 'child-exited',
      code: 137,
      forced: true
    })
    expect(state.phase).toBe('remuxing')
    expect(state.detail).toContain('forcibly')
  })

  // Matroska survives truncation, so a non-zero exit usually still leaves a
  // playable file. The remux result decides whether it worked, not the code.
  it('remuxes after a non-zero exit rather than giving up', () => {
    expect(
      recorderReducer(stateIn('stopping'), { type: 'child-exited', code: 1, forced: false }).phase
    ).toBe('remuxing')
  })

  it('still finalizes when the remux failed', () => {
    const state = recorderReducer(stateIn('remuxing'), {
      type: 'remux-finished',
      ok: false,
      error: 'no moov'
    })
    expect(state.phase).toBe('finalizing')
    expect(state.detail).toContain('keeping the original')
  })

  it('reports a discarded short recording', () => {
    const state = recorderReducer(stateIn('finalizing'), { type: 'finalized', discarded: true })
    expect(state.phase).toBe('idle')
    expect(state.detail).toContain('too short')
  })

  // An exit nobody asked for is a failure, but the frames already captured are
  // still worth keeping. So the session runs through remux and import and only
  // then settles into failed -- saving the footage and reporting the fault are
  // not in conflict.
  it('saves the footage first, then ends failed, when the child dies mid-recording', () => {
    const phases: RecorderPhase[] = []
    let state = stateIn('recording')
    for (const event of [
      { type: 'child-exited', code: 1, forced: false },
      { type: 'remux-finished', ok: true },
      { type: 'finalized', discarded: false }
    ] as RecorderEvent[]) {
      state = recorderReducer(state, event)
      phases.push(state.phase)
    }

    expect(phases).toEqual(['remuxing', 'finalizing', 'failed'])
    expect(state.error).toContain('stopped unexpectedly')
    expect(state.detail).toContain('partial footage saved')
  })

  it('ends idle, not failed, after an expected stop', () => {
    const state = run(stateIn('recording'), [
      { type: 'game-ended' },
      { type: 'child-exited', code: 0, forced: false },
      { type: 'remux-finished', ok: true },
      { type: 'finalized', discarded: false }
    ])
    expect(state.phase).toBe('idle')
    expect(state.error).toBeNull()
  })

  it('moves to failed from any active phase and keeps the message', () => {
    for (const phase of ['starting', 'recording', 'stopping'] as RecorderPhase[]) {
      const state = recorderReducer(stateIn(phase), { type: 'failure', message: 'disk full' })
      expect(state.phase, phase).toBe('failed')
      expect(state.error, phase).toBe('disk full')
    }
  })

  it('recovers from failed back to idle without a restart', () => {
    const state = recorderReducer(stateIn('failed'), { type: 'reset' })
    expect(state.phase).toBe('idle')
    expect(state.error).toBeNull()
  })

  it('does not overwrite the first failure with a second', () => {
    const first = recorderReducer(stateIn('recording'), { type: 'failure', message: 'first' })
    const second = recorderReducer(first, { type: 'failure', message: 'second' })
    expect(second).toBe(first)
    expect(second.error).toBe('first')
  })
})

describe('enabling and disabling', () => {
  it('enables from disabled', () => {
    const state = recorderReducer(initialRecorderState(false), { type: 'enable' })
    expect(state.phase).toBe('idle')
    expect(state.enabled).toBe(true)
  })

  it('disables an idle recorder outright', () => {
    const state = recorderReducer(initialRecorderState(true), { type: 'disable' })
    expect(state.phase).toBe('disabled')
    expect(state.enabled).toBe(false)
  })

  // Switching recording off must not abandon footage that is already being
  // captured. The setting takes effect; the session in flight still completes.
  it('lets a recording in flight finish when disabled mid-session', () => {
    const state = recorderReducer(stateIn('recording'), { type: 'disable' })
    expect(state.phase).toBe('recording')
    expect(state.enabled).toBe(false)
    expect(state.detail).toContain('Finishing')

    const after = run(state, [
      { type: 'game-ended' },
      { type: 'child-exited', code: 0, forced: false },
      { type: 'remux-finished', ok: true },
      { type: 'finalized', discarded: false }
    ])
    // And once it has finished, the recorder honours the setting.
    expect(after.phase).toBe('disabled')
  })

  it('does not start a new session while disabled', () => {
    const disabled = initialRecorderState(false)
    expect(recorderReducer(disabled, { type: 'game-detected' })).toBe(disabled)
  })
})

describe('illegal transitions', () => {
  // The identity check is the contract: an event that isn't legal returns the
  // very same object, so a caller can distinguish a no-op from a change
  // without comparing fields.
  const eventsByType: RecorderEvent[] = [
    { type: 'game-detected' },
    { type: 'game-vanished' },
    { type: 'capture-armed', recordingId: 1, outputPath: 'a.mkv' },
    { type: 'frames-flowing', at: 1 },
    { type: 'progress', sample: SAMPLE },
    { type: 'game-ended' },
    { type: 'stop-requested', reason: 'user' },
    { type: 'child-exited', code: 0, forced: false },
    { type: 'remux-finished', ok: true },
    { type: 'finalized', discarded: false },
    { type: 'reset' }
  ]

  /** Which of the above events each phase is allowed to act on. */
  const legal: Record<RecorderPhase, string[]> = {
    disabled: [],
    idle: ['game-detected', 'capture-armed'],
    arming: ['game-vanished', 'capture-armed'],
    starting: ['frames-flowing', 'progress', 'game-ended', 'stop-requested', 'child-exited'],
    recording: ['progress', 'game-ended', 'stop-requested', 'child-exited'],
    stopping: ['child-exited'],
    remuxing: ['remux-finished'],
    finalizing: ['finalized'],
    failed: ['reset']
  }

  for (const phase of ALL_PHASES) {
    for (const event of eventsByType) {
      const allowed = legal[phase].includes(event.type)
      it(`${phase} ${allowed ? 'accepts' : 'ignores'} ${event.type}`, () => {
        const before = stateIn(phase)
        const after = recorderReducer(before, event)
        if (allowed) {
          expect(after).not.toBe(before)
        } else {
          expect(after).toBe(before)
        }
      })
    }
  }

  it('ignores a late progress sample arriving after the stop', () => {
    const stopping = stateIn('stopping')
    expect(recorderReducer(stopping, { type: 'progress', sample: SAMPLE })).toBe(stopping)
  })

  it('ignores a second game-detected while already recording', () => {
    const recording = stateIn('recording')
    expect(recorderReducer(recording, { type: 'game-detected' })).toBe(recording)
  })

  it('ignores a duplicate stop request', () => {
    const stopping = recorderReducer(stateIn('recording'), {
      type: 'stop-requested',
      reason: 'user'
    })
    expect(recorderReducer(stopping, { type: 'stop-requested', reason: 'user again' })).toBe(
      stopping
    )
  })
})

describe('phase predicates', () => {
  it('treats only the phases holding a capture child as active', () => {
    expect(ALL_PHASES.filter(isActive)).toEqual(['starting', 'recording', 'stopping'])
  })

  it('treats post-capture processing as busy but not active', () => {
    expect(ALL_PHASES.filter(isBusy)).toEqual([
      'arming',
      'starting',
      'recording',
      'stopping',
      'remuxing',
      'finalizing'
    ])
  })
})

describe('describePhase', () => {
  it('has a label for every phase', () => {
    for (const phase of ALL_PHASES) {
      const label = describePhase({ ...initialRecorderState(true), phase })
      expect(label, phase).not.toBe('Unknown')
      expect(label.length, phase).toBeGreaterThan(0)
    }
  })
})
