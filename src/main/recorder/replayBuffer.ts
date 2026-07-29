import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

// The rolling buffer that lets someone press a key after something good happens
// and get just that moment.
//
// The ring is written by the tee muxer as part of the main capture (see
// teeTarget in ffmpegArgs), so enabling the buffer costs one encode rather than
// two. Saving concatenates the newest segments with the concat demuxer and
// `-c copy`, which is why the ring is mpegts: those segments join cleanly where
// MP4 fragments do not.
//
// The fiddly part, and the reason the selection logic is pure and tested, is the
// wrap. segment_wrap makes ffmpeg reuse file names from 0 after N segments, so
// the newest footage is not the highest-numbered file -- it is wherever the
// write head happens to be. Selecting by name would hand back the oldest two
// minutes of the game instead of the last two.

export interface SegmentFile {
  path: string
  /** Segment index parsed from the file name. */
  index: number
  /** Last write time, which is what actually orders the ring. */
  modifiedMs: number
  sizeBytes: number
}

/** Reads the ring directory. Missing or unreadable reads as empty. */
export function listSegments(directory: string): SegmentFile[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => {
        const path = join(directory, name)
        const stats = statSync(path)
        const match = name.match(/(\d+)\.ts$/)
        return {
          path,
          index: match ? Number.parseInt(match[1], 10) : 0,
          modifiedMs: stats.mtimeMs,
          sizeBytes: stats.size
        }
      })
      .filter((segment) => segment.sizeBytes > 0)
  } catch {
    return []
  }
}

/**
 * The segments covering the most recent `seconds` of footage, oldest first.
 *
 * Ordered by modification time rather than segment index. After a wrap the
 * highest index is the *oldest* file, so ordering by name would save the opening
 * of the game rather than the moment that just happened.
 *
 * The segment currently being written is included: it holds the most recent
 * footage, which is precisely what the user pressed the key for. It is
 * necessarily incomplete, which is why the saved clip may be a second or two
 * short of the requested window.
 */
export function selectRecentSegments(
  segments: SegmentFile[],
  seconds: number,
  segmentSeconds: number
): SegmentFile[] {
  if (segments.length === 0) return []

  const byNewest = [...segments].sort((a, b) => b.modifiedMs - a.modifiedMs)
  // Rounded up, so the window is covered rather than clipped short.
  const needed = Math.max(1, Math.ceil(seconds / segmentSeconds))

  return byNewest.slice(0, needed).reverse()
}

/**
 * The concat demuxer's input list.
 *
 * Single quotes are the demuxer's own escape, and Windows paths contain
 * backslashes which it treats literally -- so only the quote character needs
 * escaping. Getting this wrong produces "No such file or directory" for a file
 * that plainly exists.
 */
export function buildConcatList(segments: SegmentFile[]): string {
  return segments.map((segment) => `file '${segment.path.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

export interface ReplayRing {
  directory: string
  /** printf pattern the tee muxer writes to. */
  pattern: string
  segmentSeconds: number
  segmentCount: number
}

/** Two-second segments keep the saved window close to what was asked for. */
export const SEGMENT_SECONDS = 2

/**
 * Sizes the ring for a buffer duration.
 *
 * One extra segment beyond the requested window, because the newest segment is
 * always partial -- without the spare, a save could come up a whole segment
 * short of the duration the user configured.
 */
export function ringFor(directory: string, bufferSeconds: number): ReplayRing {
  const segmentCount = Math.max(2, Math.ceil(bufferSeconds / SEGMENT_SECONDS) + 1)
  return {
    directory,
    pattern: join(directory, 'seg%03d.ts'),
    segmentSeconds: SEGMENT_SECONDS,
    segmentCount
  }
}

/**
 * Prepares the ring directory.
 *
 * Cleared on each session: leftover segments from the previous game are older
 * than anything in this one, and a save that reached back into them would
 * splice two games together.
 */
export function prepareRing(ring: ReplayRing): void {
  mkdirSync(ring.directory, { recursive: true })
  for (const segment of listSegments(ring.directory)) {
    try {
      unlinkSync(segment.path)
    } catch {
      // A locked leftover is harmless: it will be overwritten as the ring wraps.
    }
  }
}

/** Writes the concat list to disk and returns its path. */
export function writeConcatList(directory: string, segments: SegmentFile[]): string {
  const listPath = join(directory, `concat-${Date.now()}.txt`)
  writeFileSync(listPath, buildConcatList(segments), 'utf8')
  return listPath
}

export function cleanupConcatList(listPath: string): void {
  try {
    if (existsSync(listPath)) unlinkSync(listPath)
  } catch {
    // Leaving a text file behind is not worth reporting.
  }
}
