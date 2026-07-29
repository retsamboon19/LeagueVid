import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'

// Single source of truth for where the bundled ffmpeg lives.
//
// ffmpeg-static exports an absolute path computed from its own location
// inside node_modules. That's correct in development and wrong in a packaged
// build, where node_modules has been rolled into app.asar -- an archive, not
// a directory, so the OS cannot execute anything inside it. The binary has to
// be unpacked (see the asarUnpack packaging config) and the path rewritten to
// point at the unpacked copy.
//
// Clipping has always had this latent bug; it just never surfaced because
// there is no packaged build yet. Recording makes ffmpeg load-bearing, so
// both features now resolve it through here rather than each importing
// ffmpeg-static and hoping.

let cached: string | null = null

export function ffmpegBinaryPath(): string {
  if (cached) return cached

  const bundled = ffmpegStatic as unknown as string | null
  if (!bundled) {
    throw new Error(
      'The bundled video encoder is missing from this build. Try reinstalling LeagueVid.'
    )
  }

  const candidates: string[] = []

  if (app.isPackaged) {
    // Preferred: the same relative location, outside the archive.
    candidates.push(bundled.replace(`app.asar${sep()}`, `app.asar.unpacked${sep()}`))
    // Fallback: shipped as a plain extra resource next to the app.
    candidates.push(join(process.resourcesPath, 'ffmpeg.exe'))
  }

  candidates.push(bundled)

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cached = candidate
      return candidate
    }
  }

  // Naming the paths searched matters here: the failure mode differs between
  // dev and packaged builds, and "encoder not found" on its own gives whoever
  // is debugging it nothing to go on.
  throw new Error(
    `Could not find the bundled video encoder. Looked in:\n${candidates.join('\n')}`
  )
}

/** Path separator as it appears in the ffmpeg-static path on this platform. */
function sep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

/** Testing / re-probing hook: forces the next call to resolve again. */
export function resetFfmpegBinaryPathCache(): void {
  cached = null
}
