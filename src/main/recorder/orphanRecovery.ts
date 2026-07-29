import { existsSync, statSync } from 'fs'
import { basename } from 'path'
import type { RecordingRow } from '../../shared/types'
import {
  findInterruptedRecordings,
  insertVideo,
  setVideoSource,
  updateRecording
} from '../db/repository'
import { ffmpegBinaryPath } from './ffmpegBinary'
import { remuxToMp4 } from './remux'

// Repairs recordings that were interrupted by the app dying.
//
// A row in 'recording', 'stopping' or 'remuxing' can only be left by the
// process that owned the capture child, so finding one at startup means that
// process is gone -- crash, forced quit, power loss. The Matroska file is
// almost certainly still there and playable, because that is the entire reason
// the session is recorded as Matroska rather than MP4.
//
// This is the payoff of that container choice: kill the app mid-game and the
// next launch hands back a finished, playable, imported recording.

/** Below this, whatever is on disk isn't a recording worth keeping. */
const MIN_SALVAGEABLE_BYTES = 256 * 1024

export interface RecoveryOutcome {
  recordingId: number
  /** 'imported' | 'kept-mkv' | 'abandoned' | 'too-small' */
  result: 'imported' | 'kept-mkv' | 'abandoned' | 'too-small'
  path: string
  note: string
}

export async function recoverInterruptedRecordings(): Promise<RecoveryOutcome[]> {
  const rows = findInterruptedRecordings()
  if (rows.length === 0) return []

  const outcomes: RecoveryOutcome[] = []
  for (const row of rows) {
    outcomes.push(await recoverOne(row))
  }
  return outcomes
}

async function recoverOne(row: RecordingRow): Promise<RecoveryOutcome> {
  // A remux may have already finished before the process died; if the mp4 is
  // there and sound, prefer it and skip straight to importing.
  if (row.final_path && existsSync(row.final_path) && sizeOf(row.final_path) > MIN_SALVAGEABLE_BYTES) {
    importRecovered(row, row.final_path)
    return {
      recordingId: row.id,
      result: 'imported',
      path: row.final_path,
      note: 'The converted file was already complete.'
    }
  }

  if (!existsSync(row.temp_path)) {
    // Nothing to salvage. Marked failed rather than deleted so the row stays
    // as a record of what happened.
    updateRecording(row.id, {
      state: 'failed',
      endedAt: Date.now(),
      linkState: 'skipped',
      ffmpegError: 'The recording file was gone by the time LeagueVid restarted.'
    })
    return {
      recordingId: row.id,
      result: 'abandoned',
      path: row.temp_path,
      note: 'The recording file no longer exists.'
    }
  }

  const size = sizeOf(row.temp_path)
  if (size < MIN_SALVAGEABLE_BYTES) {
    updateRecording(row.id, {
      state: 'failed',
      endedAt: Date.now(),
      linkState: 'skipped',
      sizeBytes: size,
      ffmpegError: `Only ${size} bytes were written before LeagueVid stopped; nothing to recover.`
    })
    return {
      recordingId: row.id,
      result: 'too-small',
      path: row.temp_path,
      note: 'The interrupted recording was too short to be worth keeping.'
    }
  }

  updateRecording(row.id, { state: 'remuxing' })

  const remux = await remuxToMp4({
    ffmpegPath: ffmpegBinaryPath(),
    sourcePath: row.temp_path
  })

  // On failure remuxToMp4 returns the mkv as the file to import, so the
  // footage is still delivered -- in the wrong container, which is a far
  // better outcome than losing it.
  importRecovered(row, remux.importPath)

  updateRecording(row.id, {
    state: 'complete',
    endedAt: Date.now(),
    finalPath: remux.ok ? remux.importPath : null,
    sizeBytes: remux.sizeBytes,
    ffmpegError: remux.error
  })

  return {
    recordingId: row.id,
    result: remux.ok ? 'imported' : 'kept-mkv',
    path: remux.importPath,
    note: remux.ok
      ? 'Recovered and converted after an interrupted session.'
      : `Converting failed, so the original recording was kept: ${remux.error}`
  }
}

function importRecovered(row: RecordingRow, path: string): void {
  // insertVideo is idempotent on file_path, so re-running recovery cannot
  // produce duplicate library entries.
  const video = insertVideo({
    filePath: path,
    fileName: basename(path),
    // The measured game start is a better recording time than the file's
    // mtime, which by now reflects when the remux wrote it.
    recordedAt: row.game_start_ms ?? row.started_at,
    source: 'recorded'
  })
  setVideoSource(video.id, 'recorded')
  updateRecording(row.id, { videoId: video.id, linkState: 'pending' })
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
