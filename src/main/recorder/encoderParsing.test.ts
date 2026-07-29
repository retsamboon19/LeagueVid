import { describe, expect, it } from 'vitest'
import type { EncoderProbeOutcome } from '../../shared/types'
import {
  ENCODER_CANDIDATES,
  chooseDefaultEncoder,
  describeEncoder,
  findCandidate,
  parseEncoderNames,
  parseFilterNames,
  sortOutcomesByRank
} from './encoderParsing'

// Shape taken from `ffmpeg -encoders` on the bundled 6.1.1 gyan build,
// trimmed to the lines that matter plus enough legend and noise to prove the
// parser isn't just splitting on whitespace.
const ENCODERS_OUTPUT = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_mf              H264 via MediaFoundation (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration) (codec h264)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 A....D aac                  AAC (Advanced Audio Coding)
`

const FILTERS_OUTPUT = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
  A = Audio input/output
  V = Video input/output
  | = Source or sink filter
 ... ddagrab            |->V       Grab Windows Desktop images using Desktop Duplication API
 ... gdigrab            |->V       Grab Windows Desktop images
 .S. hwdownload         V->V       Download a hardware frame to a normal frame
 .SC scale              V->V       Scale the input video size and/or convert the image format
 ... format             V->V       Convert the input video to one of the specified pixel formats
 .S. zscale             V->V       Apply resizing, colorspace and bit depth conversion
 ... tonemap            V->V       Conversion to/from different dynamic ranges
 TSC aresample          A->A       Resample audio data
 ... amix               N->A       Audio mixing
`

function outcome(name: string, passed: boolean): EncoderProbeOutcome {
  return { name, available: true, passed, error: passed ? null : 'nope', durationMs: 100 }
}

describe('parseEncoderNames', () => {
  it('finds every candidate encoder in a real listing', () => {
    const names = parseEncoderNames(ENCODERS_OUTPUT)
    expect(names.has('h264_nvenc')).toBe(true)
    expect(names.has('h264_qsv')).toBe(true)
    expect(names.has('h264_amf')).toBe(true)
    expect(names.has('h264_mf')).toBe(true)
    expect(names.has('libx264')).toBe(true)
    expect(names.has('hevc_nvenc')).toBe(true)
  })

  it('does not read legend or separator lines as encoders', () => {
    const names = parseEncoderNames(ENCODERS_OUTPUT)
    expect(names.has('Encoders')).toBe(false)
    expect(names.has('Video')).toBe(false)
    expect([...names].some((n) => n.startsWith('-'))).toBe(false)
  })

  it('returns nothing for empty or unrelated output', () => {
    expect(parseEncoderNames('').size).toBe(0)
    expect(parseEncoderNames('command not found').size).toBe(0)
  })
})

describe('parseFilterNames', () => {
  it('finds the capture and scaling filters', () => {
    const filters = parseFilterNames(FILTERS_OUTPUT)
    expect(filters.has('ddagrab')).toBe(true)
    expect(filters.has('hwdownload')).toBe(true)
    expect(filters.has('scale')).toBe(true)
    expect(filters.has('format')).toBe(true)
  })

  it('finds the tonemapping filters used for HDR displays', () => {
    const filters = parseFilterNames(FILTERS_OUTPUT)
    expect(filters.has('zscale')).toBe(true)
    expect(filters.has('tonemap')).toBe(true)
  })

  it('handles source filters whose input column is |->V', () => {
    // ddagrab and gdigrab are sources, so their column reads '|->V' rather
    // than 'V->V'. An input-column pattern that only accepted 'X->Y' would
    // silently miss the one filter the whole feature depends on.
    const filters = parseFilterNames(FILTERS_OUTPUT)
    expect(filters.has('gdigrab')).toBe(true)
  })

  it('does not read the legend as filters', () => {
    const filters = parseFilterNames(FILTERS_OUTPUT)
    expect(filters.has('Filters')).toBe(false)
  })
})

