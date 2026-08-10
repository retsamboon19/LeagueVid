import { app } from 'electron'

const HIDDEN_LAUNCH_ARGUMENT = '--hidden'
const LOGIN_ITEM_NAME = 'LeagueVid'

/** Whether this launch came from the login item. */
export function launchedHidden(): boolean {
  return process.argv.includes(HIDDEN_LAUNCH_ARGUMENT) || app.getLoginItemSettings().wasOpenedAsHidden
}

/** Registers or removes LeagueVid as an operating-system login item. */
export function applyLaunchAtLogin(enabled: boolean): void {
  // No-op on platforms where this isn't meaningful, rather than throwing.
  if (process.platform !== 'win32' && process.platform !== 'darwin') return

  // A development session runs through Electron's generic executable and
  // depends on the development server. Registering it for login either opens
  // Electron's launcher or leaves a broken entry after reboot, and can replace
  // the entry belonging to an installed LeagueVid build.
  if (!app.isPackaged) {
    console.warn('[startup] ignored login-item change from a development build')
    return
  }

  // Releases before the login item had a stable name used Electron's default
  // (the executable path on Windows). Remove that legacy value first so an
  // upgrade cannot leave two LeagueVid entries launching at login.
  app.setLoginItemSettings({
    openAtLogin: false,
    openAsHidden: true,
    path: process.execPath,
    args: [HIDDEN_LAUNCH_ARGUMENT]
  })

  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    path: process.execPath,
    args: [HIDDEN_LAUNCH_ARGUMENT],
    name: LOGIN_ITEM_NAME
  })
}
