import { app } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

// Where OBS lives, and how it is found.
//
// Unlike ffmpeg, OBS is not committed to the repository or bundled into the
// installer: the official Windows portable build is 179 MB, which is larger than
// everything else LeagueVid ships put together. So it is a managed runtime
// dependency, resolved from the first of several places that actually has it.
//
// The search order is deliberate:
//
//   1. A copy sideloaded next to the app (packaged builds that chose to bundle).
//   2. LeagueVid's own managed copy under userData, which is what the in-app
//      download writes.
//   3. An OBS Studio the user already installed. Plenty of people who record
//      games have one, and reusing it saves them a second 179 MB.
//
// Note that (3) is read, never written. Modifying someone's existing OBS
// configuration -- their scenes, their profiles, their hotkeys -- to make our
// recording work would be indefensible, so the OBS backend always runs with its
// own portable configuration directory regardless of which binary was found.

/** Root of an OBS distribution: the folder containing bin/, data/, obs-plugins/. */
export interface ObsInstall {
  /** Distribution root. */
  root: string
  /** Full path to obs64.exe. */
  executable: string
  /** Where obs64.exe must be launched from -- OBS requires this as its cwd. */
  workingDirectory: string
  /** How this copy was found, for diagnostics and for the Settings screen. */
  origin: 'sideloaded' | 'managed' | 'system'
}

/** Version LeagueVid downloads when asked to fetch OBS itself. */
export const MANAGED_OBS_VERSION = '32.2.1'

/**
 * Minimum version with the behaviour this backend relies on.
 *
 * obs-websocket has been built into OBS since 28, and the v5 protocol used here
 * arrived with it. Below that there is no control channel at all.
 */
export const MINIMUM_OBS_MAJOR = 28

export function managedObsRoot(): string {
  return join(app.getPath('userData'), 'obs', `obs-studio-${MANAGED_OBS_VERSION}`)
}

/**
 * The configuration directory LeagueVid hands OBS.
 *
 * Always separate from the user's own OBS config, and always separate from the
 * distribution root -- a system-wide install under Program Files is not writable,
 * and even when it is, writing our scene collection into it would trample their
 * setup.
 */
export function obsConfigRoot(): string {
  return join(app.getPath('userData'), 'obs', 'config')
}

/** Every place worth looking, in order. */
function candidateRoots(): Array<{ root: string; origin: ObsInstall['origin'] }> {
  const candidates: Array<{ root: string; origin: ObsInstall['origin'] }> = []

  if (app.isPackaged) {
    // Shipped as an extra resource beside the app, for a build that chose to
    // pay the 179 MB rather than download at runtime.
    candidates.push({ root: join(process.resourcesPath, 'obs'), origin: 'sideloaded' })
  }

  candidates.push({ root: managedObsRoot(), origin: 'managed' })

  for (const root of systemInstallRoots()) {
    candidates.push({ root, origin: 'system' })
  }

  return candidates
}

/**
 * Standard install locations for OBS Studio.
 *
 * PROGRAMFILES is read from the environment rather than hardcoded to
 * 'C:\Program Files' because it is not always on C:, and someone who moved it
 * would otherwise be told OBS is missing while it sits there.
 */
function systemInstallRoots(): string[] {
  const roots: string[] = []
  for (const variable of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const base = process.env[variable]
    if (base) roots.push(join(base, 'obs-studio'))
  }
  return roots
}

/**
 * Finds a usable OBS, or null.
 *
 * A root only counts when obs64.exe is actually there. Checking for the
 * directory would accept a half-deleted install or an empty folder left behind
 * by an interrupted download, and the failure would then surface as a spawn
 * error at the moment a game starts.
 */
export function findObsInstall(): ObsInstall | null {
  for (const { root, origin } of candidateRoots()) {
    const install = inspectRoot(root, origin)
    if (install) return install
  }
  return null
}

/**
 * Checks one candidate root.
 *
 * Handles the portable zip's extra nesting: OBS-Studio-32.2.1-Windows-x64.zip
 * expands to bin/data/obs-plugins directly, but extracting it without stripping
 * the top level -- or a user dragging the folder around -- leaves the real root
 * one level down. Looking one level in costs a directory read and avoids a
 * confusing "OBS is missing" when it plainly is not.
 */
function inspectRoot(root: string, origin: ObsInstall['origin']): ObsInstall | null {
  const direct = executableIn(root)
  if (direct) return { root, executable: direct, workingDirectory: binDirIn(root), origin }

  if (!existsSync(root)) return null

  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }

  for (const entry of entries) {
    const nested = join(root, entry)
    const executable = executableIn(nested)
    if (executable) {
      return { root: nested, executable, workingDirectory: binDirIn(nested), origin }
    }
  }

  return null
}

function binDirIn(root: string): string {
  return join(root, 'bin', '64bit')
}

function executableIn(root: string): string | null {
  const executable = join(binDirIn(root), 'obs64.exe')
  return existsSync(executable) ? executable : null
}

/**
 * Marks a distribution as portable.
 *
 * OBS reads this file's presence next to the binary and, when it is there, keeps
 * its configuration inside the distribution instead of in the user's roaming
 * profile. LeagueVid does not rely on it -- the config directory is passed
 * explicitly with a launch flag, which is stronger -- but it is the documented
 * belt-and-braces for a managed copy, and it guarantees that starting our OBS
 * can never pick up or overwrite the user's own scenes.
 */
export const PORTABLE_MODE_MARKER = 'obs_portable_mode.txt'

export function portableMarkerPath(install: ObsInstall): string {
  return join(install.workingDirectory, PORTABLE_MODE_MARKER)
}