describe('chooseDefaultEncoder', () => {
  it('prefers NVENC when everything works', () => {
    const chosen = chooseDefaultEncoder([
      outcome('libx264', true),
      outcome('h264_mf', true),
      outcome('h264_amf', true),
      outcome('h264_qsv', true),
      outcome('h264_nvenc', true)
    ])
    expect(chosen).toBe('h264_nvenc')
  })

  it('walks down the ranking as hardware encoders fail', () => {
    expect(
      chooseDefaultEncoder([
        outcome('h264_nvenc', false),
        outcome('h264_qsv', true),
        outcome('libx264', true)
      ])
    ).toBe('h264_qsv')

    expect(
      chooseDefaultEncoder([
        outcome('h264_nvenc', false),
        outcome('h264_qsv', false),
        outcome('h264_amf', true),
        outcome('libx264', true)
      ])
    ).toBe('h264_amf')

    expect(
      chooseDefaultEncoder([
        outcome('h264_nvenc', false),
        outcome('h264_qsv', false),
        outcome('h264_amf', false),
        outcome('h264_mf', true),
        outcome('libx264', true)
      ])
    ).toBe('h264_mf')
  })

  it('falls back to software when no hardware encoder passes', () => {
    expect(
      chooseDefaultEncoder([
        outcome('h264_nvenc', false),
        outcome('h264_qsv', false),
        outcome('h264_amf', false),
        outcome('h264_mf', false),
        outcome('libx264', true)
      ])
    ).toBe('libx264')
  })

  // Recordings are played back in the app's own Chromium <video> element,
  // where HEVC decoding is unreliable. Picking it automatically would produce
  // files LeagueVid itself might not play, so it is probed but never chosen.
  it('never auto-selects HEVC, even when it is the only passing encoder', () => {
    expect(chooseDefaultEncoder([outcome('hevc_nvenc', true)])).toBeNull()
  })

  it('returns null when nothing passes at all', () => {
    expect(chooseDefaultEncoder([outcome('h264_nvenc', false), outcome('libx264', false)])).toBeNull()
    expect(chooseDefaultEncoder([])).toBeNull()
  })
})

describe('sortOutcomesByRank', () => {
  it('orders results best-first regardless of probe order', () => {
    const sorted = sortOutcomesByRank([
      outcome('libx264', true),
      outcome('hevc_nvenc', true),
      outcome('h264_nvenc', true),
      outcome('h264_amf', false)
    ])
    expect(sorted.map((o) => o.name)).toEqual([
      'h264_nvenc',
      'h264_amf',
      'libx264',
      'hevc_nvenc'
    ])
  })

  it('does not mutate the input', () => {
    const input = [outcome('libx264', true), outcome('h264_nvenc', true)]
    sortOutcomesByRank(input)
    expect(input.map((o) => o.name)).toEqual(['libx264', 'h264_nvenc'])
  })
})

describe('describeEncoder', () => {
  it('names the encoder and whether it is hardware', () => {
    expect(describeEncoder('h264_nvenc')).toBe('NVENC H.264 (hardware)')
    expect(describeEncoder('libx264')).toBe('x264 (software)')
  })

  it('says so plainly when there is nothing to use', () => {
    expect(describeEncoder(null)).toBe('None available')
  })

  it('passes through an unknown encoder name rather than inventing a label', () => {
    expect(describeEncoder('h264_videotoolbox')).toBe('h264_videotoolbox')
  })
})

describe('ENCODER_CANDIDATES', () => {
  it('has a unique rank per candidate', () => {
    const ranks = ENCODER_CANDIDATES.map((c) => c.rank)
    expect(new Set(ranks).size).toBe(ranks.length)
  })

  it('ranks every hardware candidate above software x264', () => {
    const x264 = findCandidate('libx264')
    const hardware = ENCODER_CANDIDATES.filter((c) => c.hardware && c.autoSelectable)
    for (const candidate of hardware) {
      expect(candidate.rank).toBeLessThan(x264!.rank)
    }
  })
})
