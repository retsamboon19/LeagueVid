import { app, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { once } from 'events'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import {
  updateIsAvailable,
  type UpdateCheckResult,
  type UpdateInstallResult,
  type UpdateProgress
} from '../shared/updater'
import { buildUpdateHelperScript, startUpdateHelper } from './updateInstaller'
import {
  createReleaseResolver,
  UPDATE_USER_AGENT,
  validateDownloadUrl,
  type ReleaseAsset,
  type ResolvedRelease
} from './updateRelease'

declare const __LEAGUEVID_BUILD_COMMIT__: string

const resolveLatestRelease = createReleaseResolver()

let installInProgress = false

function updaterDir(): string {
  const dir = join(app.getPath('userData'), 'updates')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function githubFetch(url: string): Promise<Response> {
  validateDownloadUrl(url)
  const response = await fetch(url, {
    headers: {
      Accept: '*/*',
      'User-Agent': UPDATE_USER_AGENT
    }
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status} while downloading the update. Please try again later.`)
  return response
}

function validateDownloadResponse(response: Response): void {
  validateDownloadUrl(response.url)
}

function toCheckResult(resolved: ResolvedRelease): UpdateCheckResult {
  const currentVersion = app.getVersion()
  const availability = updateIsAvailable(
    currentVersion,
    resolved.version,
    __LEAGUEVID_BUILD_COMMIT__,
    resolved.commitSha
  )
  return {
    currentVersion,
    latestVersion: resolved.version,
    updateAvailable: availability.available,
    sameVersionRefresh: availability.sameVersionRefresh,
    releaseName: resolved.release.name || `LeagueVid ${resolved.release.tag_name}`,
    releaseNotes: resolved.release.body?.trim() || 'Maintenance improvements and fixes.',
    publishedAt: resolved.release.published_at,
    installerSize: resolved.installer.size,
    releaseUrl: resolved.release.html_url
  }
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const resolved = await resolveLatestRelease()
  return toCheckResult(resolved)
}

function sendProgress(sender: Electron.WebContents, progress: UpdateProgress): void {
  if (!sender.isDestroyed()) sender.send('updater:progress', progress)
}

async function expectedChecksum(asset: ReleaseAsset): Promise<string> {
  const response = await githubFetch(asset.browser_download_url)
  validateDownloadResponse(response)
  const contents = await response.text()
  const match = /\b([a-fA-F0-9]{64})\b/.exec(contents)
  if (!match) throw new Error('The update checksum file is invalid.')
  return match[1].toLowerCase()
}

async function downloadInstaller(
  asset: ReleaseAsset,
  expectedSha256: string,
  sender: Electron.WebContents
): Promise<string> {
  const response = await githubFetch(asset.browser_download_url)
  validateDownloadResponse(response)
  if (!response.body) throw new Error('GitHub returned an empty installer download.')

  const finalPath = join(updaterDir(), asset.name)
  const partialPath = `${finalPath}.partial`
  rmSync(partialPath, { force: true })

  const output = createWriteStream(partialPath, { flags: 'wx' })
  const hash = createHash('sha256')
  let receivedBytes = 0

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      receivedBytes += chunk.byteLength
      hash.update(chunk)
      if (!output.write(chunk)) await once(output, 'drain')
      sendProgress(sender, {
        phase: 'downloading',
        receivedBytes,
        totalBytes: asset.size,
        fraction: asset.size > 0 ? Math.min(1, receivedBytes / asset.size) : null
      })
    }
    output.end()
    await once(output, 'finish')

    if (receivedBytes !== asset.size) throw new Error('The update download was incomplete.')
    sendProgress(sender, {
      phase: 'verifying',
      receivedBytes,
      totalBytes: asset.size,
      fraction: 1
    })

    const actualSha256 = hash.digest('hex')
    if (actualSha256 !== expectedSha256) {
      throw new Error('The downloaded installer failed its security check.')
    }

    rmSync(finalPath, { force: true })
    renameSync(partialPath, finalPath)
    return finalPath
  } catch (error) {
    output.destroy()
    rmSync(partialPath, { force: true })
    throw error
  }
}

async function launchUpdateHelper(installerPath: string): Promise<void> {
  const dir = updaterDir()
  const helperPath = join(dir, 'install-update.ps1')
  const resultPath = join(dir, 'install-result.json')
  const logPath = join(dir, 'install-update.log')
  const bootstrapLogPath = join(dir, 'install-update-bootstrap.log')
  const readyPath = join(dir, 'install-ready')
  const installDirectory = dirname(process.execPath)
  rmSync(resultPath, { force: true })
  rmSync(bootstrapLogPath, { force: true })
  rmSync(readyPath, { force: true })
  writeFileSync(helperPath, buildUpdateHelperScript(), 'utf8')

  const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershellPath = join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )

  try {
    await startUpdateHelper({
      powershellPath,
      helperPath,
      readyPath,
      leagueVidProcessId: process.pid,
      installerPath,
      appPath: process.execPath,
      installDirectory,
      resultPath,
      logPath,
      bootstrapLogPath
    })
  } catch (error) {
    rmSync(helperPath, { force: true })
    rmSync(readyPath, { force: true })
    throw new Error(`The update helper could not start: ${(error as Error).message}`)
  }
}

function takeLastInstallResult(): UpdateInstallResult | null {
  const path = join(updaterDir(), 'install-result.json')
  if (!existsSync(path)) return null

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Partial<UpdateInstallResult>
    if (
      typeof parsed.success !== 'boolean' ||
      typeof parsed.message !== 'string' ||
      typeof parsed.finishedAt !== 'string'
    ) {
      return null
    }
    return parsed as UpdateInstallResult
  } catch {
    return null
  } finally {
    rmSync(path, { force: true })
  }
}

async function downloadAndInstall(sender: Electron.WebContents): Promise<{ restarting: true }> {
  if (installInProgress) throw new Error('An update is already being installed.')
  if (process.platform !== 'win32' || !app.isPackaged) {
    throw new Error('Updates can only be installed from the installed Windows app.')
  }

  installInProgress = true
  try {
    const resolved = await resolveLatestRelease()
    const result = toCheckResult(resolved)
    if (!result.updateAvailable) throw new Error('LeagueVid is already up to date.')

    const sha256 = await expectedChecksum(resolved.checksum)
    const installerPath = await downloadInstaller(resolved.installer, sha256, sender)
    sendProgress(sender, {
      phase: 'launching',
      receivedBytes: resolved.installer.size,
      totalBytes: resolved.installer.size,
      fraction: 1
    })
    await launchUpdateHelper(installerPath)
    setTimeout(() => app.quit(), 350)
    return { restarting: true }
  } finally {
    installInProgress = false
  }
}

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:install', (event) => downloadAndInstall(event.sender))
  ipcMain.handle('updater:lastInstallResult', () => takeLastInstallResult())
}
