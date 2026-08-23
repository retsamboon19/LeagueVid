import { execFileSync } from 'child_process'
import type { CaptureScope } from './captureBackend'

// Programs in this list inject their own graphics hooks into games. OBS calls
// out RTSS / MSI Afterburner specifically as a Game Capture conflict, and this
// machine produced full-length files containing one stale League frame while
// both were active. The encoder counters remained healthy because OBS still
// composited its own cursor over that stale texture, so counters cannot protect
// us from this failure.
const GAME_HOOK_CONFLICTS: ReadonlyArray<{ executable: string; label: string }> = [
  { executable: 'rtss.exe', label: 'RivaTuner Statistics Server' },
  { executable: 'rtsshooksloader.exe', label: 'RivaTuner Statistics Server' },
  { executable: 'rtsshooksloader64.exe', label: 'RivaTuner Statistics Server' },
  { executable: 'msiafterburner.exe', label: 'MSI Afterburner' }
]

/**
 * Process names from tasklist.
 *
 * Kept best-effort: failing to inspect processes must not prevent a recording
 * from starting. tasklist is part of Windows and avoids adding another native
 * dependency to the Electron build.
 */
export function runningProcessNames(): string[] {
  if (process.platform !== 'win32') return []

  try {
    const output = execFileSync('tasklist.exe', ['/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })

    return output
      .split(/\r?\n/)
      .map((line) => /^"([^"]+)"/.exec(line)?.[1] ?? '')
      .filter(Boolean)
  } catch {
    return []
  }
}

export interface SafeCaptureScope {
  scope: CaptureScope
  /** Human-readable, de-duplicated names of programs that forced fallback. */
  conflicts: string[]
}

/**
 * Avoids OBS Game Capture when another known graphics hook is already active.
 *
 * OBS Windows Graphics Capture does not inject into League, so it cannot get
 * stuck on the one shared texture the conflicting hooks left behind. Manual
 * recording already requests display capture and passes through unchanged.
 */
export function safeCaptureScope(
  requested: CaptureScope,
  processNames: readonly string[] = runningProcessNames()
): SafeCaptureScope {
  if (requested.kind !== 'game') return { scope: requested, conflicts: [] }

  const running = new Set(processNames.map((name) => name.toLowerCase()))
  const conflicts = [
    ...new Set(
      GAME_HOOK_CONFLICTS.filter(({ executable }) => running.has(executable)).map(
        ({ label }) => label
      )
    )
  ]

  return conflicts.length > 0
    ? { scope: { kind: 'display' }, conflicts }
    : { scope: requested, conflicts: [] }
}
