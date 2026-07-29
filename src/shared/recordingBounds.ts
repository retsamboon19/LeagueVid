// Bounds for the values the user can type rather than pick.
//
// A dropdown constrains itself; a text field does not. These are the two
// settings where a typo is expensive: a bitrate with an extra zero fills a drive
// in an afternoon, and a minimum-length rule set to hours would silently throw
// away every recording the app makes.
//
// Shared so the field can clamp as the user types and the main process can clamp
// again before spawning ffmpeg. Trusting the renderer would be fine today and
// wrong the moment anything else writes these settings.

/** Below this, H.264 at any useful resolution is unwatchable. */
export const MIN_BITRATE_KBPS = 500

/**
 * Above this, the file grows faster than any consumer drive wants and no
 * encoder in the ranking benefits. Roughly 90 GB per hour.
 */
export const MAX_BITRATE_KBPS = 200_000

export interface ClampedValue<T> {
  value: T
  /** True when the input had to be changed to fit. */
  adjusted: boolean
  /** Worth showing the user, when there is something worth saying. */
  note: string | null
}

export function clampBitrateKbps(input: number): ClampedValue<number> {
  if (!Number.isFinite(input)) {
    return {
      value: MIN_BITRATE_KBPS,
      adjusted: true,
      note: `That isn't a number, so ${MIN_BITRATE_KBPS} kbps was used.`
    }
  }

  const rounded = Math.round(input)

  if (rounded < MIN_BITRATE_KBPS) {
    return {
      value: MIN_BITRATE_KBPS,
      adjusted: true,
      note: `Raised to ${MIN_BITRATE_KBPS} kbps — below that, gameplay is too blocky to review.`
    }
  }

  if (rounded > MAX_BITRATE_KBPS) {
    return {
      value: MAX_BITRATE_KBPS,
      adjusted: true,
      note: `Capped at ${MAX_BITRATE_KBPS} kbps — that's already about 90 GB per hour.`
    }
  }

  return { value: rounded, adjusted: false, note: null }
}

/**
 * Longest minimum-length rule that still makes sense.
 *
 * Fifteen minutes is past the point where a League game can be a remake, so
 * anything longer would be discarding real games. Someone who wants that should
 * be using retention, which at least shows them what it will delete first.
 */
export const MAX_MIN_KEEP_MINUTES = 15

export function clampMinKeepMinutes(input: number): ClampedValue<number> {
  if (!Number.isFinite(input) || input < 0) {
    return { value: 0, adjusted: true, note: 'Set to 0, which keeps every recording.' }
  }

  // Quarter-minute granularity: 15 seconds is a meaningful floor for "was this
  // even a game", and finer than that is false precision.
  const rounded = Math.round(input * 4) / 4

  if (rounded > MAX_MIN_KEEP_MINUTES) {
    return {
      value: MAX_MIN_KEEP_MINUTES,
      adjusted: true,
      note:
        `Capped at ${MAX_MIN_KEEP_MINUTES} minutes. Past that you'd be discarding real games, ` +
        'not remakes — use the storage limit for that instead, since it shows you what it will delete.'
    }
  }

  return { value: rounded, adjusted: false, note: null }
}

export function minutesToMs(minutes: number): number {
  return Math.round(minutes * 60 * 1000)
}

export function msToMinutes(ms: number): number {
  return Math.round((ms / 60_000) * 4) / 4
}

/** 'Keeps everything' / '4 min' / '1 min 30 s' -- for the field's hint. */
export function describeMinKeep(ms: number): string {
  if (ms <= 0) return 'Every recording is kept, however short.'

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  const length =
    minutes === 0 ? `${seconds}s` : seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds}s`

  return `Recordings shorter than ${length} are deleted. Remakes are called at 3 minutes, so anything under about 4 minutes was never a real game.`
}
