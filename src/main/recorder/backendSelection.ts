import type { BackendAvailability, CaptureBackend, CaptureBackendId } from './captureBackend'
import { ffmpegBackend } from './ffmpegBackend'

// Decides which capture backend records the next session.
//
// Order is by capability, not preference: OBS's game capture reads the game's
// own frames, the ffmpeg path scrapes the desktop and cannot see a game in
// exclusive fullscreen at all. So OBS wins whenever it resolves, and ffmpeg is
// what remains when it does not -- a working recording beats no recording.
//
// The result is cached because probing spawns a process, and re-probing on every
// game start would add seconds to the one moment that is latency-sensitive. It
// is not cached across a settings change that pins a backend, which is why
// clearBackendCache exists.

/**
 * Every backend, most capable first.
 *
 * OBS is appended by registerBackend rather than imported, so that this module
 * -- and therefore the recorder -- does not depend on the OBS integration
 * existing. That keeps the fallback genuinely independent: a fault in the OBS
 * backend cannot stop the built-in one from loading.
 */
const backends: CaptureBackend[] = [ffmpegBackend]

export function registerBackend(backend: CaptureBackend): void {
  if (backends.some((existing) => existing.id === backend.id)) return
  // Unshifted, not pushed: a registered backend is a more capable capture
  // technology than the built-in fallback, which stays last by construction.
  backends.unshift(backend)
  cached = null
}

/**
 * Testing / re-probing hook: drops everything but the built-in fallback.
 *
 * Follows the resetFfmpegBinaryPathCache precedent. Needed because the registry
 * is module state, so without it one test's backend is still registered for the
 * next -- and registration dedupes by id, which makes those leaks silent.
 */
export function resetBackendRegistry(): void {
  backends.length = 0
  backends.push(ffmpegBackend)
  cached = null
  pinned = null
}

export function listBackends(): CaptureBackend[] {
  return [...backends]
}

let cached: CaptureBackend | null = null
let pinned: CaptureBackendId | null = null

/**
 * Forces a specific backend, or returns to automatic selection with null.
 *
 * Worth having because the two backends fail in different ways, and someone
 * debugging a capture problem needs to be able to take one out of the picture.
 */
export function pinBackend(id: CaptureBackendId | null): void {
  pinned = id
  cached = null
}

export function pinnedBackend(): CaptureBackendId | null {
  return pinned
}

export function clearBackendCache(): void {
  cached = null
}

/**
 * The backend the next recording will use.
 *
 * Falls through to the next candidate when one probes unavailable. The last
 * entry is returned even if it probes unavailable too: at that point there is no
 * working capture path, and failing inside start() produces a real error message
 * on the recordings row, whereas returning null here would need every caller to
 * invent one.
 */
export async function activeCaptureBackend(): Promise<CaptureBackend> {
  if (cached) return cached

  const candidates = pinned ? backends.filter((backend) => backend.id === pinned) : backends
  const ordered = candidates.length > 0 ? candidates : backends

  for (const backend of ordered) {
    const availability = await safeProbe(backend)
    if (availability.available) {
      cached = backend
      return backend
    }
  }

  cached = ordered[ordered.length - 1]
  return cached
}

export interface BackendReport {
  id: CaptureBackendId
  label: string
  availability: BackendAvailability
  active: boolean
}

/** Every backend and why it can or cannot be used, for the Settings screen. */
export async function reportBackends(): Promise<BackendReport[]> {
  const active = await activeCaptureBackend()
  return Promise.all(
    backends.map(async (backend) => ({
      id: backend.id,
      label: backend.label,
      availability: await safeProbe(backend),
      active: backend.id === active.id
    }))
  )
}

/**
 * A probe that throws is a probe that failed.
 *
 * Without this, one backend whose availability check hits an unexpected error
 * takes down selection entirely and nothing records -- the opposite of what a
 * fallback chain is for.
 */
async function safeProbe(backend: CaptureBackend): Promise<BackendAvailability> {
  try {
    return await backend.probe()
  } catch (err) {
    return { available: false, reason: (err as Error).message }
  }
}
