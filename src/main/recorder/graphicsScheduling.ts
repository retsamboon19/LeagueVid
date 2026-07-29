import { exec } from 'child_process'

// Detects whether Hardware-accelerated GPU scheduling is on.
//
// Windows' HAGS moves frame scheduling from the OS to the GPU. It generally
// helps games and generally hurts screen capture: the Desktop Duplication API
// competes with the game for GPU submission slots, and on some driver versions
// that shows up as dropped frames in a capture while the game itself looks fine.
// Outplayed surfaces the same warning, which is a decent signal it isn't
// imaginary.
//
// LeagueVid detects and explains it. It does not change it: the setting lives
// under HKLM, needs administrator rights, and only takes effect after a reboot.
// Flipping a machine-wide graphics setting from a recording app -- silently, and
// then asking for a restart -- is not a reasonable thing to do to someone. The
// warning links them to the right place in Windows Settings instead.

const REGISTRY_PATH =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers'
const REGISTRY_VALUE = 'HwSchMode'

export type GraphicsSchedulingState = 'enabled' | 'disabled' | 'unsupported' | 'unknown'

export interface GraphicsSchedulingReport {
  state: GraphicsSchedulingState
  /** Whether to show the capture-performance warning. */
  shouldWarn: boolean
  message: string | null
}

/**
 * Reads the raw registry value.
 *
 * 2 means enabled, 1 means disabled, and the value being absent means the
 * machine predates the feature -- which is not a problem, so it must not be
 * reported as one.
 */
export function interpretHwSchMode(raw: string | null): GraphicsSchedulingState {
  if (raw == null) return 'unsupported'

  const match = raw.match(/HwSchMode\s+REG_DWORD\s+0x([0-9a-f]+)/i)
  if (!match) return 'unknown'

  const value = Number.parseInt(match[1], 16)
  if (value === 2) return 'enabled'
  if (value === 1) return 'disabled'
  return 'unknown'
}

export function describeGraphicsScheduling(
  state: GraphicsSchedulingState
): GraphicsSchedulingReport {
  if (state === 'enabled') {
    return {
      state,
      shouldWarn: true,
      message:
        'Hardware-accelerated GPU scheduling is on. It can cost you frames in recordings ' +
        'while the game itself still looks smooth, because screen capture ends up competing ' +
        'with the game for the GPU. Turning it off in Windows Settings > System > Display > ' +
        'Graphics > Change default graphics settings often helps. It needs a restart, and ' +
        "LeagueVid won't change a machine-wide graphics setting on your behalf."
    }
  }

  // Every other state is either fine or unknowable, and neither deserves a
  // warning banner. A capture problem that isn't this one is what the preflight
  // test is for.
  return { state, shouldWarn: false, message: null }
}

/** Queries the registry. Any failure reads as unknown rather than throwing. */
export function readGraphicsScheduling(timeoutMs = 4000): Promise<GraphicsSchedulingReport> {
  if (process.platform !== 'win32') {
    return Promise.resolve(describeGraphicsScheduling('unsupported'))
  }

  return new Promise((resolve) => {
    exec(
      `reg query "${REGISTRY_PATH}" /v ${REGISTRY_VALUE}`,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        // reg exits non-zero when the value doesn't exist, which is the
        // 'unsupported' case rather than a failure.
        if (error && !stdout) {
          resolve(describeGraphicsScheduling('unsupported'))
          return
        }
        resolve(describeGraphicsScheduling(interpretHwSchMode(stdout)))
      }
    )
  })
}
