import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { once } from 'events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSync } from 'esbuild'
import { buildUpdateHelperScript, waitForUpdateHelperReady } from './updateInstaller'

const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<unknown[]> {
  if (child.exitCode !== null) return [child.exitCode, child.signalCode]
  return Promise.race([
    once(child, 'exit'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for child process to exit.')), timeoutMs)
    )
  ])
}

describe('update installer hand-off', () => {
  it('waits for every app process and stages cross-drive upgrades beside the install', () => {
    const script = buildUpdateHelperScript()
    expect(script).toContain('LeagueVid did not finish closing within 15 seconds.')
    expect(script).toContain("$updateTemp = $InstallDirectory + '.__leaguevid_update_temp'")
    expect(script).toContain('$env:TEMP = $updateTemp')
  })

  it('lets the installer reuse its registered custom directory', () => {
    const script = buildUpdateHelperScript()
    expect(script).toContain("$arguments = @('/S', '/currentuser', '--force-run')")
    expect(script).not.toContain("'/D=' + $InstallDirectory")
    expect(script).toContain('$installer.WaitForExit()')
    expect(script).not.toContain('-Wait -PassThru')
  })

  it('always records a result and reopens LeagueVid visibly', () => {
    const script = buildUpdateHelperScript()
    expect(script).toContain('[IO.File]::WriteAllText($ResultPath')
    expect(script).toContain("Start-Process -FilePath $AppPath -ArgumentList '--updated'")
    expect(script).not.toContain(
      "Start-Process -FilePath $AppPath -ArgumentList '--updated' -WindowStyle Hidden"
    )
  })

  it('signals readiness before waiting for LeagueVid to exit', () => {
    const script = buildUpdateHelperScript()
    const readyIndex = script.indexOf("[IO.File]::WriteAllText($ReadyPath, 'ready'")
    const waitIndex = script.indexOf('Wait-Process -Id $LeagueVidProcessId')

    expect(readyIndex).toBeGreaterThan(0)
    expect(waitIndex).toBeGreaterThan(readyIndex)
  })

  it.skipIf(process.platform !== 'win32')('is valid Windows PowerShell syntax', () => {
    const script = buildUpdateHelperScript()
    const encodedScript = Buffer.from(script, 'utf8').toString('base64')
    const parseCommand = [
      '$parseErrors = $null',
      `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedScript}'))`,
      '[Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$parseErrors) | Out-Null',
      "if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
    ].join('; ')
    const result = spawnSync(powershell, ['-NoProfile', '-Command', parseCommand], {
      encoding: 'utf8'
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)
  })

  it.skipIf(process.platform !== 'win32')(
    'runs the installer only after the parent exits and then reopens the app',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'leaguevid-update-test-'))
      const installDirectory = join(root, 'LeagueVid Main')
      const updateDirectory = join(root, 'updates')
      const helperPath = join(updateDirectory, 'install-update.ps1')
      const installerPath = join(updateDirectory, 'fake-installer.cmd')
      const appPath = join(updateDirectory, 'fake-leaguevid.cmd')
      const installerMarker = join(updateDirectory, 'installer-ran.txt')
      const appMarker = join(updateDirectory, 'app-reopened.txt')
      const resultPath = join(updateDirectory, 'install-result.json')
      const logPath = join(updateDirectory, 'install-update.log')
      const readyPath = join(updateDirectory, 'install-ready')
      let parent: ChildProcess | null = null
      let helper: ChildProcess | null = null

      try {
        mkdirSync(installDirectory)
        mkdirSync(updateDirectory)
        writeFileSync(helperPath, buildUpdateHelperScript(), 'utf8')
        writeFileSync(
          installerPath,
          '@echo off\r\n> "%~dp0installer-ran.txt" echo %*\r\nexit /b 0\r\n',
          'utf8'
        )
        writeFileSync(
          appPath,
          '@echo off\r\n> "%~dp0app-reopened.txt" echo %*\r\nexit /b 0\r\n',
          'utf8'
        )

        parent = spawn(powershell, ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30'], {
          stdio: 'ignore',
          windowsHide: true
        })
        await once(parent, 'spawn')
        expect(parent.pid).toBeTypeOf('number')

        helper = spawn(
          powershell,
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-WindowStyle',
            'Hidden',
            '-File',
            helperPath,
            '-LeagueVidProcessId',
            String(parent.pid),
            '-InstallerPath',
            installerPath,
            '-AppPath',
            appPath,
            '-InstallDirectory',
            installDirectory,
            '-ResultPath',
            resultPath,
            '-LogPath',
            logPath,
            '-ReadyPath',
            readyPath
          ],
          { stdio: 'ignore', windowsHide: true }
        )
        await once(helper, 'spawn')
        await waitForUpdateHelperReady(helper, readyPath)

        expect(existsSync(installerMarker)).toBe(false)

        parent.kill()
        await waitForExit(helper)
        await waitForFile(installerMarker)
        await waitForFile(appMarker)

        const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
          success: boolean
          message: string
        }
        expect(result.success, result.message).toBe(true)
        expect(readFileSync(installerMarker, 'utf8')).toContain('/S /currentuser --force-run')
        expect(readFileSync(appMarker, 'utf8')).toContain('--updated')
      } finally {
        if (helper && helper.exitCode === null) helper.kill()
        if (parent && parent.exitCode === null) parent.kill()
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it.skipIf(process.platform !== 'win32')(
    'survives an actual Electron parent exiting after the readiness handshake',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'leaguevid-electron-update-test-'))
      const installDirectory = join(root, 'LeagueVid Main')
      const updateDirectory = join(root, 'updates')
      const electronAppDirectory = join(root, 'electron-app')
      const helperPath = join(updateDirectory, 'install-update.ps1')
      const installerPath = join(updateDirectory, 'fake-installer.cmd')
      const appPath = join(updateDirectory, 'fake-leaguevid.cmd')
      const installerMarker = join(updateDirectory, 'installer-ran.txt')
      const appMarker = join(updateDirectory, 'app-reopened.txt')
      const resultPath = join(updateDirectory, 'install-result.json')
      const logPath = join(updateDirectory, 'install-update.log')
      const readyPath = join(updateDirectory, 'install-ready')
      const errorPath = join(updateDirectory, 'electron-error.txt')
      const bootstrapLogPath = join(updateDirectory, 'bootstrap.log')
      let electronProcess: ChildProcess | null = null

      try {
        mkdirSync(installDirectory)
        mkdirSync(updateDirectory)
        mkdirSync(electronAppDirectory)
        writeFileSync(helperPath, buildUpdateHelperScript(), 'utf8')
        writeFileSync(
          installerPath,
          '@echo off\r\n> "%~dp0installer-ran.txt" echo %*\r\nexit /b 0\r\n',
          'utf8'
        )
        writeFileSync(
          appPath,
          '@echo off\r\n> "%~dp0app-reopened.txt" echo %*\r\nexit /b 0\r\n',
          'utf8'
        )

        buildSync({
          entryPoints: [join(process.cwd(), 'src', 'main', 'updateInstaller.ts')],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          outfile: join(electronAppDirectory, 'updateInstaller.cjs'),
          logLevel: 'silent'
        })
        writeFileSync(
          join(electronAppDirectory, 'package.json'),
          JSON.stringify({ name: 'leaguevid-update-handoff-test', version: '1.0.0', main: 'main.js' }),
          'utf8'
        )
        writeFileSync(
          join(electronAppDirectory, 'handoff.json'),
          JSON.stringify({
            powershellPath: powershell,
            helperPath,
            readyPath,
            installerPath,
            appPath,
            installDirectory,
            resultPath,
            logPath,
            errorPath,
            bootstrapLogPath
          }),
          'utf8'
        )
        writeFileSync(
          join(electronAppDirectory, 'main.js'),
          [
            "const { app } = require('electron')",
            "const { readFileSync, writeFileSync } = require('fs')",
            "const { join } = require('path')",
            "const { startUpdateHelper } = require('./updateInstaller.cjs')",
            "const options = JSON.parse(readFileSync(join(__dirname, 'handoff.json'), 'utf8'))",
            'app.whenReady()',
            '  .then(async () => {',
            '    await startUpdateHelper({ ...options, leagueVidProcessId: process.pid })',
            '    app.quit()',
            '  })',
            '  .catch((error) => {',
            "    writeFileSync(options.errorPath, error.stack || String(error), 'utf8')",
            '    app.exit(1)',
            '  })'
          ].join('\r\n'),
          'utf8'
        )

        const electronPath = join(
          process.cwd(),
          'node_modules',
          'electron',
          'dist',
          'electron.exe'
        )
        const electronEnvironment = { ...process.env }
        delete electronEnvironment.ELECTRON_RUN_AS_NODE
        electronProcess = spawn(electronPath, [electronAppDirectory], {
          stdio: 'ignore',
          windowsHide: true,
          env: electronEnvironment
        })
        await once(electronProcess, 'spawn')
        let exitCode: unknown
        try {
          ;[exitCode] = await waitForExit(electronProcess, 25_000)
        } catch (error) {
          const diagnostic = [
            existsSync(errorPath) ? readFileSync(errorPath, 'utf8') : '',
            existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
            existsSync(bootstrapLogPath) ? readFileSync(bootstrapLogPath, 'utf8') : '',
            existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : ''
          ]
            .filter(Boolean)
            .join('\n')
          throw new Error(`${(error as Error).message}\n${diagnostic}`)
        }

        const diagnostic = [
          existsSync(errorPath) ? readFileSync(errorPath, 'utf8') : '',
          existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
          existsSync(bootstrapLogPath) ? readFileSync(bootstrapLogPath, 'utf8') : '',
          existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : ''
        ]
          .filter(Boolean)
          .join('\n')
        expect(exitCode, diagnostic).toBe(0)
        await waitForFile(resultPath, 15_000)
        await waitForFile(installerMarker)
        await waitForFile(appMarker)

        const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
          success: boolean
          message: string
        }
        expect(result.success, result.message).toBe(true)
        expect(readFileSync(logPath, 'utf8')).toContain('Installer exit code: 0')
        expect(readFileSync(installerMarker, 'utf8')).toContain('/S /currentuser --force-run')
        expect(readFileSync(appMarker, 'utf8')).toContain('--updated')
      } finally {
        if (electronProcess && electronProcess.exitCode === null) electronProcess.kill()
        rmSync(root, { recursive: true, force: true })
      }
    },
    45_000
  )
})
