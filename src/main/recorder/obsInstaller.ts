import { spawn } from 'child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { get as httpsGet } from 'https'
import { join } from 'path'
import {
  MANAGED_OBS_VERSION,
  findObsInstall,
  managedObsRoot,
  type ObsInstall
} from './obsBinary'

// Fetches OBS on the user's behalf.
//
// Needed because OBS is not shipped with LeagueVid -- the official Windows
// portable build is 179 MB zipped and 466 MB extracted, larger than everything
// else here combined -- so without this the game-capture backend would only ever
// work on a machine where someone had already put OBS in the right place.
//
// Downloads the official release asset from GitHub over TLS. There is no
// published per-asset checksum to pin, so integrity rests on TLS plus a
// structural check after extraction: the archive has to actually contain a
// working OBS, with the game capture plugin, the injectable hook and the control
// plugin present. That is a weaker guarantee than a pinned hash and a stronger
// one than trusting the byte count, and it is the check that matters in practice
// -- a truncated or wrong download fails it.

/** The official portable build for the version LeagueVid manages. */
export function downloadUrl(version = MANAGED_OBS_VERSION): string {
  return (
    `https://github.com/obsproject/obs-studio/releases/download/${version}/` +
    `OBS-Studio-${version}-Windows-x64.zip`
  )
}

export type InstallPhase = 'downloading' | 'extracting' | 'verifying' | 'done'

export interface InstallProgress {
  phase: InstallPhase
  /** Bytes fetched so far. Only meaningful while downloading. */
  receivedBytes: number
  /** Total size, when the server reported one. */
  totalBytes: number | null
  /** 0-1, or null when the total is unknown. */
  fraction: number | null
}

export interface InstallResult {
  install: ObsInstall
  /** True when OBS was already present and nothing was downloaded. */
  alreadyPresent: boolean
}

/** Redirects followed. GitHub sends releases to a separate asset host. */
const MAX_REDIRECTS = 5

/** Anything smaller than this is not an OBS build; catches error pages. */
const MIN_PLAUSIBLE_BYTES = 50 * 1024 * 1024

let inFlight: Promise<InstallResult> | null = null

/**
 * Downloads and installs OBS, or returns the existing copy.
 *
 * Shared rather than repeated when called twice: the download is 179 MB, and two
 * concurrent installs would both write the same staging directory and race over
 * the final rename.
 */
export function installManagedObs(
  onProgress?: (progress: InstallProgress) => void
): Promise<InstallResult> {
  if (inFlight) return inFlight

  inFlight = run(onProgress).finally(() => {
    inFlight = null
  })

  return inFlight
}

export function isInstalling(): boolean {
  return inFlight !== null
}

