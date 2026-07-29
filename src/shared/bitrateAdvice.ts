// Works out a bitrate that actually suits a resolution and framerate.
//
// This exists because the first set of presets picked numbers out of the air --
// 4000 kbps at 720p30, 8000 at 1080p60 -- and the result looked, correctly,
// terrible. Bitrate has to scale with how many pixels per second are being
// encoded, and League is not a forgiving subject: a teamfight is full of
// particle effects and fast camera movement, which is precisely what a low
// bitrate turns to mush.
//
// Pure so the numbers can be checked against known-good references rather than
// eyeballed.

/**
 * Bits per pixel per frame, at the quality level a review VOD wants.
 *
 * Calibrated against what H.264 hardware encoders need for game footage: about
 * 8 Mbps at 1080p30, 12 at 1080p60, 25 at 1440p60. Lower than a streaming
 * platform would use for the same source, because a local recording has no
 * bandwidth ceiling to respect and NVENC is being asked for quality rather than
 * a small file.
 */
const BITS_PER_PIXEL = 0.1

/**
 * Framerate has a sublinear effect on the bitrate needed.
 *
 * Doubling the framerate does not double the information: consecutive frames are
 * more similar at higher rates, so inter-frame prediction gets more efficient.
 * Treating it as linear is what produces the absurd 60 Mbps figures some
 * calculators give for 120fps.
 */
const FRAMERATE_EXPONENT = 0.75

/** Nothing below this is worth recording at any resolution. */
export const ADVICE_FLOOR_KBPS = 2000

/** Above this, returns diminish sharply for H.264. */
export const ADVICE_CEILING_KBPS = 120_000

/**
 * Suggested bitrate in kbps for a given output size and framerate.
 *
 * Rounded to a round number, because a recommendation of 23,847 kbps implies a
 * precision this heuristic does not have.
 */
export function recommendedBitrateKbps(width: number, height: number, fps: number): number {
  if (width <= 0 || height <= 0 || fps <= 0) return ADVICE_FLOOR_KBPS

  const pixels = width * height
  // Referenced to 30fps, then scaled sublinearly.
  const framerateFactor = Math.pow(fps / 30, FRAMERATE_EXPONENT)
  const bitsPerSecond = pixels * 30 * BITS_PER_PIXEL * framerateFactor

  const kbps = bitsPerSecond / 1000
  const rounded = kbps >= 10_000 ? Math.round(kbps / 1000) * 1000 : Math.round(kbps / 500) * 500

  return Math.min(ADVICE_CEILING_KBPS, Math.max(ADVICE_FLOOR_KBPS, rounded))
}

/** Height for a resolution choice, given the display's own height. */
export function outputHeightFor(
  scale: 'native' | '1440p' | '1080p' | '720p' | '480p',
  displayHeight: number
): number {
  if (scale === 'native') return displayHeight
  const wanted = { '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480 }[scale]
  // Never upscale: asking a 1080p display for 1440p should record 1080p.
  return Math.min(wanted, displayHeight)
}

/**
 * Whether a framerate is worth offering for a display.
 *
 * Above the refresh rate the desktop has no new frames to hand over, so the
 * extra ones are duplicates -- measured on a 239Hz panel, capturing an idle
 * desktop at 120fps produced 340 duplicate frames out of 738. Not an error, but
 * not worth the bitrate either.
 */
export function exceedsRefreshRate(fps: number, refreshHz: number | null): boolean {
  if (!refreshHz || refreshHz <= 0) return false
  // A little tolerance: a 239Hz panel should not flag a 240fps option.
  return fps > refreshHz + 2
}
