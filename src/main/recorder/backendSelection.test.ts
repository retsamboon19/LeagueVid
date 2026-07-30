import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BackendAvailability,
  CaptureBackend,
  CaptureBackendId,
  CaptureHooks,
  CaptureRequest
} from './captureBackend'
import type { CaptureHandle } from './ffmpegProcess'
import {
  activeCaptureBackend,
  clearBackendCache,
  listBackends,
  pinBackend,
  registerBackend,
  reportBackends,
  resetBackendRegistry
} from './backendSelection'

// The fallback chain is the part of this that must not break. If selection
// throws or returns nothing, no game gets recorded at all -- a worse outcome
// than recording with the weaker backend.

function fakeBackend(
  id: CaptureBackendId,
  availability: BackendAvailability | (() => Promise<BackendAvailability>),
  overrides: Partial<CaptureBackend> = {}
): CaptureBackend {
  return {
    id,
    label: `fake ${id}`,
    sessionContainer: 'matroska',
    ownsReplayBuffer: false,
    probe: typeof availability === 'function' ? availability : async () => availability,
    start: async (_request: CaptureRequest, _hooks: CaptureHooks) =>
      ({}) as unknown as CaptureHandle,
    ...overrides
  }
}

describe('backend selection', () => {
  beforeEach(() => {
    // The registry is module state and registration dedupes by id, so without a
    // reset one test's fake backend silently serves the next.
    resetBackendRegistry()
  })

  it('starts with the built-in ffmpeg backend registered', () => {
    expect(listBackends().map((b) => b.id)).toContain('ffmpeg-ddagrab')
  })

  it('prefers a registered backend over the built-in fallback', async () => {
    registerBackend(fakeBackend('obs', { available: true }))
    const active = await activeCaptureBackend()
    expect(active.id).toBe('obs')
  })

  // The whole point of keeping the ffmpeg path: OBS needs binaries that may not
  // be present, and a missing download must not stop recording.
  it('falls back to the built-in path when the preferred backend is unavailable', async () => {
    registerBackend(fakeBackend('obs', { available: false, reason: 'OBS is not installed.' }))
    clearBackendCache()
    const active = await activeCaptureBackend()
    expect(active.id).toBe('ffmpeg-ddagrab')
  })

  // A probe is allowed to fail; selection is not.
  it('treats a throwing probe as unavailable rather than propagating', async () => {
    registerBackend(
      fakeBackend('obs', async () => {
        throw new Error('websocket refused')
      })
    )
    clearBackendCache()
    const active = await activeCaptureBackend()
    expect(active.id).toBe('ffmpeg-ddagrab')
  })

  it('still returns a backend when the only candidate is unavailable', async () => {
    registerBackend(fakeBackend('obs', { available: false, reason: 'OBS is not installed.' }))
    // Pinning leaves exactly one candidate, and it cannot run. There is now no
    // working capture path at all.
    pinBackend('obs')

    const active = await activeCaptureBackend()

    // Returned anyway: failing inside start() puts a real message on the
    // recordings row, whereas returning null would make every caller invent one.
    expect(active.id).toBe('obs')
    expect(typeof active.start).toBe('function')
  })

  it('honours a pinned backend even when a better one is available', async () => {
    registerBackend(fakeBackend('obs', { available: true }))
    pinBackend('ffmpeg-ddagrab')
    const active = await activeCaptureBackend()
    expect(active.id).toBe('ffmpeg-ddagrab')
  })

  it('caches selection so probing does not run on every game start', async () => {
    const probe = vi.fn(async () => ({ available: true }))
    registerBackend(fakeBackend('obs', probe))
    clearBackendCache()

    await activeCaptureBackend()
    await activeCaptureBackend()
    await activeCaptureBackend()

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-probes after the cache is cleared', async () => {
    const probe = vi.fn(async () => ({ available: true }))
    registerBackend(fakeBackend('obs', probe))
    clearBackendCache()

    await activeCaptureBackend()
    clearBackendCache()
    await activeCaptureBackend()

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not register the same backend twice', () => {
    const before = listBackends().length
    registerBackend(fakeBackend('obs', { available: true }))
    registerBackend(fakeBackend('obs', { available: true }))
    expect(listBackends().length).toBe(before + 1)
  })

  it('reports every backend with a reason, and marks the active one', async () => {
    registerBackend(fakeBackend('obs', { available: false, reason: 'OBS is not installed.' }))
    clearBackendCache()

    const report = await reportBackends()
    const obs = report.find((r) => r.id === 'obs')

    expect(obs?.availability.available).toBe(false)
    // An unavailable backend must say why, or the Settings screen has nothing
    // actionable to show.
    expect(obs?.availability.reason).toBeTruthy()
    expect(report.filter((r) => r.active)).toHaveLength(1)
  })
})