async function run(onProgress?: (progress: InstallProgress) => void): Promise<InstallResult> {
  const existing = findObsInstall()
  if (existing) {
    onProgress?.({ phase: 'done', receivedBytes: 0, totalBytes: null, fraction: 1 })
    return { install: existing, alreadyPresent: true }
  }

  const root = managedObsRoot()
  const parent = join(root, '..')
  mkdirSync(parent, { recursive: true })

  // Staged beside the destination rather than in the OS temp directory, so the
  // final move is a rename within one volume instead of a 466 MB copy across
  // two -- and so a half-extracted build is never mistaken for an install.
  const staging = `${root}.staging`
  const archive = `${root}.zip`

  rmSync(staging, { recursive: true, force: true })
  rmSync(archive, { force: true })

  try {
    await download(downloadUrl(), archive, onProgress)

    const size = statSync(archive).size
    if (size < MIN_PLAUSIBLE_BYTES) {
      throw new Error(
        `The download is too small to be OBS (${(size / 1024 / 1024).toFixed(1)} MB). ` +
          'It may have been interrupted, or a network filter replaced it.'
      )
    }

    onProgress?.({ phase: 'extracting', receivedBytes: size, totalBytes: size, fraction: 1 })
    mkdirSync(staging, { recursive: true })
    await extract(archive, staging)

    onProgress?.({ phase: 'verifying', receivedBytes: size, totalBytes: size, fraction: 1 })
    const verified = verifyExtracted(staging)

    // Published only once it is known good, by renaming the verified tree into
    // the place findObsInstall looks. Extracting straight there would leave a
    // broken install behind on any failure, and it would look installed.
    rmSync(root, { recursive: true, force: true })
    renameSync(verified, root)

    const install = findObsInstall()
    if (!install) {
      throw new Error('OBS was installed but could not be found afterwards.')
    }

    onProgress?.({ phase: 'done', receivedBytes: size, totalBytes: size, fraction: 1 })
    return { install, alreadyPresent: false }
  } finally {
    rmSync(archive, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Streams the archive to disk, reporting progress.
 *
 * Written to disk rather than buffered: 179 MB in memory in the main process is
 * enough to matter, and there is nothing to gain from holding it.
 */
function download(
  url: string,
  destination: string,
  onProgress?: (progress: InstallProgress) => void,
  redirectsLeft = MAX_REDIRECTS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { headers: { 'User-Agent': 'LeagueVid' } }, (response) => {
      const status = response.statusCode ?? 0

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (redirectsLeft <= 0) {
          reject(new Error('The OBS download redirected too many times.'))
          return
        }
        const next = new URL(response.headers.location, url)
        // Refused rather than followed: a redirect off HTTPS would fetch a
        // 466 MB executable payload over a channel nothing can vouch for.
        if (next.protocol !== 'https:') {
          reject(new Error('The OBS download tried to redirect to an insecure address.'))
          return
        }
        download(next.toString(), destination, onProgress, redirectsLeft - 1).then(resolve, reject)
        return
      }

      if (status !== 200) {
        response.resume()
        reject(new Error(`The OBS download failed with HTTP ${status}.`))
        return
      }

      const header = response.headers['content-length']
      const totalBytes = header ? Number(header) : null
      let receivedBytes = 0
      let lastReport = 0

      const file = createWriteStream(destination)

      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length
        // Throttled: at a few MB/s this fires hundreds of times a second, and
        // every one crosses an IPC boundary to update a progress bar.
        if (receivedBytes - lastReport >= 1024 * 1024) {
          lastReport = receivedBytes
          onProgress?.({
            phase: 'downloading',
            receivedBytes,
            totalBytes,
            fraction: totalBytes ? receivedBytes / totalBytes : null
          })
        }
      })

      response.pipe(file)

      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
      response.on('error', reject)
    })

    request.on('error', reject)
    // Applies to establishing the connection, not the whole transfer -- a slow
    // connection must not be cut off partway through 179 MB.
    request.setTimeout(30000, () => {
      request.destroy(new Error('The OBS download timed out while connecting.'))
    })
  })
}

/**
 * Extracts the zip with Windows' own bsdtar.
 *
 * tar.exe has shipped in Windows since 10 1803 and handles zip, so this costs no
 * dependency. Verified: bsdtar 3.8.4 extracts the OBS archive with its directory
 * structure intact.
 */
function extract(archive: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar.exe', ['-xf', archive, '-C', destination], { windowsHide: true })

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (err) => reject(new Error(`Could not extract OBS: ${err.message}`)))
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Extracting OBS failed: ${stderr.trim() || `exit code ${code}`}`))
    )
  })
}

/**
 * Checks that what was extracted is a usable OBS, and returns its real root.
 *
 * This is the integrity check that stands in for a pinned checksum. It also
 * resolves the nesting question: the archive expands with bin/ at the top, but a
 * future one might not, and guessing would produce an install that resolves and
 * then fails to spawn.
 */
function verifyExtracted(staging: string): string {
  for (const root of [staging, ...childDirectories(staging)]) {
    if (existsSync(join(root, 'bin', '64bit', 'obs64.exe'))) {
      const missing = REQUIRED_COMPONENTS.filter(
        ([, relative]) => !existsSync(join(root, ...relative))
      ).map(([name]) => name)

      if (missing.length > 0) {
        throw new Error(`The downloaded OBS is missing ${missing.join(', ')}.`)
      }
      return root
    }
  }

  throw new Error('The downloaded archive does not contain OBS.')
}

/**
 * What has to be there for this to be worth installing.
 *
 * Every one of these is load-bearing: without win-capture and the hook there is
 * no game capture and the recording would be a black rectangle, without
 * obs-websocket there is no way to start or stop it, and without win-wasapi
 * there is no sound.
 */
const REQUIRED_COMPONENTS: Array<[string, string[]]> = [
  ['the game capture plugin', ['obs-plugins', '64bit', 'win-capture.dll']],
  ['the capture hook', ['data', 'obs-plugins', 'win-capture', 'graphics-hook64.dll']],
  ['the control plugin', ['obs-plugins', '64bit', 'obs-websocket.dll']],
  ['audio capture', ['obs-plugins', '64bit', 'win-wasapi.dll']]
]

function childDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

/** Removes the managed copy. Used when a download left something unusable. */
export function removeManagedObs(): void {
  const root = managedObsRoot()
  rmSync(root, { recursive: true, force: true })
  rmSync(`${root}.staging`, { recursive: true, force: true })
  rmSync(`${root}.zip`, { force: true })
}
