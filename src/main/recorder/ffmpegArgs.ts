import type { RecordingSettings } from '../../shared/types'

// Builds the ffmpeg command line for a recording session.
//
// Pure: no spawning, no filesystem access, no Electron. Every combination of
// encoder, rate control, scaling and audio input can therefore be asserted in
// a test rather than discovered during a game. That matters more here than it
// looks, because wrong rate-control flags are *quiet* -- passing -crf to NVENC
// or -cq to libx264 is either ignored or accepted with a different meaning, and
// the only symptom is a recording at the wrong bitrate.

export interface CaptureTarget {
  /** ddagrab output index for the monitor being captured. */
  outputIdx: number
  /** Native size of that monitor, in pixels. */
  width: number
  height: number
  /** Windows HDR is on for this display. */
  isHdr: boolean
}

export interface AudioInputSpec {
  /**
   * 'dshow' is a real capture device (a microphone, or a virtual loopback
   * device if the user has one). 'loopback-socket' is LeagueVid's own
   * Chromium loopback bridge feeding raw PCM over localhost, which exists
   * because the bundled ffmpeg has no WASAPI loopback input at all.
   */
  kind: 'dshow' | 'loopback-socket'
  /** DirectShow device name, or the tcp:// url of the bridge. */
  source: string
  /** Track title, and what the settings called it. */
  role: 'mic' | 'desktop'
}

export interface ReplayRingSpec {
  /** printf-style path, e.g. 'H:\\rec\\buffer\\seg%03d.ts'. */
  segmentPattern: string
  /** Seconds per segment. */
  segmentSeconds: number
  /** How many segments before the ring wraps. */
  segmentCount: number
}

export interface BuildCaptureArgsInput {
  settings: RecordingSettings
  target: CaptureTarget
  /** Matroska session file. */
  outputPath: string
  audioInputs: AudioInputSpec[]
  /**
   * When present, the encoded stream is split with the tee muxer: once into the
   * session file and once into a wrapping segment ring for the replay buffer.
   * One encode, two destinations -- the naive alternative runs the encoder twice
   * and doubles the cost of the feature.
   */
  replay?: ReplayRingSpec
}

/** Target height per resolution setting. 'native' means don't scale. */
const SCALE_HEIGHTS: Record<Exclude<RecordingSettings['resolutionScale'], 'native'>, number> = {
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720
}

/**
 * Encoders that accept D3D11 hardware frames straight from ddagrab, so the
 * frame never leaves the GPU.
 *
 * NVENC is the documented ddagrab pairing and the only one that reliably takes
 * hw frames as-is. Quick Sync, AMF, Media Foundation and x264 all need frames
 * in system memory, which costs a hwdownload round trip -- unavoidable for
 * them, and the main reason NVENC is ranked first.
 */
const D3D11_DIRECT_ENCODERS = new Set(['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'])

export function encoderTakesHardwareFrames(encoder: string): boolean {
  return D3D11_DIRECT_ENCODERS.has(encoder)
}

/**
 * Whether the requested scale actually reduces anything.
 *
 * Scaling up is never wanted: a 1080p monitor asked for '1440p' should record
 * at 1080p rather than spend bitrate on invented pixels.
 */
export function effectiveScaleHeight(
  settings: RecordingSettings,
  target: CaptureTarget
): number | null {
  if (settings.resolutionScale === 'native') return null
  const wanted = SCALE_HEIGHTS[settings.resolutionScale]
  return wanted < target.height ? wanted : null
}

/**
 * Rate-control arguments per encoder. The five encoders express the same two
 * intentions -- "this quality" and "this bitrate" -- with five different flag
 * sets and, for Media Foundation, an inverted scale.
 */
