// The encoder candidate table and the rules for choosing between them.
//
// Shared rather than main-only because the Settings screen reports what was
// detected using the same labels and ranking the main process selects with --
// two copies of this table would drift, and the one it would drift on is
// which encoder is actually in use.

import type { EncoderProbeOutcome } from './types'

export interface EncoderCandidate {
  /** ffmpeg encoder name, e.g. 'h264_nvenc'. */
  name: string
  /** Shown to the user, e.g. 'NVENC H.264'. */
  label: string
  hardware: boolean
  /** Lower wins. See RANKING_RATIONALE. */
  rank: number
  /**
   * Whether this encoder may be chosen automatically. HEVC is probed because
   * it's useful to know it works, but never selected by default: LeagueVid
   * plays recordings back in a Chromium <video> element, and HEVC decoding
   * there is unreliable, so an HEVC recording risks being a file the app
   * itself cannot play.
   */
  autoSelectable: boolean
}

/**
 * Dedicated silicon first, vendor SDKs before the generic OS wrapper, CPU
 * last. NVENC, Quick Sync and AMF all encode without spending frame budget;
 * h264_mf is Media Foundation, which works widely but exposes less control and
 * performs less predictably; libx264 is correct everywhere and costs CPU that
 * the game is already using.
 */
export const RANKING_RATIONALE = 'nvenc > qsv > amf > mf > libx264'

export const ENCODER_CANDIDATES: EncoderCandidate[] = [
  { name: 'h264_nvenc', label: 'NVENC H.264', hardware: true, rank: 1, autoSelectable: true },
  { name: 'h264_qsv', label: 'Quick Sync H.264', hardware: true, rank: 2, autoSelectable: true },
  { name: 'h264_amf', label: 'AMD AMF H.264', hardware: true, rank: 3, autoSelectable: true },
  {
    name: 'h264_mf',
    label: 'Media Foundation H.264',
    hardware: true,
    rank: 4,
    autoSelectable: true
  },
  { name: 'libx264', label: 'x264', hardware: false, rank: 5, autoSelectable: true },
  { name: 'hevc_nvenc', label: 'NVENC HEVC', hardware: true, rank: 6, autoSelectable: false }
]

export function findCandidate(name: string): EncoderCandidate | undefined {
  return ENCODER_CANDIDATES.find((c) => c.name === name)
}

/**
 * Picks the encoder to use by default: highest-ranked candidate that both
 * passed its probe and is allowed to be auto-selected.
 *
 * Returns null only when nothing passed at all, which means recording is not
 * possible on this machine and the UI has to say so rather than storing a
 * setting that will fail at spawn time.
 */
export function chooseDefaultEncoder(outcomes: EncoderProbeOutcome[]): string | null {
  const eligible = outcomes
    .filter((o) => o.passed)
    .map((o) => ({ outcome: o, candidate: findCandidate(o.name) }))
    .filter((entry) => entry.candidate?.autoSelectable)
    .sort((a, b) => (a.candidate?.rank ?? 99) - (b.candidate?.rank ?? 99))

  return eligible[0]?.outcome.name ?? null
}

/** Probe outcomes in presentation order, best first. */
export function sortOutcomesByRank(outcomes: EncoderProbeOutcome[]): EncoderProbeOutcome[] {
  return [...outcomes].sort(
    (a, b) => (findCandidate(a.name)?.rank ?? 99) - (findCandidate(b.name)?.rank ?? 99)
  )
}

/** 'NVENC H.264 (hardware)' -- what the Settings screen shows. */
export function describeEncoder(name: string | null): string {
  if (!name) return 'None available'
  const candidate = findCandidate(name)
  if (!candidate) return name
  return `${candidate.label} (${candidate.hardware ? 'hardware' : 'software'})`
}
