import { spawn, type ChildProcess } from 'child_process'
import { once } from 'events'
import { closeSync, existsSync, openSync, rmSync } from 'fs'

const HELPER_READY_POLL_MS = 25
const HELPER_READY_TIMEOUT_MS = 15_000

/**
 * Waits until the detached PowerShell process has actually begun executing the
 * helper script. A successful OS spawn is not enough on Windows: PowerShell can
 * take longer to initialize than the app's shutdown delay and be killed before
 * it runs its first line.
 */
export function waitForUpdateHelperReady(
  helper: ChildProcess,
  readyPath: string,
  timeoutMs = HELPER_READY_TIMEOUT_MS,
  successfulLauncherExitCanContinue = false
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      clearInterval(poll)
      clearTimeout(timeout)
      helper.off('error', onError)
      helper.off('exit', onExit)
    }

    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onError = (error: Error): void => {
      fail(error)
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      // A very fast helper can finish between two polls. Its ready marker is
      // deliberately left for this side to acknowledge, so completion after
      // readiness is still success rather than a false startup failure.
      if (existsSync(readyPath)) {
        succeed()
        return
      }
      // The bootstrap process exits as soon as Windows has accepted the
      // independent helper. Keep polling for the helper's own ready marker.
      if (successfulLauncherExitCanContinue && code === 0 && signal == null) return
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      fail(new Error(`The update helper exited before becoming ready (${detail}).`))
    }

    const checkReady = (): void => {
      if (existsSync(readyPath)) succeed()
    }

    const poll = setInterval(checkReady, HELPER_READY_POLL_MS)
    const timeout = setTimeout(() => {
      fail(new Error('The update helper did not become ready within 15 seconds.'))
    }, timeoutMs)

    helper.once('error', onError)
    helper.once('exit', onExit)

    if (helper.exitCode !== null) onExit(helper.exitCode, helper.signalCode)
    else checkReady()
  })
}

export interface UpdateHelperLaunchOptions {
  powershellPath: string
  helperPath: string
  readyPath: string
  leagueVidProcessId: number
  installerPath: string
  appPath: string
  installDirectory: string
  resultPath: string
  logPath: string
  bootstrapLogPath?: string
}

/**
 * Encodes the invocation as one argument instead of asking Electron's embedded
 * Node runtime to quote a list of Windows paths for powershell.exe. The latter
 * can exit successfully without ever executing -File when launched detached
 * from Electron, even though the same argv works from standalone Node.
 */
function encodedHelperCommand(options: UpdateHelperLaunchOptions): string {
  const payload = Buffer.from(
    JSON.stringify({
      helperPath: options.helperPath,
      readyPath: options.readyPath,
      leagueVidProcessId: options.leagueVidProcessId,
      installerPath: options.installerPath,
      appPath: options.appPath,
      installDirectory: options.installDirectory,
      resultPath: options.resultPath,
      logPath: options.logPath
    }),
    'utf8'
  ).toString('base64')
  const command = [
    `$updateJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$update = $updateJson | ConvertFrom-Json',
    '$arguments = @{',
    '  LeagueVidProcessId = [int]$update.leagueVidProcessId',
    '  InstallerPath = [string]$update.installerPath',
    '  AppPath = [string]$update.appPath',
    '  InstallDirectory = [string]$update.installDirectory',
    '  ResultPath = [string]$update.resultPath',
    '  LogPath = [string]$update.logPath',
    '  ReadyPath = [string]$update.readyPath',
    '}',
    '& $update.helperPath @arguments'
  ].join('\r\n')
  return Buffer.from(command, 'utf16le').toString('base64')
}

function encodedBootstrapCommand(options: UpdateHelperLaunchOptions): string {
  const payload = Buffer.from(
    JSON.stringify({
      powershellPath: options.powershellPath,
      helperCommand: encodedHelperCommand(options)
    }),
    'utf8'
  ).toString('base64')
  const command = [
    `$launchJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$launch = $launchJson | ConvertFrom-Json',
    '$arguments = @(',
    "  '-NoProfile',",
    "  '-ExecutionPolicy',",
    "  'Bypass',",
    "  '-WindowStyle',",
    "  'Hidden',",
    "  '-EncodedCommand',",
    '  [string]$launch.helperCommand',
    ')',
    'Start-Process -FilePath $launch.powershellPath -ArgumentList $arguments -WindowStyle Hidden'
  ].join('\r\n')
  return Buffer.from(command, 'utf16le').toString('base64')
}

/** Starts the real detached helper and does not return until it is executing. */
export async function startUpdateHelper(options: UpdateHelperLaunchOptions): Promise<void> {
  const bootstrapLog = options.bootstrapLogPath
    ? openSync(options.bootstrapLogPath, 'a')
    : null
  const stdio: 'ignore' | ['ignore', number, number] =
    bootstrapLog == null ? 'ignore' : ['ignore', bootstrapLog, bootstrapLog]
  let helperLauncher: ChildProcess
  try {
    helperLauncher = spawn(
      options.powershellPath,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodedBootstrapCommand(options)
      ],
      { stdio, windowsHide: true }
    )
  } finally {
    if (bootstrapLog != null) closeSync(bootstrapLog)
  }

  try {
    await once(helperLauncher, 'spawn')
    await waitForUpdateHelperReady(helperLauncher, options.readyPath, undefined, true)
  } catch (error) {
    try {
      helperLauncher.kill()
    } catch {}
    rmSync(options.readyPath, { force: true })
    throw error
  }

  rmSync(options.readyPath, { force: true })
  helperLauncher.unref()
}