export function rateControlArgs(encoder: string, settings: RecordingSettings): string[] {
  const quality = Math.round(settings.quality)
  const kbps = Math.round(settings.bitrateKbps)
  const byQuality = settings.rateControl === 'quality'

  switch (encoder) {
    case 'h264_nvenc':
    case 'hevc_nvenc':
    case 'av1_nvenc':
      return byQuality
        ? // -b:v 0 is what makes -cq a true constant-quality target rather
          // than a ceiling on an average-bitrate run.
          ['-rc', 'vbr', '-cq', String(quality), '-b:v', '0']
        : [
            '-rc',
            'cbr',
            '-b:v',
            `${kbps}k`,
            '-maxrate',
            `${kbps}k`,
            '-bufsize',
            `${kbps * 2}k`
          ]

    case 'h264_qsv':
      return byQuality
        ? ['-global_quality', String(quality)]
        : ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`]

    case 'h264_amf':
      return byQuality
        ? ['-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality)]
        : ['-rc', 'cbr', '-b:v', `${kbps}k`]

    case 'h264_mf':
      return byQuality
        ? // Media Foundation's scale runs the other way: 0-100, higher is
          // better, where cq/crf/qp are 0-51 and lower is better. Passing a
          // cq value straight through would ask for near-worst quality.
          ['-rate_control', 'quality', '-quality', String(mediaFoundationQuality(quality))]
        : ['-rate_control', 'cbr', '-b:v', `${kbps}k`]

    case 'libx264':
      return byQuality
        ? ['-crf', String(quality), '-preset', 'veryfast']
        : ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`]

    default:
      // An encoder nobody wrote a row for gets bitrate control, which every
      // ffmpeg encoder understands, rather than quality flags that might mean
      // something else entirely.
      return ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`]
  }
}

/** cq/crf 0-51 (lower better) -> MF quality 0-100 (higher better). */
export function mediaFoundationQuality(quality: number): number {
  const clamped = Math.min(51, Math.max(0, quality))
  return Math.round(100 - (clamped / 51) * 100)
}

/**
 * The HDR tonemap chain, for when Windows HDR is enabled on the captured
 * display. ddagrab hands back 8-bit SDR-range data in that case, which looks
 * washed out; this converts to linear light, tonemaps, and returns to BT.709.
 */
const TONEMAP_CHAIN = [
  'zscale=t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=hable:desat=0',
  'zscale=t=bt709:m=bt709:r=tv'
].join(',')

/** The video half of -filter_complex, ending in the [v] label. */
export function buildVideoFilterChain(
  settings: RecordingSettings,
  target: CaptureTarget,
  encoder: string
): string {
  const capture = [
    `ddagrab=output_idx=${target.outputIdx}`,
    `framerate=${settings.framerate}`,
    `draw_mouse=${settings.drawMouse ? 1 : 0}`,
    // ddagrab asks the Desktop Duplication API for 8-bit BGRA by default and,
    // with allow_fallback off (its default), *errors out* when the display
    // cannot provide it -- which is what an HDR display does. Verified against
    // `ffmpeg -h filter=ddagrab` on the bundled 6.1.1 build. Recording nothing
    // is a worse outcome than recording a format that needs tonemapping, so
    // fallback is allowed and the tonemap chain handles the result.
    'allow_fallback=1'
  ].join(':')

  const scaleHeight = effectiveScaleHeight(settings, target)
  const needsCpuFilters = scaleHeight !== null || target.isHdr
  const needsDownload = needsCpuFilters || !encoderTakesHardwareFrames(encoder)

  if (!needsDownload) {
    // Native path: the frame is produced, encoded and never copied to system
    // memory. This is the default and the reason NVENC is preferred.
    return `${capture}[v]`
  }

  const steps = ['hwdownload', 'format=bgra']
  if (target.isHdr) steps.push(TONEMAP_CHAIN)
  // -2 keeps the width even (H.264 requires it) while preserving aspect.
  if (scaleHeight !== null) steps.push(`scale=-2:${scaleHeight}`)
  steps.push('format=nv12')

  return `${capture},${steps.join(',')}[v]`
}

/**
 * The audio half of -filter_complex, plus the labels to map.
 *
 * Every input is resampled with async=1 whether or not it looks like it needs
 * it. ddagrab and dshow run off different clocks, which is a documented source
 * of drift in long ffmpeg captures -- and a 40-minute recording is long. The
 * cost is nothing; the failure it prevents is audio that slides out of sync by
 * the end of the game.
 */
export function buildAudioFilterChain(
  inputs: AudioInputSpec[],
  mode: RecordingSettings['audioTrackMode']
): { chains: string[]; mapLabels: string[] } {
  if (inputs.length === 0) return { chains: [], mapLabels: [] }

  const chains: string[] = []
  inputs.forEach((_input, index) => {
    chains.push(`[${index}:a]aresample=async=1:first_pts=0[a${index}]`)
  })

  if (inputs.length === 1) {
    return { chains, mapLabels: ['[a0]'] }
  }

  if (mode === 'separate') {
    return { chains, mapLabels: inputs.map((_i, index) => `[a${index}]`) }
  }

  const mixInputs = inputs.map((_i, index) => `[a${index}]`).join('')
  chains.push(
    // dropout_transition=0 keeps amix from ducking the remaining input when
    // one source goes briefly silent, which it does by default.
    `${mixInputs}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0[amix]`
  )
  return { chains, mapLabels: ['[amix]'] }
}

/** Input arguments for one audio source, in front of its -i. */
export function audioInputArgs(input: AudioInputSpec): string[] {
  if (input.kind === 'loopback-socket') {
    return ['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', input.source]
  }
  return [
    '-f',
    'dshow',
    // Device clocks drift against the capture clock; stamping packets with
    // wall-clock time on arrival is what lets aresample correct for it.
    '-use_wallclock_as_timestamps',
    '1',
    // A too-small queue drops packets during a stall and the audio gets a
    // permanent gap; ffmpeg warns about this by default.
    '-thread_queue_size',
    '1024',
    '-i',
    `audio=${input.source}`
  ]
}

export function resolveEncoder(settings: RecordingSettings, fallback: string): string {
  return settings.encoder ?? fallback
}

/**
 * The complete argument vector for a recording session.
 *
 * @param fallbackEncoder encoder to use when settings don't pin one -- i.e.
 *   whatever capability probing chose.
 */
export function buildCaptureArgs(
  input: BuildCaptureArgsInput,
  fallbackEncoder = 'h264_nvenc'
): string[] {
  const { settings, target, outputPath, audioInputs } = input
  const encoder = resolveEncoder(settings, fallbackEncoder)

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'warning',
    // Progress goes to stdout as machine-readable key=value blocks; the
    // human-readable status line would otherwise interleave with it on stderr.
    '-nostats',
    '-progress',
    'pipe:1',
    // ddagrab is a D3D11 source, so it needs a device to allocate frames on
    // even when the encoder later downloads them.
    '-init_hw_device',
    'd3d11va'
  ]

  for (const audio of audioInputs) {
    args.push(...audioInputArgs(audio))
  }

  const video = buildVideoFilterChain(settings, target, encoder)
  const audio = buildAudioFilterChain(audioInputs, settings.audioTrackMode)
  args.push('-filter_complex', [video, ...audio.chains].join(';'))

  args.push('-map', '[v]')
  for (const label of audio.mapLabels) {
    args.push('-map', label)
  }

  args.push('-c:v', encoder, ...rateControlArgs(encoder, settings))

  // Keyframe interval is also the granularity of the clip editor's lossless
  // "fast" cut, which can only start on a keyframe -- so this is a deliberate
  // user-facing trade rather than an encoder detail.
  args.push('-g', String(Math.max(1, Math.round(settings.framerate * settings.keyframeIntervalSeconds))))

  // Constant frame rate output. ddagrab only emits a frame when the desktop
  // changes, so without this a static screen produces variable timestamps and
  // the recording's timeline stops matching wall-clock time -- which is the
  // one thing bookmark placement depends on.
  args.push('-r', String(settings.framerate), '-fps_mode', 'cfr')

  if (audio.mapLabels.length > 0) {
    args.push('-c:a', 'aac', '-b:a', '160k')
    if (audio.mapLabels.length > 1) {
      audioInputs.forEach((source, index) => {
        args.push(`-metadata:s:a:${index}`, `title=${source.role === 'mic' ? 'Microphone' : 'Desktop'}`)
      })
    }
  }

  if (input.replay) {
    // Forces the encoder to emit parameter sets as a global header, which is
    // what Matroska needs; the segment leg converts them back to in-band for
    // mpegts. Without it the Matroska leg refuses the stream outright.
    args.push('-flags', '+global_header')
    args.push('-f', 'tee', '-y', teeTarget(outputPath, input.replay))
    return args
  }

  // Matroska, not MP4: a truncated MP4 has no moov atom and will not play,
  // and this file exists precisely to survive a crash mid-game. It's remuxed
  // to MP4 with -c copy once the session ends cleanly.
  args.push('-f', 'matroska', '-y', outputPath)

  return args
}

/**
 * The tee muxer's output specification.
 *
 * Two legs from one encode: the Matroska session file, and an mpegts segment
 * ring. mpegts for the ring specifically because its segments concatenate
 * cleanly with the concat demuxer and `-c copy`, which is how a replay gets
 * saved without re-encoding -- MP4 fragments do not join that way.
 *
 * `segment_wrap` is what makes the ring bounded: segment numbering returns to 0
 * after N files, so the buffer overwrites its own oldest footage instead of
 * filling the disk for the whole game.
 */
export function teeTarget(sessionPath: string, replay: ReplayRingSpec): string {
  const segment = [
    'f=segment',
    `segment_time=${replay.segmentSeconds}`,
    `segment_wrap=${replay.segmentCount}`,
    'segment_format=mpegts',
    // Each segment starts at zero, so a saved replay doesn't inherit an offset
    // from where it happened to fall in the game.
    'reset_timestamps=1',
    // The two legs want H.264 packaged differently: Matroska needs the
    // parameter sets out of band in a global header, mpegts needs them in band.
    // Verified against the bundled ffmpeg -- without this the Matroska leg fails
    // with "error writing header: Invalid data found when processing input" and
    // writes a 293-byte stub, while the segments come out fine. So the encoder
    // is asked for a global header (see buildCaptureArgs) and this leg converts
    // back to in-band.
    'bsfs/v=h264_mp4toannexb'
  ].join(':')

  // Escaping: within a tee target, ':' separates options and '|' separates
  // legs, so both have to be escaped inside a Windows path.
  return `[f=matroska]${escapeTeePath(sessionPath)}|[${segment}]${escapeTeePath(
    replay.segmentPattern
  )}`
}

function escapeTeePath(path: string): string {
  return path.replace(/([:|\\])/g, '\\$1')
}

/** The same argv as a copy-pasteable command line, for scripts and logs. */
export function formatCommand(ffmpegPath: string, args: string[]): string {
  const quoted = args.map((arg) => (/[\s;|&"]/.test(arg) ? `"${arg}"` : arg))
  return `"${ffmpegPath}" ${quoted.join(' ')}`
}
