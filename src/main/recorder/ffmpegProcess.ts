import { spawn } from 'child_process'
import type { RecorderProgress } from '../../shared/types'
import { parseProgressChunk } from './progressParser'

// Supervises the long-lived capture child.
//
// The one rule that matters: ffmpeg is asked to stop, never signalled. It
// finalizes the container when it exits its own main loop after reading 'q' on
// stdin; killed with a signal it just dies, leaving Matroska without its cues
// and MP4 without a moov atom. A forced kill remains as the last resort after
// a grace period, because a wedged child must not be able to block a quit.

/** How long a graceful stop is given before the child is killed. */
export const STOP_GRACE_MS = 15000

/** Renderer updates are throttled to this, independent of ffmpeg's rate. */
const PROGRESS_EMIT_INTERVAL_MS = 1000

/** Kept for diagnostics on failure; bounded so a chatty child can't grow it. */
const STDERR_TAIL_LIMIT = 8000

/**
 * Minimal shape of what this module needs from a child process, so tests can
 * supply a stand-in and exercise the stop-and-timeout paths without ffmpeg.
 */
export interface CaptureChild {
  stdin: { write(data: string): unknown } | null
  stdout: { on(event: 'data', cb: (chunk: unknown) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: unknown) => void): unknown } | null
  kill(signal?: string): boolean
  on(event: 'close', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
}

export type SpawnCapture = (ffmpegPath: string, args: string[]) => CaptureChild

export interface CaptureExit {
  code: number | null
  /** Whether a graceful stop had to be escalated to a kill. */
  forced: boolean
  /** Tail of stderr, for the recordings row when something went wrong. */
  stderrTail: string
  /** Last progress sample seen, for average fps / size / drops. */
  lastProgress: RecorderProgress | null
}

export interface StartCaptureOptions {
  ffmpegPath: string
  args: string[]
  onProgress?: (sample: RecorderProgress) => void
  /** Called for the first sample showing encoded frames -- the readiness gate. */
  onFirstFrames?: (sample: RecorderProgress) => void
  /** Consecutive frame-bearing samples required before declaring readiness. */
  readyAfterSamples?: number
  onStderr?: (line: string) => void
  spawnFn?: SpawnCapture
  now?: () => number
}

export interface CaptureHandle {
  /** Asks ffmpeg to finish and resolves once it has, or after a forced kill. */
  stop(graceMs?: number): Promise<CaptureExit>
  /** Resolves when the child exits, whether asked to or not. */
  exited: Promise<CaptureExit>
  /** True once enough frame-bearing progress samples have arrived. */
  isProducingFrames(): boolean
  lastProgress(): RecorderProgress | null
}

export function startCapture(options: StartCaptureOptions): CaptureHandle {
  const {
    ffmpegPath,
    args,
    onProgress,
    onFirstFrames,
    readyAfterSamples = 3,
    onStderr,
    spawnFn = defaultSpawn,
    now = Date.now
  } = options

  const child = spawnFn(ffmpegPath, args)

  let carry = ''
  let stderrTail = ''
  let lastProgress: RecorderProgress | null = null
  // -Infinity, not 0: the first sample must always go out. Zero only happens
  // to work with a wall clock, and silently swallows the first update under an
  // injected clock -- which is also the sample that tells the readiness gate
  // capture has begun.
  let lastEmittedAt = Number.NEGATIVE_INFINITY
  let framesSamples = 0
  let ready = false
  let forced = false
  let settled = false

  let resolveExit: (exit: CaptureExit) => void
  const exited = new Promise<CaptureExit>((resolve) => {
    resolveExit = resolve
  })

  const finish = (code: number | null): void => {
    if (settled) return
    settled = true
    resolveExit({ code, forced, stderrTail, lastProgress })
  }

  child.stdout?.on('data', (chunk) => {
    const result = parseProgressChunk(String(chunk), carry)
    carry = result.remainder

    for (const sample of result.samples) {
      lastProgress = sample

      // Readiness is measured in *frames actually encoded*, not elapsed time.
      // ddagrab can open a display and deliver nothing at all -- observed on
      // a machine where gdigrab worked fine -- so "the process started" is not
      // evidence that anything is being captured.
      if (!ready && sample.frame > 0) {
        framesSamples += 1
        if (framesSamples >= readyAfterSamples) {
          ready = true
          onFirstFrames?.(sample)
        }
      }

      const dueForEmit = now() - lastEmittedAt >= PROGRESS_EMIT_INTERVAL_MS
      // The final sample always goes out: it carries the totals the recording
      // row is written from.
      if (dueForEmit || sample.ended) {
        lastEmittedAt = now()
        onProgress?.(sample)
      }
    }
  })

  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT)
    onStderr?.(text)
  })

  child.on('error', (err: Error) => {
    stderrTail = (stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_LIMIT)
    finish(null)
  })

  child.on('close', (code: number | null) => finish(code))

  return {
    stop(graceMs = STOP_GRACE_MS): Promise<CaptureExit> {
      try {
        // 'q' is ffmpeg's own quit command. It leaves the main loop normally,
        // which is what writes the container index.
        child.stdin?.write('q')
      } catch {
        // A closed stdin means the child is already going away; the close
        // handler will settle this.
      }

      const timer = setTimeout(() => {
        forced = true
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, graceMs)

      return exited.then((exit) => {
        clearTimeout(timer)
        return exit
      })
    },
    exited,
    isProducingFrames: () => ready,
    lastProgress: () => lastProgress
  }
}

function defaultSpawn(ffmpegPath: string, args: string[]): CaptureChild {
  return spawn(ffmpegPath, args, { windowsHide: true }) as unknown as CaptureChild
}
