import { app } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

// Where OBS lives, and how it is found.
//
// Unlike ffmpeg, OBS is not committed to the repository or bundled into the
// installer: the official Windows portable build is 179 MB zipped and 466 MB
// extracted, larger than everything else LeagueVid ships put together. So it is a
// managed runtime dependency, resolved from either a copy sideloaded beside a
// packaged app or LeagueVid's own copy under userData.
//
// Notably absent: an OBS Studio the user already installed. That looks like a
// free win and is not one. LeagueVid must run OBS in portable mode, because
// portable mode is what keeps OBS's configuration inside the distribution
// instead of in the user's roaming profile -- and the alternative is writing our
// profile, scene collection and output settings over their scenes and hotkeys,
// which is indefensible. Verified against OBS 32.2.1: portable mode puts config
// in <root>/config/obs-studio, so it needs a writable distribution root, and a
// system install under Program Files is not writable without elevation.
//
// So LeagueVid uses a distribution it owns, or none. That is also what Overwolf
// does -- they ship their own OBS rather than reusing whatever is installed.

/** Root of an OBS distribution: the folder containing bin/, data/, obs-plugins/. */
export interface ObsInstall {
  /** Distribution root. */
  root: string
  /** Full path to obs64.exe. */
  executable: string
  /** Where obs64.exe must be launched from -- OBS requires this as its cwd. */
  workingDirectory: string
  /** How this copy was found, for diagnostics and for the Settings screen. */
  origin: 'sideloaded' | 'managed'
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
 * The configuration directory OBS will use, given a distribution.
 *
 * Not a choice: OBS in portable mode derives this from where the binary lives,
 * and there is no launch flag to point it elsewhere. Verified against 32.2.1 --
 * running with --portable produced exactly this tree, containing global.ini,
 * user.ini, basic/profiles/<name>/basic.ini, basic/scenes/<name>.json and
 * plugin_config/obs-websocket/config.json.
 *
 * Because every distribution LeagueVid uses is one it owns, this always lands
 * somewhere writable and never near the user's own %APPDATA%/obs-studio.
 */
export function obsConfigRoot(install: ObsInstall): string {
  return join(install.root, 'config', 'obs-studio')
}

/** Profile and scene collection names LeagueVid creates and owns. */
export const OBS_PROFILE_NAME = 'LeagueVid'
export const OBS_COLLECTION_NAME = 'LeagueVid'

export function obsProfileDir(install: ObsInstall): string {
  return join(obsConfigRoot(install), 'basic', 'profiles', OBS_PROFILE_NAME)
}

export function obsSceneCollectionPath(install: ObsInstall): string {
  return join(obsConfigRoot(install), 'basic', 'scenes', `${OBS_COLLECTION_NAME}.json`)
}

export function obsWebSocketConfigPath(install: ObsInstall): string {
  return join(obsConfigRoot(install), 'plugin_config', 'obs-websocket', 'config.json')
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

  return candidates
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
