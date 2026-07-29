import { spawn } from 'child_process'
import { existsSync, statSync, unlinkSync } from 'fs'

// Converts the Matroska session file into the MP4 the rest of the app expects.
//
// Why record MKV and convert, rather than recording MP4 directly: MP4 keeps its
// index (the moov atom) at the end of the file, so a recording interrupted by a
// crash, a power cut or a forced quit is unplayable. Fragmented MP4 survives
// truncation but writes a zero duration into mvhd, which silently defeats the
// existing probeMp4Duration.ts fast path and would regress library scanning.
// Matroska tolerates truncation and still reports a usable duration.
//
// The conversion is `-c copy`: no re-encoding, no quality change, just a
// container rewrite at disk speed. A 40-minute 1440p recording takes seconds.

/** Beyond this, something is wrong with the remux rather than slow. */
const REMUX_TIMEOUT_MS = 10 * 60 * 1000

export interface RemuxResult {
  ok: boolean
  /** The file to import: the mp4 on success, the original mkv on failure. */
  importPath: string
  /** Set when the remux failed, for the recordings row. */
  error: string | null
  sizeBytes: number
}

export function mp4PathFor(mkvPath: string): string {
  return mkvPath.replace(/\.mkv$/i, '.mp4')
}

export interface RemuxOptions {
  ffmpegPath: string
  sourcePath: string
  /** Defaults to the source path with an .mp4 extension. */
  targetPath?: string
  /** Delete the source once the target is verified. Default true. */
  deleteSourceOnSuccess?: boolean
}

/**
 * Remuxes, verifies, and only then deletes the source.
 *
 * Failure never costs footage: if anything goes wrong the Matroska file is
 * kept and returned as the file to import. A recording in the wrong container
 * is a minor annoyance; a deleted recording is the game gone.
 */
export async function remuxToMp4(options: RemuxOptions): Promise<RemuxResult> {
  const {
    ffmpegPath,
    sourcePath,
    targetPath = mp4PathFor(sourcePath),
    deleteSourceOnSuccess = true
  } = options

  if (!existsSync(sourcePath)) {
    return {
      ok: false,
      importPath: sourcePath,
      error: `The recording file is missing: ${sourcePath}`,
      sizeBytes: 0
    }
  }

  const run = await runFfmpeg(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    sourcePath,
    '-c',
    'copy',
    // Without this a copied stream can carry timestamps that make players
    // report the wrong duration -- the same reason clipService sets it.
    '-avoid_negative_ts',
    'make_zero',
    // Puts the moov atom at the front so playback can start before the whole
    // file is read.
    '-movflags',
    '+faststart',
    '-y',
    targetPath
  ])

  if (run.code !== 0 || !existsSync(targetPath)) {
    return {
      ok: false,
      importPath: sourcePath,
      error: run.timedOut
        ? `Remux timed out after ${REMUX_TIMEOUT_MS / 60000} minutes.`
        : run.stderr.trim() || `Remux exited with code ${run.code}.`,
      sizeBytes: sizeOf(sourcePath)
    }
  }

  // A zero-length or near-empty output means ffmpeg produced a file and
  // nothing else. Trusting exit code 0 alone would delete the real recording
  // and leave an unplayable stub in its place.
  const targetSize = sizeOf(targetPath)
  if (targetSize < 1024) {
    return {
      ok: false,
      importPath: sourcePath,
      error: `Remux produced an empty file (${targetSize} bytes); keeping the original recording.`,
      sizeBytes: sizeOf(sourcePath)
    }
  }

  if (deleteSourceOnSuccess) {
    try {
      unlinkSync(sourcePath)
    } catch {
      // Leaving the mkv behind wastes disk but loses nothing, so it isn't
      // worth failing an otherwise good remux over.
    }
  }

  return { ok: true, importPath: targetPath, error: null, sizeBytes: targetSize }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

interface FfmpegRun {
  code: number | null
  stderr: string
  timedOut: boolean
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<FfmpegRun> {
  return new Promise((resolve) => {
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(ffmpegPath, args, { windowsHide: true })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, REMUX_TIMEOUT_MS)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stderr, timedOut })
    }

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
