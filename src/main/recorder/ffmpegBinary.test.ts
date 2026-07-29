import { existsSync } from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Verifies the packaged-build path rewrite without producing a packaged build.
//
// The bug this guards against cannot be caught in development, which is the
// whole problem: ffmpeg-static computes its path from its own location inside
// node_modules, and in a packaged app that location is inside app.asar -- an
// archive the OS cannot execute anything from. Clipping has carried this latent
// failure since it was written; recording makes ffmpeg load-bearing.
//
// electron and fs are both mocked so the two branches can be exercised on a
// machine that is, by definition, not running a packaged build.

const DEV_PATH = 'H:\\LeagueVid\\node_modules\\ffmpeg-static\\ffmpeg.exe'
const PACKAGED_PATH =
  'C:\\Program Files\\LeagueVid\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'
const UNPACKED_PATH =
  'C:\\Program Files\\LeagueVid\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe'

const appMock = { isPackaged: false, getPath: vi.fn(), getAppPath: vi.fn() }

vi.mock('electron', () => ({ app: appMock }))
vi.mock('fs', () => ({ existsSync: vi.fn() }))

let bundledPath = DEV_PATH
vi.mock('ffmpeg-static', () => ({
  get default() {
    return bundledPath
  }
}))

async function loadModule(): Promise<typeof import('./ffmpegBinary')> {
  // Fresh module each time, since the resolved path is cached.
  vi.resetModules()
  return import('./ffmpegBinary')
}

describe('ffmpegBinaryPath', () => {
  beforeEach(() => {
    appMock.isPackaged = false
    bundledPath = DEV_PATH
    vi.mocked(existsSync).mockReset()
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\Program Files\\LeagueVid\\resources',
      configurable: true
    })
  })

  it('returns the node_modules path in development', async () => {
    vi.mocked(existsSync).mockImplementation((path) => path === DEV_PATH)
    const { ffmpegBinaryPath } = await loadModule()

    expect(ffmpegBinaryPath()).toBe(DEV_PATH)
  })

  // The actual fix. Without the rewrite this returns a path inside the archive,
  // and spawning it fails with ENOENT on every user's machine while working
  // perfectly in development.
  it('rewrites app.asar to app.asar.unpacked in a packaged build', async () => {
    appMock.isPackaged = true
    bundledPath = PACKAGED_PATH
    vi.mocked(existsSync).mockImplementation((path) => path === UNPACKED_PATH)

    const { ffmpegBinaryPath } = await loadModule()
    expect(ffmpegBinaryPath()).toBe(UNPACKED_PATH)
  })

  it('never returns a path inside the archive', async () => {
    appMock.isPackaged = true
    bundledPath = PACKAGED_PATH
    vi.mocked(existsSync).mockImplementation((path) => path === UNPACKED_PATH)

    const { ffmpegBinaryPath } = await loadModule()
    expect(ffmpegBinaryPath()).not.toContain('app.asar\\')
  })

  // A build that ships ffmpeg as a plain extra resource instead of an unpacked
  // module should still work.
  it('falls back to the resources folder', async () => {
    appMock.isPackaged = true
    bundledPath = PACKAGED_PATH
    const resourcePath = 'C:\\Program Files\\LeagueVid\\resources\\ffmpeg.exe'
    vi.mocked(existsSync).mockImplementation((path) => path === resourcePath)

    const { ffmpegBinaryPath } = await loadModule()
    expect(ffmpegBinaryPath()).toBe(resourcePath)
  })

  it('caches the resolved path rather than checking the disk every spawn', async () => {
    vi.mocked(existsSync).mockImplementation((path) => path === DEV_PATH)
    const { ffmpegBinaryPath } = await loadModule()

    ffmpegBinaryPath()
    const callsAfterFirst = vi.mocked(existsSync).mock.calls.length
    ffmpegBinaryPath()

    expect(vi.mocked(existsSync).mock.calls.length).toBe(callsAfterFirst)
  })

  it('re-resolves after the cache is cleared', async () => {
    vi.mocked(existsSync).mockImplementation((path) => path === DEV_PATH)
    const { ffmpegBinaryPath, resetFfmpegBinaryPathCache } = await loadModule()

    ffmpegBinaryPath()
    resetFfmpegBinaryPathCache()
    const before = vi.mocked(existsSync).mock.calls.length
    ffmpegBinaryPath()

    expect(vi.mocked(existsSync).mock.calls.length).toBeGreaterThan(before)
  })

  // "Encoder not found" on its own gives whoever is debugging it nothing, and
  // the failure differs between development and packaged builds.
  it('names every path it searched when nothing is found', async () => {
    appMock.isPackaged = true
    bundledPath = PACKAGED_PATH
    vi.mocked(existsSync).mockReturnValue(false)

    const { ffmpegBinaryPath } = await loadModule()
    expect(() => ffmpegBinaryPath()).toThrow(/app\.asar\.unpacked/)
    expect(() => ffmpegBinaryPath()).toThrow(/resources/)
  })

  it('reports a build that shipped no encoder at all', async () => {
    bundledPath = '' as unknown as string
    const { ffmpegBinaryPath } = await loadModule()

    expect(() => ffmpegBinaryPath()).toThrow(/missing from this build/)
  })
})
