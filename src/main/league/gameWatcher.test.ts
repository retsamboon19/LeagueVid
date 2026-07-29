import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_POLL_MS,
  FAILURES_BEFORE_GAME_OVER,
  GameWatcher,
  IDLE_POLL_MS,
  type GameWatcherEvent
} from './gameWatcher'
import type { GameSnapshot, LiveEvent, PollResult } from './liveClientData'

function snapshot(gameTime: number, sampledAt: number, events: LiveEvent[] = []): GameSnapshot {
  return {
    gameTime,
    gameMode: 'CLASSIC',
    mapNumber: 11,
    championName: 'Yorick',
    activePlayerName: 'Yorickenjoyer#EUW',
    events,
    sampledAt
  }
}

function ok(gameTime: number, sampledAt: number, events: LiveEvent[] = []): PollResult {
  return { ok: true, snapshot: snapshot(gameTime, sampledAt, events), reason: null }
}

const FAILED: PollResult = { ok: false, snapshot: null, reason: 'ECONNREFUSED' }

/** Watcher wired to a collecting listener, driven by hand. */
function watcher(): { watcher: GameWatcher; events: GameWatcherEvent[] } {
  const events: GameWatcherEvent[] = []
  return {
    watcher: new GameWatcher({ onEvent: (event) => events.push(event) }),
    events
  }
}

describe('game detection', () => {
  it('reports a game the first time the endpoint answers', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('game-detected')
    expect(w.isInGame).toBe(true)
  })

  it('does not report a second game while one is running', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))
    w.handlePollResult(ok(32, 1_032_000))
    w.handlePollResult(ok(34, 1_034_000))

    expect(events.filter((e) => e.type === 'game-detected')).toHaveLength(1)
  })

  it('says nothing at all while no game is running', () => {
    const { watcher: w, events } = watcher()
    for (let i = 0; i < 10; i++) w.handlePollResult(FAILED)

    expect(events).toEqual([])
    expect(w.isInGame).toBe(false)
  })

  // The estimate needs a few agreeing samples before a recording is started
  // against it, since it positions every bookmark.
  it('announces gameplay once enough samples agree', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))
    w.handlePollResult(ok(32, 1_032_000))
    expect(events.some((e) => e.type === 'gameplay-started')).toBe(false)

    w.handlePollResult(ok(34, 1_034_000))
    const started = events.find((e) => e.type === 'gameplay-started')
    expect(started).toBeDefined()
    expect(started?.type === 'gameplay-started' && started.gameStartMs).toBe(1_000_000)
  })

  it('announces gameplay only once', () => {
    const { watcher: w, events } = watcher()
    for (let i = 1; i <= 8; i++) w.handlePollResult(ok(i * 2, 1_000_000 + i * 2000))

    expect(events.filter((e) => e.type === 'gameplay-started')).toHaveLength(1)
  })

  it('stops collecting anchor samples once it has enough', () => {
    const { watcher: w } = watcher()
    for (let i = 1; i <= 40; i++) w.handlePollResult(ok(i * 2, 1_000_000 + i * 2000))

    // Still anchored to the true start rather than drifting with later samples.
    expect(w.gameStartMs).toBe(1_000_000)
  })
})

describe('the failure debounce', () => {
  // The single most important behaviour in this file. A frame hitch, an
  // alt-tab, or a busy disk can drop one poll; ending the recording there
  // would cut it in half mid-teamfight.
  it('survives one failed poll', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))
    w.handlePollResult(FAILED)

    expect(events.some((e) => e.type === 'game-ended')).toBe(false)
    expect(w.isInGame).toBe(true)
  })

  it('survives two failed polls', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))
    w.handlePollResult(FAILED)
    w.handlePollResult(FAILED)

    expect(events.some((e) => e.type === 'game-ended')).toBe(false)
    expect(w.isInGame).toBe(true)
  })

  it('ends the game on the third consecutive failure', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))
    for (let i = 0; i < FAILURES_BEFORE_GAME_OVER; i++) w.handlePollResult(FAILED)

    expect(events.filter((e) => e.type === 'game-ended')).toHaveLength(1)
    expect(w.isInGame).toBe(false)
  })

  it('resets the failure count when the endpoint answers again', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))
    w.handlePollResult(FAILED)
    w.handlePollResult(FAILED)
    w.handlePollResult(ok(36, 1_036_000))
    w.handlePollResult(FAILED)
    w.handlePollResult(FAILED)

    expect(events.some((e) => e.type === 'game-ended')).toBe(false)
    expect(w.isInGame).toBe(true)
  })

  it('reports the game as ended only once', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(30, 1_030_000))
    for (let i = 0; i < 10; i++) w.handlePollResult(FAILED)

    expect(events.filter((e) => e.type === 'game-ended')).toHaveLength(1)
  })

  it('hands the collected events out with the game-ended report', () => {
    const { watcher: w, events } = watcher()
    const kill: LiveEvent = {
      EventID: 1,
      EventName: 'ChampionKill',
      EventTime: 331.4,
      KillerName: 'Yorickenjoyer#EUW'
    }
    w.handlePollResult(ok(30, 1_030_000, [{ EventID: 0, EventName: 'GameStart', EventTime: 0.05 }]))
    w.handlePollResult(ok(332, 1_332_000, [
      { EventID: 0, EventName: 'GameStart', EventTime: 0.05 },
      kill
    ]))
    for (let i = 0; i < FAILURES_BEFORE_GAME_OVER; i++) w.handlePollResult(FAILED)

    const ended = events.find((e) => e.type === 'game-ended')
    expect(ended?.type === 'game-ended' && ended.events).toHaveLength(2)
    expect(ended?.type === 'game-ended' && ended.lastSnapshot?.gameTime).toBe(332)
  })
})

