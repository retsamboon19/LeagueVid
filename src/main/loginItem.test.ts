import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: false,
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn()
  }
}))

vi.mock('electron', () => ({ app: appMock }))

import { applyLaunchAtLogin } from './loginItem'

describe('login item registration', () => {
  beforeEach(() => {
    appMock.isPackaged = false
    appMock.getLoginItemSettings.mockReset()
    appMock.setLoginItemSettings.mockReset()
  })

  it('does not let a development Electron session replace the installed startup entry', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    applyLaunchAtLogin(true)

    expect(appMock.setLoginItemSettings).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(
      '[startup] ignored login-item change from a development build'
    )
    warning.mockRestore()
  })

  it('registers the dedicated LeagueVid executable in a packaged build', () => {
    appMock.isPackaged = true

    applyLaunchAtLogin(true)

    expect(appMock.setLoginItemSettings).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      openAsHidden: true,
      path: process.execPath,
      args: ['--hidden']
    })
    expect(appMock.setLoginItemSettings).toHaveBeenNthCalledWith(2, {
      openAtLogin: true,
      openAsHidden: true,
      path: process.execPath,
      args: ['--hidden'],
      name: 'LeagueVid'
    })
  })

  it('can remove the login item from a packaged build', () => {
    appMock.isPackaged = true

    applyLaunchAtLogin(false)

    expect(appMock.setLoginItemSettings).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      openAsHidden: true,
      path: process.execPath,
      args: ['--hidden']
    })
    expect(appMock.setLoginItemSettings).toHaveBeenNthCalledWith(2, {
      openAtLogin: false,
      openAsHidden: true,
      path: process.execPath,
      args: ['--hidden'],
      name: 'LeagueVid'
    })
  })
})
