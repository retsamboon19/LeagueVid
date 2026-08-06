import { existsSync, statSync, unlinkSync } from 'fs'
import { stat } from 'fs/promises'
import { deleteVideos, getRecordingSettings, listRetentionCandidates } from '../db/repository'
import { formatBytes } from './estimates'
import { getFreeSpace } from './diskSpace'
import { recordingsDir } from './outputPaths'
import {
  formatRetentionSummary,
  planRetention,
  type RetentionCandidate,
  type RetentionPlan
} from './retention'

// Runs retention, and reports what it would do before it does it.
//
// The preview and the sweep both call buildPlan, so they cannot disagree about
// which files are involved -- that equality is the safety property, and it comes
// from sharing one code path rather than from two implementations happening to
// match.

/**
 * Sizes every candidate.
 *
 * The recordings row carries the size for anything LeagueVid recorded; anything
 * else gets measured. A file that no longer exists reports zero rather than
 * being dropped, so the preview can still show it and the sweep can still clear
 * its library row.
 */
function withSizes(
  candidates: ReturnType<typeof listRetentionCandidates>
): RetentionCandidate[] {
  return candidates.map((candidate) => ({
    videoId: candidate.videoId,
    filePath: candidate.filePath,
    fileName: candidate.fileName,
    sizeBytes: candidate.sizeBytes ?? measure(candidate.filePath),
    recordedAt: candidate.recordedAt,
    isFavorite: candidate.isFavorite,
    source: candidate.source
  }))
}

function measure(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

async function measureAsync(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch {
    return 0
  }
}

/**
 * Sizes uncached files without blocking Electron's main thread.
 *
 * Imported videos normally have a size in video_duration_cache already. The
 * bounded fallback covers older or manually-created rows without firing
 * hundreds of disk requests at once, which matters when a library lives on a
 * slower external drive.
 */
async function withSizesAsync(
  candidates: ReturnType<typeof listRetentionCandidates>
): Promise<RetentionCandidate[]> {
  const sized: RetentionCandidate[] = new Array(candidates.length)
  let nextIndex = 0
  const workerCount = Math.min(12, Math.max(1, candidates.length))

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex++
        if (index >= candidates.length) return
        const candidate = candidates[index]
        sized[index] = {
          videoId: candidate.videoId,
          filePath: candidate.filePath,
          fileName: candidate.fileName,
          sizeBytes: candidate.sizeBytes ?? (await measureAsync(candidate.filePath)),
          recordedAt: candidate.recordedAt,
          isFavorite: candidate.isFavorite,
          source: candidate.source
        }
      }
    })
  )

  return sized
}

function buildPlan(): RetentionPlan {
  const settings = getRecordingSettings()
  return planRetention(withSizes(listRetentionCandidates()), {
    enabled: settings.retentionEnabled,
    maxGb: settings.retentionMaxGb,
    maxAgeDays: settings.retentionMaxAgeDays
  })
}

export interface RetentionPreview {
  summary: string
  totalBytes: number
  reclaimedBytes: number
  files: Array<{ videoId: number; fileName: string; sizeBytes: number; reason: string }>
}

/** The dry run. Touches nothing. */
export function previewRetentionSweep(): RetentionPreview {
  const plan = buildPlan()
  return {
    summary: formatRetentionSummary(plan),
    totalBytes: plan.totalBytes,
    reclaimedBytes: plan.reclaimedBytes,
    files: plan.toDelete.map((candidate) => ({
      videoId: candidate.videoId,
      fileName: candidate.fileName,
      sizeBytes: candidate.sizeBytes,
      reason: plan.reasons[candidate.videoId] ?? 'over the retention limit'
    }))
  }
}

export interface RetentionSweepResult {
  deletedCount: number
  freedBytes: number
  /** Files that could not be removed, e.g. open in another program. */
  failures: Array<{ fileName: string; reason: string }>
}

/**
 * Deletes the files the plan names, then their library rows.
 *
 * Files first, rows second: if this is interrupted halfway, a library row
 * pointing at a missing file is visible and fixable, where a deleted row
 * pointing at a file left on disk is invisible and accumulates.
 */
export function runRetentionSweep(): RetentionSweepResult {
  const plan = buildPlan()
  if (plan.toDelete.length === 0) {
    return { deletedCount: 0, freedBytes: 0, failures: [] }
  }

  const failures: RetentionSweepResult['failures'] = []
  const deletedIds: number[] = []
  let freedBytes = 0

  for (const candidate of plan.toDelete) {
    try {
      if (existsSync(candidate.filePath)) {
        unlinkSync(candidate.filePath)
        freedBytes += candidate.sizeBytes
      }
      deletedIds.push(candidate.videoId)
    } catch (err) {
      // A file held open by a video player is the common case. Its library row
      // is left alone so the next sweep tries again.
      failures.push({ fileName: candidate.fileName, reason: (err as Error).message })
    }
  }

  if (deletedIds.length > 0) deleteVideos(deletedIds)

  return { deletedCount: deletedIds.length, freedBytes, failures }
}

export interface DiskUsageReport {
  /** Bytes used by everything in the library. */
  libraryBytes: number
  /** Bytes used by recordings LeagueVid made. */
  recordedBytes: number
  recordedCount: number
  freeBytes: number | null
  totalBytes: number | null
  summary: string
}

export async function getDiskUsage(): Promise<DiskUsageReport> {
  const candidates = await withSizesAsync(listRetentionCandidates())
  const recorded = candidates.filter((candidate) => candidate.source === 'recorded')

  const libraryBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)
  const recordedBytes = recorded.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)
  const space = getFreeSpace(recordingsDir())

  return {
    libraryBytes,
    recordedBytes,
    recordedCount: recorded.length,
    freeBytes: space?.freeBytes ?? null,
    totalBytes: space?.totalBytes ?? null,
    summary: space
      ? `${formatBytes(recordedBytes)} in ${recorded.length} recording(s); ${formatBytes(
          space.freeBytes
        )} free on this drive.`
      : `${formatBytes(recordedBytes)} in ${recorded.length} recording(s).`
  }
}
