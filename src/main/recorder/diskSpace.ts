import { statfsSync } from 'fs'
import type { RecordingSettings } from '../../shared/types'
import type { CaptureTarget } from './ffmpegArgs'
import { formatBytes, requiredFreeBytes } from './estimates'

// Free-space checks, before and during a recording.
//
// Uses fs.statfsSync rather than shelling out to wmic or PowerShell: it's
// synchronous, has no startup cost, and is available in the Node version
// Electron 33 ships. A 60-second poll during a recording is cheap enough at
// that price, and expensive enough to matter if it spawned a process each time.

export interface FreeSpace {
  freeBytes: number
  totalBytes: number
}

/** Null when the path can't be queried, e.g. a disconnected network share. */
export function getFreeSpace(path: string): FreeSpace | null {
  try {
    const stats = statfsSync(path)
    // bavail is what's available to this user, which is the number that
    // matters; bfree includes blocks reserved for root on some filesystems.
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize)
    }
  } catch {
    return null
  }
}

export interface DiskCheck {
  ok: boolean
  freeBytes: number | null
  requiredBytes: number
  /** Present when the check failed, phrased for the user. */
  reason: string | null
}

/**
 * Whether there is room to start a recording.
 *
 * An unqueryable path is allowed through deliberately. Refusing to record
 * because free space couldn't be *measured* would turn a diagnostic gap into a
 * lost game; the during-recording check will catch a genuinely full disk.
 */
export function checkFreeSpaceForStart(
  path: string,
  settings: RecordingSettings,
  target: CaptureTarget,
  audioTrackCount = 0
): DiskCheck {
  const required = requiredFreeBytes({ settings, target }, audioTrackCount)
  const space = getFreeSpace(path)

  if (!space) {
    return {
      ok: true,
      freeBytes: null,
      requiredBytes: required,
      reason: null
    }
  }

  if (space.freeBytes >= required) {
    return { ok: true, freeBytes: space.freeBytes, requiredBytes: required, reason: null }
  }

  return {
    ok: false,
    freeBytes: space.freeBytes,
    requiredBytes: required,
    reason:
      `Not enough disk space to record: ${formatBytes(space.freeBytes)} free, ` +
      `about ${formatBytes(required)} needed for an hour of footage plus conversion room.`
  }
}

/** How often free space is re-checked while recording. */
export const DISK_CHECK_INTERVAL_MS = 60_000

/**
 * The point at which a running recording is stopped.
 *
 * Deliberately much smaller than the start requirement. Once a recording is
 * under way the choice is between stopping cleanly with a playable file and
 * filling the disk, and the second one takes the rest of the machine with it.
 */
export const STOP_RECORDING_FREE_BYTES = 2 * 1024 ** 3

export interface RunningDiskCheck {
  shouldStop: boolean
  freeBytes: number | null
  reason: string | null
}

export function checkFreeSpaceWhileRecording(path: string): RunningDiskCheck {
  const space = getFreeSpace(path)
  if (!space) return { shouldStop: false, freeBytes: null, reason: null }

  if (space.freeBytes > STOP_RECORDING_FREE_BYTES) {
    return { shouldStop: false, freeBytes: space.freeBytes, reason: null }
  }

  return {
    shouldStop: true,
    freeBytes: space.freeBytes,
    reason:
      `Stopping the recording: only ${formatBytes(space.freeBytes)} of disk space is left. ` +
      'The footage captured so far has been saved.'
  }
}
