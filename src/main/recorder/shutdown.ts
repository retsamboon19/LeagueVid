// The quit sequence for a recording in progress.
//
// Quitting while recording must not leave a half-written file behind. The order
// is stop, remux, import, then quit -- and 'stop' means asking ffmpeg to finish
// so the container gets its index, which takes as long as it takes.
//
// Extracted from the app lifecycle so the ordering can be tested against a
// stand-in child, which is the only practical way to verify it: arranging a real
// quit-during-recording by hand tells you whether it worked once, on one machine.

/** Upper bound on how long quitting may be delayed. */
export const QUIT_TIMEOUT_MS = 30_000

export interface ShutdownDeps {
  isCapturing: () => boolean
  /** Asks ffmpeg to finish; resolves once the child has exited. */
  stopCapture: () => Promise<void>
  /**
   * Resolves once the session has been remuxed and added to the library. Null
   * when there is nothing in flight.
   */
  sessionCompletion: () => Promise<void> | null
  timeoutMs?: number
  /** Records progress, for the log and for the test. */
  onStep?: (step: ShutdownStep) => void
  /** Injectable so tests don't wait real seconds. */
  delay?: (ms: number) => Promise<void>
}

export type ShutdownStep =
  | 'nothing-to-do'
  | 'stopping'
  | 'stopped'
  | 'finalizing'
  | 'finalized'
  | 'timed-out'

export interface ShutdownResult {
  /** False when the timeout was hit and the app quit anyway. */
  clean: boolean
  steps: ShutdownStep[]
}

/**
 * Stops and finalizes any recording, then reports whether it completed.
 *
 * The timeout is not a nicety. A wedged ffmpeg child would otherwise make the
 * application unquittable, and a user who cannot close a program will kill it --
 * which is strictly worse, because that skips this path altogether.
 */
export async function shutdownForQuit(deps: ShutdownDeps): Promise<ShutdownResult> {
  const steps: ShutdownStep[] = []
  const record = (step: ShutdownStep): void => {
    steps.push(step)
    deps.onStep?.(step)
  }

  if (!deps.isCapturing()) {
    record('nothing-to-do')
    return { clean: true, steps }
  }

  const timeoutMs = deps.timeoutMs ?? QUIT_TIMEOUT_MS
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  // The completion promise is captured before stopping. Reading it afterwards
  // would race: a fast session can finish, and clear it, before we look.
  const completion = deps.sessionCompletion()

  let timedOut = false
  const timeout = delay(timeoutMs).then(() => {
    timedOut = true
  })

  record('stopping')
  await Promise.race([deps.stopCapture(), timeout])
  if (timedOut) {
    record('timed-out')
    return { clean: false, steps }
  }
  record('stopped')

  if (completion) {
    record('finalizing')
    await Promise.race([completion, timeout])
    if (timedOut) {
      record('timed-out')
      return { clean: false, steps }
    }
    record('finalized')
  }

  return { clean: true, steps }
}
