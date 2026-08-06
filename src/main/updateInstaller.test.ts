import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { join } from 'path'
import { buildUpdateHelperScript } from './updateInstaller'

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
  })

  it('always records a result and reopens LeagueVid visibly', () => {
    const script = buildUpdateHelperScript()
    expect(script).toContain('[IO.File]::WriteAllText($ResultPath')
    expect(script).toContain("Start-Process -FilePath $AppPath -ArgumentList '--updated'")
    expect(script).not.toContain(
      "Start-Process -FilePath $AppPath -ArgumentList '--updated' -WindowStyle Hidden"
    )
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
    const powershell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const result = spawnSync(powershell, ['-NoProfile', '-Command', parseCommand], {
      encoding: 'utf8'
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)
  })
})