/**
 * Builds the small PowerShell hand-off used after Electron exits.
 *
 * Keeping it separate from updater.ts makes the safety-critical behavior easy
 * to test without importing Electron in Vitest's plain Node environment.
 */
export function buildUpdateHelperScript(): string {
  return [
    'param(',
    '  [int]$LeagueVidProcessId,',
    '  [string]$InstallerPath,',
    '  [string]$AppPath,',
    '  [string]$InstallDirectory,',
    '  [string]$ResultPath,',
    '  [string]$LogPath,',
    '  [string]$ReadyPath',
    ')',
    "$ErrorActionPreference = 'Stop'",
    "$success = $false",
    "$message = 'The update did not finish.'",
    '$updateTemp = $InstallDirectory + \'.__leaguevid_update_temp\'',
    '',
    'function Write-UpdateLog([string]$Text) {',
    '  Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToUniversalTime().ToString(\'o\') + \' \' + $Text) -Encoding UTF8',
    '}',
    '',
    'try {',
    "  Set-Content -LiteralPath $LogPath -Value 'LeagueVid update helper started.' -Encoding UTF8",
    '  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {',
    "    throw 'The downloaded installer could not be found.'",
    '  }',
    "  [IO.File]::WriteAllText($ReadyPath, 'ready', [Text.UTF8Encoding]::new($false))",
    "  Write-UpdateLog 'Update helper is ready; waiting for LeagueVid to close.'",
    '',
    '  Wait-Process -Id $LeagueVidProcessId -ErrorAction SilentlyContinue',
    '',
    '  $processName = [IO.Path]::GetFileNameWithoutExtension($AppPath)',
    '  for ($attempt = 0; $attempt -lt 150; $attempt++) {',
    '    $remaining = @(',
    '      Get-Process -Name $processName -ErrorAction SilentlyContinue |',
    '        Where-Object { $_.Path -eq $AppPath }',
    '    )',
    '    if ($remaining.Count -eq 0) { break }',
    '    Start-Sleep -Milliseconds 100',
    '  }',
    '  if ($remaining.Count -gt 0) {',
    "    throw 'LeagueVid did not finish closing within 15 seconds.'",
    '  }',
    '',
    '  # electron-builder stages an old installation through the temp drive.',
    '  # Put that staging area beside a custom installation so an H: install',
    '  # is never asked to perform an impossible atomic rename through C:.',
    '  New-Item -ItemType Directory -Path $updateTemp -Force | Out-Null',
    '  $env:TEMP = $updateTemp',
    '  $env:TMP = $updateTemp',
    '',
    "  Write-UpdateLog ('Starting installer in ' + $InstallDirectory)",
    '  # The installer reads the existing custom directory from its registry',
    '  # entry. Passing /D here is unsafe because Start-Process can split a',
    '  # directory containing spaces into a different path.',
    '  $arguments = @(\'/S\', \'/currentuser\', \'--force-run\')',
    '  $installer = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -PassThru -WindowStyle Hidden',
    '  # Process.WaitForExit waits for the installer itself. PowerShell\'s',
    '  # Start-Process -Wait also follows the restarted LeagueVid descendant',
    '  # and would therefore keep the update helper alive indefinitely.',
    '  $installer.WaitForExit()',
    "  Write-UpdateLog ('Installer exit code: ' + $installer.ExitCode)",
    '  if ($installer.ExitCode -ne 0) {',
    "    throw ('The installer exited with code ' + $installer.ExitCode + '.')",
    '  }',
    '',
    '  $success = $true',
    "  $message = 'The update was installed successfully.'",
    '} catch {',
    "  $message = 'The update could not be installed: ' + $_.Exception.Message + ' Details: ' + $LogPath",
    '  try { Write-UpdateLog $message } catch {}',
    '} finally {',
    '  try {',
    '    $result = [ordered]@{',
    '      success = $success',
    '      message = $message',
    "      finishedAt = (Get-Date).ToUniversalTime().ToString('o')",
    '    }',
    '    $json = $result | ConvertTo-Json -Compress',
    '    [IO.File]::WriteAllText($ResultPath, $json, [Text.UTF8Encoding]::new($false))',
    '  } catch {',
    "    try { Write-UpdateLog ('Could not save update result: ' + $_.Exception.Message) } catch {}",
    '  }',
    '',
    '  # Reopen even after failure so the user sees the result instead of being',
    '  # left with an app that silently disappeared.',
    '  try {',
    "    Start-Process -FilePath $AppPath -ArgumentList '--updated'",
    '  } catch {',
    "    try { Write-UpdateLog ('Could not reopen LeagueVid: ' + $_.Exception.Message) } catch {}",
    '  }',
    '',
    '  try { Remove-Item -LiteralPath $updateTemp -Recurse -Force -ErrorAction SilentlyContinue } catch {}',
    '  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '}'
  ].join('\r\n')
}
