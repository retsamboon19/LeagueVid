import type { RecorderProgress } from '../../shared/types'

// Parses ffmpeg's `-progress pipe:1` stream.
//
// The format is one key=value per line, terminated by `progress=continue` (or
// `progress=end` on the last one):
//
//     frame=1234
//     fps=59.94
//     total_size=52428800
//     out_time_us=20583000
//     dup_frames=0
//     drop_frames=2
//     speed=1.01x
//     progress=continue
//
// Pure and incremental, because a pipe splits wherever it likes: a block can
// arrive as three chunks, and a chunk can end mid-key. Anything that parsed
// per-chunk would drop samples at random and, worse, do it more often under
// load -- exactly when the numbers matter.

export interface ProgressParseResult {
  samples: RecorderProgress[]
  /** Bytes not yet part of a complete block. Feed back in on the next call. */
  remainder: string
}

/**
 * ffmpeg's `out_time_ms` is a long-standing misnomer: it reports
 * *microseconds*, identical to `out_time_us`. Reading it as milliseconds puts
 * the recording position out by 1000x, so only `out_time_us` is used and the
 * misnamed field is deliberately ignored.
 */
const MICROSECONDS_PER_MS = 1000

/**
 * Safety valve. The progress stream is entirely key=value lines, so the carry
 * should never grow past one block. If something else ever ends up on this
 * pipe, drop it rather than accumulating forever.
 */
const MAX_CARRY_BYTES = 64 * 1024

export function parseProgressChunk(chunk: string, carry = ''): ProgressParseResult {
  const combined = carry + chunk
  const samples: RecorderProgress[] = []

  let fields: Record<string, string> = {}
  // Everything before this offset belongs to a block already emitted.
  let consumed = 0
  let cursor = 0

  for (;;) {
    const newline = combined.indexOf('\n', cursor)
    // A line without its terminator is incomplete: leave it for the next chunk.
    if (newline === -1) break

    const line = combined.slice(cursor, newline).replace(/\r$/, '')
    cursor = newline + 1

    const separator = line.indexOf('=')
    if (separator === -1) continue

    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    fields[key] = value

    // 'progress' terminates a block, so this is the point at which a sample is
    // complete and the input up to here can be discarded.
    if (key === 'progress') {
      samples.push(toProgress(fields, value === 'end'))
      fields = {}
      consumed = cursor
    }
  }

  const remainder = combined.slice(consumed)
  return {
    samples,
    remainder: remainder.length > MAX_CARRY_BYTES ? '' : remainder
  }
}

function toProgress(fields: Record<string, string>, ended: boolean): RecorderProgress {
  return {
    frame: intOf(fields.frame),
    fps: floatOf(fields.fps),
    totalSizeBytes: intOf(fields.total_size),
    outTimeMs: Math.round(intOf(fields.out_time_us) / MICROSECONDS_PER_MS),
    dropFrames: intOf(fields.drop_frames),
    dupFrames: intOf(fields.dup_frames),
    // 'speed=1.01x', and 'speed=N/A' before the first frame lands.
    speed: floatOf(fields.speed?.replace(/x$/, '')),
    ended
  }
}

function intOf(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  // ffmpeg writes 'N/A' for fields it doesn't have yet. Treating that as 0 is
  // right for counters, and honest: nothing has been dropped yet either.
  return Number.isFinite(parsed) ? parsed : 0
}

function floatOf(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** Threshold helpers used by the health warning and the preflight report. */
export const DROP_RATIO_WARNING = 0.01
export const SPEED_WARNING = 0.95

export interface CaptureHealth {
  healthy: boolean
  dropRatio: number
  reasons: string[]
}

/**
 * Judges a progress sample.
 *
 * Both thresholds matter for different failures: dropped frames mean the
 * capture couldn't keep up and the footage has gaps, while speed under real
 * time means the encoder is behind and the buffer is growing -- which ends in
 * dropped frames later even if none have been dropped yet.
 */
export function assessCaptureHealth(sample: RecorderProgress): CaptureHealth {
  const reasons: string[] = []
  const dropRatio = sample.frame > 0 ? sample.dropFrames / sample.frame : 0

  if (dropRatio > DROP_RATIO_WARNING) {
    reasons.push(
      `Dropping frames (${sample.dropFrames} of ${sample.frame}, ${(dropRatio * 100).toFixed(1)}%).`
    )
  }
  // Only meaningful once encoding has actually started; speed reads 0 before
  // the first frame and that isn't a fault.
  if (sample.frame > 0 && sample.speed > 0 && sample.speed < SPEED_WARNING) {
    reasons.push(`Encoding slower than real time (${sample.speed.toFixed(2)}x).`)
  }

  return { healthy: reasons.length === 0, dropRatio, reasons }
}
