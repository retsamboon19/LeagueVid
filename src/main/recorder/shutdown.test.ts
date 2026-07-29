import { describe, expect, it, vi } from 'vitest'
import { QUIT_TIMEOUT_MS, shutdownForQuit, type ShutdownStep } from './shutdown'

/**
 * Stand-in for the capture child and the post-capture work, so the ordering can
 * be checked without ffmpeg. Arranging a real quit-during-recording by hand
 * tells you whether it worked once, on one machine.
 */
function fakeSession() {
  let resolveStop: () => void
  let resolveCompletion: () => void

  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve
  })
  const completed = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  let capturing = true

  return {
    isCapturing: (): boolean => capturing,
    stopCapture: vi.fn(() => stopped),
    sessionCompletion: (): Promise<void> => completed,
    /** ffmpeg exited and the container was finalized. */
    finishStop(): void {
      capturing = false
      resolveStop()
    },
    /** Remux and library insert finished. */
    finishCompletion(): void {
      resolveCompletion()
    }
  }
}

/** Never resolves, so the timeout is the only way out. */
const never = (): Promise<void> => new Promise<void>(() => {})

describe('shutdownForQuit', () => {
  it('does nothing when no recording is in flight', async () => {
    const result = await shutdownForQuit({
      isCapturing: () => false,
      stopCapture: vi.fn(never),
      sessionCompletion: () => null
    })

    expect(result.clean).toBe(true)
    expect(result.steps).toEqual(['nothing-to-do'])
  })

  // The order is the requirement: stop the child so ffmpeg writes the container
  // index, then let the remux and library insert finish, then quit. Quitting
  // between the stop and the remux would leave a Matroska file with no library
  // row -- recoverable next launch, but only by accident of the recovery sweep.
  it('stops, finalizes, then reports clean', async () => {
    const session = fakeSession()
    const steps: ShutdownStep[] = []

    const shutdown = shutdownForQuit({
      isCapturing: session.isCapturing,
      stopCapture: session.stopCapture,
      sessionCompletion: session.sessionCompletion,
      onStep: (step) => steps.push(step)
    })

    // Nothing is finished yet, so the quit is still waiting.
    await Promise.resolve()
    expect(steps).toEqual(['stopping'])

    session.finishStop()
    await Promise.resolve()
    await Promise.resolve()

    session.finishCompletion()
    const result = await shutdown

    expect(result.clean).toBe(true)
    expect(result.steps).toEqual(['stopping', 'stopped', 'finalizing', 'finalized'])
  })

  it('asks the child to stop exactly once', async () => {
    const session = fakeSession()
    const shutdown = shutdownForQuit({
      isCapturing: session.isCapturing,
      stopCapture: session.stopCapture,
      sessionCompletion: session.sessionCompletion
    })

    session.finishStop()
    session.finishCompletion()
    await shutdown

    expect(session.stopCapture).toHaveBeenCalledOnce()
  })

  // A wedged ffmpeg child would otherwise make the app unquittable, and a user
  // who cannot close a program kills it -- which skips this path entirely and is
  // strictly worse than a bounded wait.
  it('gives up on a child that never exits', async () => {
    const result = await shutdownForQuit({
      isCapturing: () => true,
      stopCapture: never,
      sessionCompletion: () => never(),
      timeoutMs: 5,
      delay: (ms) => new Promise((r) => setTimeout(r, ms))
    })

    expect(result.clean).toBe(false)
    expect(result.steps).toEqual(['stopping', 'timed-out'])
  })

  it('gives up on a remux that never finishes, having already stopped', async () => {
    const session = fakeSession()
    const shutdown = shutdownForQuit({
      isCapturing: session.isCapturing,
      stopCapture: session.stopCapture,
      sessionCompletion: () => never(),
      timeoutMs: 20,
      delay: (ms) => new Promise((r) => setTimeout(r, ms))
    })

    session.finishStop()
    const result = await shutdown

    // The child did stop cleanly, so the footage is intact even though the
    // library insert didn't complete in time -- the launch sweep picks it up.
    expect(result.steps).toContain('stopped')
    expect(result.steps).toContain('timed-out')
    expect(result.clean).toBe(false)
  })

  it('completes without waiting when there is no post-capture work', async () => {
    const session = fakeSession()
    const shutdown = shutdownForQuit({
      isCapturing: session.isCapturing,
      stopCapture: session.stopCapture,
      sessionCompletion: () => null
    })

    session.finishStop()
    const result = await shutdown

    expect(result.clean).toBe(true)
    expect(result.steps).toEqual(['stopping', 'stopped'])
  })

  it('allows enough time for a long recording to finish converting', () => {
    // Remuxing is a stream copy, so tens of seconds is generous even for a
    // 40-minute 1440p session.
    expect(QUIT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })
})
