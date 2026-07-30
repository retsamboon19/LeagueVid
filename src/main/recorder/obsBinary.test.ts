import { existsSync, readdirSync } from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Resolution order is the whole behaviour here, and getting it wrong is quiet:
// picking up the user's own OBS install and writing our scene collection into it
// would destroy their setup, and picking a root with no obs64.exe in it turns
// into a spawn failure at the exact moment a game starts.
//
// electron and fs are mocked so every branch can be exercised without installing
// OBS four times over.

const USER_DATA = 'C:\\Users\\Test\\AppData\\Roaming\\leaguevid'
const RESOURCES = 'C:\\Program Files\\LeagueVid\\resources'

const appMock = {
  isPackaged: false,
  getPath: vi.fn(() => USER_DATA),
  getAppPath: vi.fn()
}

vi.mock('electron', () => ({ app: appMock }))
vi.mock('fs', () => ({ existsSync: vi.fn(), readdirSync: vi.fn() }))

async function loadModule(): Promise<typeof import('./obsBinary')> {
  vi.resetModules()
  return import('./obsBinary')
}

/** Marks exactly one distribution root as real, i.e. having obs64.exe. */
function onlyRootExists(root: string): void {
  const executable = `${root}\\bin\\64bit\\obs64.exe`
  vi.mocked(existsSync).mockImplementation((path) => path === executable || path === root)
  vi.mocked(readdirSync).mockReturnValue([])
}

describe('findObsInstall', () => {
  beforeEach(() => {
    appMock.isPackaged = false
    appMock.getPath.mockReturnValue(USER_DATA)
    vi.mocked(existsSync).mockReset()
    vi.mocked(readdirSync).mockReset()
    vi.mocked(readdirSync).mockReturnValue([])
    process.env.ProgramFiles = 'C:\\Program Files'
    Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true })
  })

  it('finds nothing when OBS is not anywhere', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const { findObsInstall } = await loadModule()

    expect(findObsInstall()).toBeNull()
  })

  it('finds the managed copy under userData', async () => {
    const { managedObsRoot } = await loadModule()
    const root = managedObsRoot()
    onlyRootExists(root)

    const { findObsInstall } = await loadModule()
    const install = findObsInstall()

    expect(install?.origin).toBe('managed')
    expect(install?.executable).toBe(`${root}\\bin\\64bit\\obs64.exe`)
  })

  it('falls back to an OBS the user already installed', async () => {
    onlyRootExists('C:\\Program Files\\obs-studio')
    const { findObsInstall } = await loadModule()

    expect(findObsInstall()?.origin).toBe('system')
  })

  // Our managed copy is the one we control the version of, so it wins over
  // whatever the user happens to have.
  it('prefers the managed copy over a system install', async () => {
    const { managedObsRoot } = await loadModule()
    const managed = `${managedObsRoot()}\\bin\\64bit\\obs64.exe`
    const system = 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe'
    vi.mocked(existsSync).mockImplementation((path) => path === managed || path === system)

    const { findObsInstall } = await loadModule()
    expect(findObsInstall()?.origin).toBe('managed')
  })

  it('prefers a sideloaded copy in a packaged build over everything', async () => {
    appMock.isPackaged = true
    const { managedObsRoot } = await loadModule()
    const sideloaded = `${RESOURCES}\\obs\\bin\\64bit\\obs64.exe`
    const managed = `${managedObsRoot()}\\bin\\64bit\\obs64.exe`
    vi.mocked(existsSync).mockImplementation((path) => path === sideloaded || path === managed)

    const { findObsInstall } = await loadModule()
    expect(findObsInstall()?.origin).toBe('sideloaded')
  })

  // A directory is not an install. Accepting one would turn an interrupted
  // download into a spawn failure when a game starts.
  it('rejects a root that exists but has no obs64.exe', async () => {
    const { managedObsRoot } = await loadModule()
    const root = managedObsRoot()
    vi.mocked(existsSync).mockImplementation((path) => path === root)
    vi.mocked(readdirSync).mockReturnValue([])

    const { findObsInstall } = await loadModule()
    expect(findObsInstall()).toBeNull()
  })

  // The portable zip can end up one level deeper than expected, depending on how
  // it was extracted.
  it('looks one level down for a nested distribution root', async () => {
    const { managedObsRoot } = await loadModule()
    const root = managedObsRoot()
    const nested = `${root}\\OBS-Studio-32.2.1`
    vi.mocked(existsSync).mockImplementation(
      (path) => path === root || path === `${nested}\\bin\\64bit\\obs64.exe`
    )
    vi.mocked(readdirSync).mockReturnValue(['OBS-Studio-32.2.1'] as never)

    const { findObsInstall } = await loadModule()
    const install = findObsInstall()

    expect(install?.root).toBe(nested)
    expect(install?.executable).toBe(`${nested}\\bin\\64bit\\obs64.exe`)
  })

  it('reports the bin directory as the working directory, which OBS requires', async () => {
    const { managedObsRoot } = await loadModule()
    const root = managedObsRoot()
    onlyRootExists(root)

    const { findObsInstall } = await loadModule()
    expect(findObsInstall()?.workingDirectory).toBe(`${root}\\bin\\64bit`)
  })

  it('survives a root it cannot read', async () => {
    const { managedObsRoot } = await loadModule()
    vi.mocked(existsSync).mockImplementation((path) => path === managedObsRoot())
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error('EPERM')
    })

    const { findObsInstall } = await loadModule()
    expect(findObsInstall()).toBeNull()
  })
})

describe('obsConfigRoot', () => {
  beforeEach(() => {
    appMock.getPath.mockReturnValue(USER_DATA)
  })

  // The single most important property in this file. OBS run against the user's
  // own configuration directory would have our scene collection, profile and
  // output settings written over theirs.
  it('is under userData, never inside the distribution', async () => {
    const { obsConfigRoot, managedObsRoot } = await loadModule()

    expect(obsConfigRoot().startsWith(USER_DATA)).toBe(true)
    expect(obsConfigRoot().startsWith(managedObsRoot())).toBe(false)
  })
})
