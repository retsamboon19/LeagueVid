import { app, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import ffmpegPath from 'ffmpeg-static'
import { getClipsDirOverride } from '../db/repository'

// Exports a section of a recording to its own video file.
//
// Uses the ffmpeg binary bundled by ffmpeg-static, so there's nothing for the
// user to install. Two modes, because the trade-off is real and worth exposing
// rather than hiding:
//
//   fast  -- stream copy (-c copy). No re-encoding, so it finishes in about a
//            second regardless of clip length and loses no quality. The catch
//            is that a cut can only start on a keyframe, so the clip may begin
//            up to a couple of seconds earlier than asked.
//   exact -- re-encodes, so the clip starts precisely on the requested frame.
//            Slower (roughly real-time-ish depending on CPU) and technically
//            lossy, though at the quality settings used that's not visible.

export interface ClipRequest {
  sourcePath: string
  startMs: number
  endMs: number
  /** Base file name without extension; sanitized before use. */
  name: string
  mode: 'fast' | 'exact'
}

export interface ClipResult {
  outputPath: string
  sizeBytes: number
  durationMs: number
}

/**
 * The app's own install/project folder -- e.g. H:\LeagueVid.
 *
 * When packaged, getAppPath() points inside app.asar (an archive, not a real
 * writable directory), so the executable's folder is used instead. In dev
 * getAppPath() is the project root, which is what's wanted.
 */
function appRootDir(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath()
}

/** Default clips location: kept inside the app's own folder, self-contained. */
export function defaultClipsDir(): string {
  return join(appRootDir(), 'clips')
}

/**
 * Where clips are written: the user's configured folder if they've set one,
 * otherwise a 'clips' folder alongside the app itself. Deliberately not the OS
 * Videos library or app data -- everything the app produces stays together in
 * one place the user already knows about.
 *
 * Creates the directory on demand. If a configured folder has become
 * unusable (moved drive, revoked permission), it falls back to the default
 * rather than failing the export outright.
 */
export function clipsDir(): string {
  const configured = getClipsDirOverride()

  if (configured) {
    try {
      mkdirSync(configured, { recursive: true })
      return configured
    } catch {
      // Fall through to the default below.
    }
  }

  const fallback = defaultClipsDir()
  mkdirSync(fallback, { recursive: true })
  return fallback
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '') // characters Windows forbids
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'clip'
}

/** Adds " (2)", " (3)" ... rather than silently overwriting an earlier clip. */
function uniquePath(dir: string, baseName: string, ext: string): string {
  let candidate = join(dir, `${baseName}${ext}`)
  let counter = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${baseName} (${counter})${ext}`)
    counter++
  }
  return candidate
}

function formatFfmpegTime(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  // Sub-second precision matters: clip boundaries are chosen on a frame-level
  // timeline, so truncating to whole seconds would visibly shift the cut.
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds
    .toFixed(3)
    .padStart(6, '0')}`
}

function buildArgs(request: ClipRequest, outputPath: string): string[] {
  const durationMs = request.endMs - request.startMs
  const start = formatFfmpegTime(request.startMs)
  const duration = formatFfmpegTime(durationMs)

  if (request.mode === 'fast') {
    // -ss before -i seeks by index instead of decoding up to the point, which
    // is what makes this fast; combined with -c copy nothing is re-encoded.
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', start,
      '-i', request.sourcePath,
      '-t', duration,
      '-c', 'copy',
      // Without this, a copied stream can carry timestamps that make some
      // players report the wrong duration.
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ]
  }

  return [
    '-hide_banner',
    '-loglevel', 'error',
    // -ss stays BEFORE -i even in exact mode. Since ffmpeg 2.1 that seek is
    // frame-accurate when re-encoding (it decodes from the preceding keyframe
    // and discards the extra frames), so it's both precise and fast. Putting
    // -ss after -i also works but decodes the whole file up to the cut:
    // measured on a real recording, a 15s clip two minutes in took 38s that
    // way versus 7.6s this way, with byte-identical output.
    '-ss', start,
    '-i', request.sourcePath,
    '-t', duration,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    // Visually indistinguishable at typical gameplay bitrates while keeping
    // the file small enough to share.
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-y',
    outputPath
  ]
}

export async function createClip(request: ClipRequest): Promise<ClipResult> {
  if (!ffmpegPath) {
    throw new Error('The bundled video encoder is missing. Try reinstalling LeagueVid.')
  }
  if (!existsSync(request.sourcePath)) {
    throw new Error('The source recording could not be found on disk.')
  }

  const durationMs = request.endMs - request.startMs
  if (!(durationMs > 0)) {
    throw new Error('The clip end must come after its start.')
  }

  const dir = clipsDir()
  // Keep the source container so stream copy stays valid in fast mode.
  const ext = extname(request.sourcePath) || '.mp4'
  const outputPath = uniquePath(dir, sanitizeFileName(request.name), ext)

  const args = buildArgs(request, outputPath)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, args, { windowsHide: true })

    // ffmpeg reports everything on stderr, including real errors, so it's
    // captured to give a useful message instead of a bare exit code.
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    child.on('error', (err) => reject(new Error(`Could not start the encoder: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `Encoder exited with code ${code}.`))
    })
  })

  if (!existsSync(outputPath)) {
    throw new Error('The encoder finished but produced no file.')
  }

  return {
    outputPath,
    sizeBytes: statSync(outputPath).size,
    durationMs
  }
}

export function revealClipsFolder(): void {
  shell.openPath(clipsDir())
}

export function revealClip(filePath: string): void {
  // Selects the file inside the folder rather than just opening the folder.
  if (existsSync(filePath)) shell.showItemInFolder(filePath)
  else revealClipsFolder()
}

export function suggestedClipName(sourcePath: string, label: string): string {
  const base = basename(sourcePath, extname(sourcePath))
  return sanitizeFileName(`${base} - ${label}`)
}
