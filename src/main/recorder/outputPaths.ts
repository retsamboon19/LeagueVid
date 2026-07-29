import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { getRecordingSettings } from '../db/repository'

// Where recordings are written, and what they're called.
//
// Mirrors clipService's approach deliberately: a folder inside the app's own
// directory by default, overridable, created on demand, and falling back to the
// default if a configured folder has become unusable. Everything LeagueVid
// produces stays together in one place the user already knows about, rather
// than being scattered into the OS Videos library or app data.

function appRootDir(): string {
  // When packaged, getAppPath() points inside app.asar -- an archive, not a
  // writable directory -- so the executable's folder is used instead.
  return app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath()
}

export function defaultRecordingsDir(): string {
  return join(appRootDir(), 'recordings')
}

/**
 * The recordings folder, created if needed.
 *
 * A configured folder that can't be created (moved drive, revoked permission,
 * disconnected network share) falls back to the default rather than failing:
 * the alternative is refusing to record a game that has already started.
 */
export function recordingsDir(): string {
  const configured = getRecordingSettings().outputDir

  if (configured) {
    try {
      mkdirSync(configured, { recursive: true })
      return configured
    } catch {
      // Fall through to the default.
    }
  }

  const fallback = defaultRecordingsDir()
  mkdirSync(fallback, { recursive: true })
  return fallback
}

/**
 * Local-time stamp for a file name: '2026-07-29 14-32-07'.
 *
 * Local rather than UTC, and with the date in ISO order, so the file name reads
 * as the moment the user remembers playing and the folder sorts
 * chronologically. Colons are illegal in Windows file names, hence the hyphens
 * in the time -- which is also the shape parseFileNameDate already reads, so a
 * recorded file re-imported from disk still resolves its own timestamp.
 */
export function formatFileNameStamp(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
  )
}

export function sanitizeFileNamePart(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'Recording'
}

/** Adds ' (2)', ' (3)' rather than overwriting an existing recording. */
export function uniquePath(directory: string, baseName: string, extension: string): string {
  let candidate = join(directory, `${baseName}${extension}`)
  let counter = 2
  while (existsSync(candidate)) {
    candidate = join(directory, `${baseName} (${counter})${extension}`)
    counter++
  }
  return candidate
}

export interface SessionPathInput {
  /** Champion being played, when the League client has told us yet. */
  championName?: string | null
  /** Defaults to now. */
  startedAt?: Date
  directory?: string
}

/**
 * The Matroska path for a new session, e.g.
 * 'recordings/League of Legends Yorick 2026-07-29 14-32-07.mkv'.
 *
 * The champion is included when known because it makes the folder browsable,
 * but it is never required: capture starts before the League client has
 * necessarily reported anything, and waiting for a nicer file name would mean
 * missing the opening seconds of the game.
 */
export function buildSessionPath(input: SessionPathInput = {}): string {
  const directory = input.directory ?? recordingsDir()
  const startedAt = input.startedAt ?? new Date()

  const parts = ['League of Legends']
  if (input.championName) parts.push(sanitizeFileNamePart(input.championName))
  parts.push(formatFileNameStamp(startedAt))

  return uniquePath(directory, parts.join(' '), '.mkv')
}
