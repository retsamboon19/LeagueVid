import type { VideoFileInfo } from '../../../shared/types'
import { probeVideoDurationMs } from './probeDuration'

// How many files to probe concurrently when falling back to the
// <video>-element method. Kept modest -- each one spins up real media
// decoding in the renderer, so too many at once competes for CPU/IO and
// can make individual probes slower/flakier rather than faster overall.
const PARALLEL_PROBE_LIMIT = 6

export interface ProbeResult {
  file: VideoFileInfo
  durationMs: number | null
}

/**
 * Resolves durations for a batch of files, in three layers:
 *   1. On-disk cache (path + size) -- instant, no I/O beyond a DB read.
 *   2. Fast native container header read (MP4/MOV only) -- no video
 *      decode, a handful of small seeked reads.
 *   3. Fallback <video>-element probe, run with limited concurrency,
 *      for anything the first two couldn't resolve (MKV/AVI/WebM, or an
 *      unusual/corrupt MP4). Successful fallback probes are written back
 *      to the cache so future scans of the same file skip straight to
 *      step 1.
 *
 * onProgress is called after each file resolves (not necessarily in file
 * order, since step 3 runs several files concurrently).
 */
export async function probeDurationsBatch(
  files: VideoFileInfo[],
  onProgress?: (done: number, total: number, file: VideoFileInfo) => void
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array(files.length)
  const needsFallback: number[] = []
  let done = 0

  // Layers 1 + 2 first, sequentially -- both are cheap (a DB lookup, or a
  // few seeked reads on the main process's file handle), so there's no
  // real benefit to parallelizing this part, and it keeps things simple.
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fast = await window.api.video.probeDurationFast({
      filePath: file.filePath,
      sizeBytes: file.sizeBytes
    })
    if (fast !== null) {
      results[i] = { file, durationMs: fast }
      done++
      onProgress?.(done, files.length, file)
    } else {
      needsFallback.push(i)
    }
  }

  // Layer 3: whatever's left, probed with limited concurrency via the
  // heavier <video>-element method.
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < needsFallback.length) {
      const idx = needsFallback[cursor++]
      const file = files[idx]
      const mediaUrl = await window.api.video.toFileUrl(file.filePath)
      const durationMs = await probeVideoDurationMs(mediaUrl)
      if (durationMs !== null) {
        await window.api.video.cacheDuration({
          filePath: file.filePath,
          sizeBytes: file.sizeBytes,
          durationMs
        })
      }
      results[idx] = { file, durationMs }
      done++
      onProgress?.(done, files.length, file)
    }
  }

  const workerCount = Math.min(PARALLEL_PROBE_LIMIT, needsFallback.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}