describe('the event feed', () => {
  // The endpoint returns the whole event list every poll, so naive collection
  // would multiply every kill by the number of polls.
  it('deduplicates events repeated across polls', () => {
    const { watcher: w } = watcher()
    const feed: LiveEvent[] = [
      { EventID: 0, EventName: 'GameStart', EventTime: 0.05 },
      { EventID: 1, EventName: 'ChampionKill', EventTime: 120 }
    ]
    w.handlePollResult(ok(120, 1_120_000, feed))
    w.handlePollResult(ok(125, 1_125_000, feed))
    w.handlePollResult(ok(130, 1_130_000, feed))

    expect(w.collectedEvents).toHaveLength(2)
  })

  it('returns events in game-time order regardless of arrival', () => {
    const { watcher: w } = watcher()
    w.handlePollResult(
      ok(300, 1_300_000, [
        { EventID: 2, EventName: 'ChampionKill', EventTime: 250 },
        { EventID: 1, EventName: 'FirstBrick', EventTime: 100 }
      ])
    )
    expect(w.collectedEvents.map((e) => e.EventTime)).toEqual([100, 250])
  })

  it('starts a fresh event list for a new game', () => {
    const { watcher: w } = watcher()
    w.handlePollResult(ok(300, 1_300_000, [{ EventID: 1, EventName: 'ChampionKill', EventTime: 250 }]))
    for (let i = 0; i < FAILURES_BEFORE_GAME_OVER; i++) w.handlePollResult(FAILED)
    w.handlePollResult(ok(10, 2_010_000))

    expect(w.collectedEvents).toEqual([])
  })
})

describe('a game replaced mid-gap', () => {
  // Polling can miss the end of one game and the start of the next -- a fast
  // remake and requeue, say. The clock going backwards is the giveaway, and it
  // has to be reported so two games never end up in one session.
  it('reports a replacement when the clock jumps backwards', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(1800, 2_800_000))
    w.handlePollResult(ok(12, 3_012_000))

    expect(events.map((e) => e.type)).toEqual(['game-detected', 'game-replaced'])
  })

  it('re-anchors to the new game', () => {
    const { watcher: w } = watcher()
    w.handlePollResult(ok(1800, 2_800_000))
    w.handlePollResult(ok(12, 3_012_000))

    expect(w.gameStartMs).toBe(3_000_000)
  })

  // A clock that ticks normally is not a replacement, and small non-monotonic
  // wobble must not be mistaken for one.
  it('does not mistake ordinary progress for a replacement', () => {
    const { watcher: w, events } = watcher()
    w.handlePollResult(ok(1800, 2_800_000))
    w.handlePollResult(ok(1802, 2_802_000))
    w.handlePollResult(ok(1801.5, 2_803_000))

    expect(events.filter((e) => e.type === 'game-replaced')).toHaveLength(0)
  })
})

describe('poll cadence', () => {
  it('polls faster while waiting than while recording', () => {
    const { watcher: w } = watcher()
    expect(w.pollIntervalMs).toBe(IDLE_POLL_MS)

    w.setRecording(true)
    expect(w.pollIntervalMs).toBe(ACTIVE_POLL_MS)
    expect(ACTIVE_POLL_MS).toBeGreaterThan(IDLE_POLL_MS)
  })
})

describe('the polling loop', () => {
  it('keeps running after a poll throws', async () => {
    let calls = 0
    const events: GameWatcherEvent[] = []
    const w = new GameWatcher({
      onEvent: (event) => events.push(event),
      poll: () => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('boom'))
        return Promise.resolve(ok(30, 1_030_000))
      }
    })

    w.start()
    await vi.waitFor(() => expect(events.some((e) => e.type === 'game-detected')).toBe(true), {
      timeout: 5000
    })
    w.stop()

    expect(calls).toBeGreaterThan(1)
  })

  it('stops polling when stopped', async () => {
    let calls = 0
    const w = new GameWatcher({
      onEvent: () => {},
      poll: () => {
        calls += 1
        return Promise.resolve(FAILED)
      }
    })

    w.start()
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 5000 })
    w.stop()
    const afterStop = calls

    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS + 200))
    expect(calls).toBe(afterStop)
  })
})
