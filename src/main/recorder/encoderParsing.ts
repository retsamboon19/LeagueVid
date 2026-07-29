// Parsers for ffmpeg's own capability listings.
//
// Kept free of child_process, Electron and the database so they can be tested
// against captured ffmpeg output without a GPU. The spawning half lives in
// encoderCapabilities.ts; the candidate table and ranking rules live in
// shared/encoders.ts because the Settings screen needs them too.

export {
  ENCODER_CANDIDATES,
  RANKING_RATIONALE,
  chooseDefaultEncoder,
  describeEncoder,
  findCandidate,
  sortOutcomesByRank,
  type EncoderCandidate
} from '../../shared/encoders'
export type { EncoderProbeOutcome } from '../../shared/types'

/**
 * Encoder names from `ffmpeg -encoders`.
 *
 * The listing is a legend, a header, then one line per encoder:
 *
 *     Encoders:
 *      V..... = Video
 *      ------
 *      V....D h264_nvenc           NVIDIA NVENC H.264 encoder
 *
 * Only the flags column plus name is needed. The flags themselves are not
 * filtered on: a name appearing here means compiled in, which is a different
 * claim from working on this machine -- that's what probing is for.
 */
export function parseEncoderNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    // Six flag characters, whitespace, then the name. Anchored so legend
    // lines ("V..... = Video") and separators can't contribute.
    const match = line.match(/^\s[VASFXBD.]{6}\s+([A-Za-z0-9_]+)/)
    if (match) names.add(match[1])
  }
  return names
}

/**
 * Filter names from `ffmpeg -filters`:
 *
 *     Filters:
 *      T.. = Timeline support
 *      ...
 *      ... ddagrab            |->V       Grab Windows Desktop images
 *      TSC hwdownload         V->V       Download a hardware frame
 *
 * Source filters like ddagrab report '|->V' rather than 'V->V', which the
 * input-column pattern has to allow -- ddagrab is the one filter this whole
 * feature depends on.
 */
export function parseFilterNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s[TSC.]{3}\s+([A-Za-z0-9_]+)\s+[A-Z|>\-]+/)
    if (match) names.add(match[1])
  }
  return names
}

/** The capture filter, and the filters the optional paths need. */
export const REQUIRED_FILTERS = ['ddagrab'] as const
export const SCALING_FILTERS = ['hwdownload', 'scale', 'format'] as const
export const TONEMAP_FILTERS = ['zscale', 'tonemap'] as const
