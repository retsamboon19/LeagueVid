import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The install path matters more than most: it is what every user who does not
// already have OBS will run, and it writes half a gigabyte to their disk.
//
// The download itself is opt-in rather than part of the normal suite -- 180 MB
// per run is not something to inflict on `npm test`. Set LEAGUEVID_TEST_OBS_DOWNLOAD=1
// to include it. Everything that can be checked without the network is checked
// unconditionally.

const USER_DATA = join(tmpdir(), `leaguevid-installer-test-${process.pid}`)

const appMock = {
  isPackaged: false,
  getPath: vi.fn(() => USER_DATA),
  getAppPath: vi.fn()
}

vi.mock('electron', () => ({ app: appMock }))

async function loadModules(): Promise<{
  installer: typeof import('./obsInstaller')
  binary: typeof import('./obsBinary')
}> {
  vi.resetModules()
  return {
    installer: await import('./obsInstaller'),
    binary: await import('./obsBinary')
  }
}

afterAll(() => {
  rmSync(USER_DATA, { recursive: true, force: true })
})

describe('downloadUrl', () => {
  it('points at the official portable build for the managed version', async () => {
    const { installer, binary } = await loadModules()
    const url = installer.downloadUrl()

    expect(url).toBe(
      `https://github.com/obsproject/obs-studio/releases/download/${binary.MANAGED_OBS_VERSION}/` +
        `OBS-Studio-${binary.MANAGED_OBS_VERSION}-Windows-x64.zip`
    )
  })

  // Downloading a 466 MB executable payload is not something to do over a
  // channel nothing can vouch for.
  it('is https', async () => {
    const { installer } = await loadModules()
    expect(installer.downloadUrl().startsWith('https://')).toBe(true)
  })
})

describe('installManagedObs when OBS is already there', () => {
  beforeEach(() => {
    rmSync(USER_DATA, { recursive: true, force: true })
  })

  // The short circuit that keeps a settings screen from re-downloading 180 MB
  // every time someone opens it.
  it('returns the existing copy without downloading', async () => {
    const { installer, binary } = await loadModules()

    const root = binary.managedObsRoot()
    mkdirSync(join(root, 'bin', '64bit'), { recursive: true })
    writeFileSync(join(root, 'bin', '64bit', 'obs64.exe'), '')

    const result = await installer.installManagedObs()

    expect(result.alreadyPresent).toBe(true)
    expect(result.install.root).toBe(root)
    // Nothing was fetched, so no archive was ever written beside it.
    expect(existsSync(`${root}.zip`)).toBe(false)
  })

  it('reports that nothing is in flight when idle', async () => {
    const { installer } = await loadModules()
    expect(installer.isInstalling()).toBe(false)
  })
})

describe('removeManagedObs', () => {
  it('clears the install and any leftover staging', async () => {
    const { installer, binary } = await loadModules()
    const root = binary.managedObsRoot()

    mkdirSync(join(root, 'bin', '64bit'), { recursive: true })
    writeFileSync(join(root, 'bin', '64bit', 'obs64.exe'), '')
    mkdirSync(`${root}.staging`, { recursive: true })
    writeFileSync(`${root}.zip`, '')

    installer.removeManagedObs()

    expect(existsSync(root)).toBe(false)
    expect(existsSync(`${root}.staging`)).toBe(false)
    expect(existsSync(`${root}.zip`)).toBe(false)
  })
})

// The real thing: download, extract with Windows' tar, verify the components and
// publish. Opt-in because of the size.
describe.runIf(process.env.LEAGUEVID_TEST_OBS_DOWNLOAD === '1')(
  'installManagedObs end to end',
  () => {
    it(
      'downloads, extracts and produces a usable OBS',
      async () => {
        const { installer, binary } = await loadModules()
        rmSync(USER_DATA, { recursive: true, force: true })

        const phases: string[] = []
        const result = await installer.installManagedObs((progress) => {
          if (!phases.includes(progress.phase)) phases.push(progress.phase)
        })

        expect(result.alreadyPresent).toBe(false)
        expect(phases).toContain('downloading')
        expect(phases).toContain('extracting')
        expect(phases).toContain('verifying')

        // Resolvable through the normal path, not just returned.
        const found = binary.findObsInstall()
        expect(found?.root).toBe(result.install.root)
        expect(existsSync(result.install.executable)).toBe(true)

        // The components that make it worth having at all.
        const root = result.install.root
        expect(existsSync(join(root, 'obs-plugins', '64bit', 'win-capture.dll'))).toBe(true)
        expect(
          existsSync(join(root, 'data', 'obs-plugins', 'win-capture', 'graphics-hook64.dll'))
        ).toBe(true)
        expect(existsSync(join(root, 'obs-plugins', '64bit', 'obs-websocket.dll'))).toBe(true)
        expect(existsSync(join(root, 'obs-plugins', '64bit', 'win-wasapi.dll'))).toBe(true)

        // Staging and the archive are cleaned up, not left costing 650 MB.
        expect(existsSync(`${root}.staging`)).toBe(false)
        expect(existsSync(`${root}.zip`)).toBe(false)
      },
      // A 180 MB download on a slow connection.
      15 * 60 * 1000
    )
  }
)
