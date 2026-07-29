import { describe, expect, it } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/types'
import {
  buildAudioFilterChain,
  buildCaptureArgs,
  buildVideoFilterChain,
  effectiveScaleHeight,
  encoderTakesHardwareFrames,
  formatCommand,
  mediaFoundationQuality,
  rateControlArgs,
  type AudioInputSpec,
  type CaptureTarget
} from './ffmpegArgs'

const TARGET_1440: CaptureTarget = { outputIdx: 0, width: 2560, height: 1440, isHdr: false }
const TARGET_1080: CaptureTarget = { outputIdx: 1, width: 1920, height: 1080, isHdr: false }
const TARGET_HDR: CaptureTarget = { outputIdx: 0, width: 3840, height: 2160, isHdr: true }

const MIC: AudioInputSpec = { kind: 'dshow', source: 'Microphone (Blue Yeti)', role: 'mic' }
const DESKTOP_DEVICE: AudioInputSpec = { kind: 'dshow', source: 'Stereo Mix', role: 'desktop' }
const LOOPBACK: AudioInputSpec = {
  kind: 'loopback-socket',
  source: 'tcp://127.0.0.1:47821',
  role: 'desktop'
}

function settings(overrides: Partial<RecordingSettings> = {}): RecordingSettings {
  return { ...DEFAULT_RECORDING_SETTINGS, ...overrides }
}

/** Value following a flag, e.g. valueAfter(args, '-c:v'). */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Array.prototype.at isn't in the project's ES2021 lib target. */
function last<T>(items: T[]): T | undefined {
  return items[items.length - 1]
}

/** The output muxer: the last -f, since input declarations use -f too. */
function outputFormat(args: string[]): string | undefined {
  return last(allValuesAfter(args, '-f'))
}

function allValuesAfter(args: string[], flag: string): string[] {
  const values: string[] = []
  args.forEach((arg, index) => {
    if (arg === flag) values.push(args[index + 1])
  })
  return values
}

describe('rateControlArgs', () => {
  // The table from the design doc, asserted verbatim. Wrong flags here are
  // silent -- ffmpeg either ignores them or reads them as something else --
  // so this is the one place worth being pedantic.
  const cases: Array<{
    encoder: string
    quality: string[]
    bitrate: string[]
  }> = [
    {
      encoder: 'h264_nvenc',
      quality: ['-rc', 'vbr', '-cq', '21', '-b:v', '0'],
      bitrate: ['-rc', 'cbr', '-b:v', '40000k', '-maxrate', '40000k', '-bufsize', '80000k']
    },
    {
      encoder: 'hevc_nvenc',
      quality: ['-rc', 'vbr', '-cq', '21', '-b:v', '0'],
      bitrate: ['-rc', 'cbr', '-b:v', '40000k', '-maxrate', '40000k', '-bufsize', '80000k']
    },
    {
      encoder: 'h264_qsv',
      quality: ['-global_quality', '21'],
      bitrate: ['-b:v', '40000k', '-maxrate', '40000k']
    },
    {
      encoder: 'h264_amf',
      quality: ['-rc', 'cqp', '-qp_i', '21', '-qp_p', '21'],
      bitrate: ['-rc', 'cbr', '-b:v', '40000k']
    },
    {
      encoder: 'h264_mf',
      quality: ['-rate_control', 'quality', '-quality', '59'],
      bitrate: ['-rate_control', 'cbr', '-b:v', '40000k']
    },
    {
      encoder: 'libx264',
      quality: ['-crf', '21', '-preset', 'veryfast'],
      bitrate: ['-b:v', '40000k', '-maxrate', '40000k', '-bufsize', '80000k']
    }
  ]

  for (const testCase of cases) {
    it(`${testCase.encoder} in quality mode`, () => {
      expect(rateControlArgs(testCase.encoder, settings({ rateControl: 'quality' }))).toEqual(
        testCase.quality
      )
    })

    it(`${testCase.encoder} in bitrate mode`, () => {
      expect(rateControlArgs(testCase.encoder, settings({ rateControl: 'bitrate' }))).toEqual(
        testCase.bitrate
      )
    })
  }

  it('never mixes quality flags into bitrate mode', () => {
    for (const testCase of cases) {
      const args = rateControlArgs(testCase.encoder, settings({ rateControl: 'bitrate' }))
      expect(args).not.toContain('-crf')
      expect(args).not.toContain('-cq')
      expect(args).not.toContain('-qp_i')
      expect(args).not.toContain('-global_quality')
    }
  })

  it('falls back to plain bitrate for an encoder with no row', () => {
    expect(rateControlArgs('h264_videotoolbox', settings())).toEqual([
      '-b:v',
      '40000k',
      '-maxrate',
      '40000k'
    ])
  })
})

describe('mediaFoundationQuality', () => {
  // MF's scale is inverted relative to cq/crf/qp. Passing 21 straight through
  // would ask Media Foundation for near-worst quality instead of near-best.
  it('inverts the scale', () => {
    expect(mediaFoundationQuality(0)).toBe(100)
    expect(mediaFoundationQuality(51)).toBe(0)
    expect(mediaFoundationQuality(21)).toBe(59)
  })

  it('clamps out-of-range input', () => {
    expect(mediaFoundationQuality(-5)).toBe(100)
    expect(mediaFoundationQuality(80)).toBe(0)
  })
})

describe('encoderTakesHardwareFrames', () => {
  // Only the NVENC family accepts D3D11 frames straight from ddagrab. This is
  // the concrete cost behind the encoder ranking: everything else pays a
  // hwdownload round trip on every frame, even at native resolution.
  it('is true only for the NVENC family', () => {
    expect(encoderTakesHardwareFrames('h264_nvenc')).toBe(true)
    expect(encoderTakesHardwareFrames('hevc_nvenc')).toBe(true)
    expect(encoderTakesHardwareFrames('av1_nvenc')).toBe(true)

    expect(encoderTakesHardwareFrames('h264_qsv')).toBe(false)
    expect(encoderTakesHardwareFrames('h264_amf')).toBe(false)
    expect(encoderTakesHardwareFrames('h264_mf')).toBe(false)
    expect(encoderTakesHardwareFrames('libx264')).toBe(false)
  })
})

describe('effectiveScaleHeight', () => {
  it('is null for native capture', () => {
    expect(effectiveScaleHeight(settings({ resolutionScale: 'native' }), TARGET_1440)).toBeNull()
  })

  it('scales down when the target is smaller than the display', () => {
    expect(effectiveScaleHeight(settings({ resolutionScale: '1080p' }), TARGET_1440)).toBe(1080)
    expect(effectiveScaleHeight(settings({ resolutionScale: '720p' }), TARGET_1440)).toBe(720)
  })

  // Asking a 1080p monitor for 1440p should not spend bitrate on invented
  // pixels.
  it('refuses to scale up', () => {
    expect(effectiveScaleHeight(settings({ resolutionScale: '1440p' }), TARGET_1080)).toBeNull()
  })

  it('does not scale when the display already matches the target', () => {
    expect(effectiveScaleHeight(settings({ resolutionScale: '1080p' }), TARGET_1080)).toBeNull()
  })
})

describe('buildVideoFilterChain', () => {
  it('keeps frames on the GPU for NVENC at native resolution', () => {
    const chain = buildVideoFilterChain(settings(), TARGET_1440, 'h264_nvenc')
    expect(chain).toBe('ddagrab=output_idx=0:framerate=60:draw_mouse=0:allow_fallback=1[v]')
    expect(chain).not.toContain('hwdownload')
  })

  // ddagrab requests 8-bit BGRA and, with allow_fallback off (its default),
  // errors instead of degrading -- which is what happens on an HDR display.
  // Recording nothing is worse than recording something that needs tonemapping.
  it('always allows format fallback so an HDR display cannot hard-fail capture', () => {
    for (const target of [TARGET_1440, TARGET_1080, TARGET_HDR]) {
      expect(buildVideoFilterChain(settings(), target, 'h264_nvenc')).toContain('allow_fallback=1')
    }
  })

  // Quick Sync, AMF, Media Foundation and x264 all need frames in system
  // memory, so they pay for a download even at native resolution. That is the
  // concrete cost behind ranking NVENC first.
  it('downloads frames for encoders that cannot take hardware frames', () => {
    for (const encoder of ['h264_qsv', 'h264_amf', 'h264_mf', 'libx264']) {
      const chain = buildVideoFilterChain(settings(), TARGET_1440, encoder)
      expect(chain).toContain('hwdownload')
      expect(chain).toContain('format=nv12')
    }
  })

  it('adds a scale step, keeping width even', () => {
    const chain = buildVideoFilterChain(
      settings({ resolutionScale: '1080p' }),
      TARGET_1440,
      'h264_nvenc'
    )
    expect(chain).toContain('hwdownload')
    expect(chain).toContain('scale=-2:1080')
  })

  it('omits the scale step when scaling would upscale', () => {
    const chain = buildVideoFilterChain(
      settings({ resolutionScale: '1440p' }),
      TARGET_1080,
      'h264_nvenc'
    )
    expect(chain).not.toContain('scale=')
    expect(chain).not.toContain('hwdownload')
  })

  it('tonemaps an HDR display, which forces the CPU path', () => {
    const chain = buildVideoFilterChain(settings(), TARGET_HDR, 'h264_nvenc')
    expect(chain).toContain('hwdownload')
    expect(chain).toContain('tonemap=tonemap=hable')
    expect(chain).toContain('zscale=t=bt709:m=bt709:r=tv')
  })

  it('captures the requested monitor and framerate', () => {
    const chain = buildVideoFilterChain(settings({ framerate: 30 }), TARGET_1080, 'h264_nvenc')
    expect(chain).toContain('output_idx=1')
    expect(chain).toContain('framerate=30')
  })

  it('draws the cursor only when asked', () => {
    expect(buildVideoFilterChain(settings(), TARGET_1440, 'h264_nvenc')).toContain('draw_mouse=0')
    expect(
      buildVideoFilterChain(settings({ drawMouse: true }), TARGET_1440, 'h264_nvenc')
    ).toContain('draw_mouse=1')
  })
})

describe('buildAudioFilterChain', () => {
  it('produces nothing for no inputs', () => {
    expect(buildAudioFilterChain([], 'mixed')).toEqual({ chains: [], mapLabels: [] })
  })

  it('resamples a single input rather than mapping it raw', () => {
    const result = buildAudioFilterChain([MIC], 'mixed')
    expect(result.chains).toEqual(['[0:a]aresample=async=1:first_pts=0[a0]'])
    expect(result.mapLabels).toEqual(['[a0]'])
  })

  it('mixes two inputs into one track', () => {
    const result = buildAudioFilterChain([MIC, LOOPBACK], 'mixed')
    expect(result.chains).toContain('[0:a]aresample=async=1:first_pts=0[a0]')
    expect(result.chains).toContain('[1:a]aresample=async=1:first_pts=0[a1]')
    expect(last(result.chains)).toBe(
      '[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0[amix]'
    )
    expect(result.mapLabels).toEqual(['[amix]'])
  })

  it('keeps two inputs as separate tracks when asked', () => {
    const result = buildAudioFilterChain([MIC, LOOPBACK], 'separate')
    expect(result.chains.some((c) => c.includes('amix'))).toBe(false)
    expect(result.mapLabels).toEqual(['[a0]', '[a1]'])
  })

  // Every input gets async resampling whether or not it looks like it needs
  // it: ddagrab and dshow run off different clocks, and a 40-minute recording
  // is long enough for that to become audible.
  it('resamples every input in every mode', () => {
    for (const mode of ['mixed', 'separate'] as const) {
      const result = buildAudioFilterChain([MIC, DESKTOP_DEVICE], mode)
      expect(result.chains.filter((c) => c.includes('aresample=async=1'))).toHaveLength(2)
    }
  })
})

describe('buildCaptureArgs', () => {
  const base = { target: TARGET_1440, outputPath: 'H:\\vods\\session.mkv' }

  it('emits progress on stdout and initialises the D3D11 device', () => {
    const args = buildCaptureArgs({ ...base, settings: settings(), audioInputs: [] })
    expect(args.slice(0, 6)).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostats',
      '-progress',
      'pipe:1'
    ])
    expect(valueAfter(args, '-init_hw_device')).toBe('d3d11va')
  })

  it('writes Matroska, never MP4', () => {
    const args = buildCaptureArgs({ ...base, settings: settings(), audioInputs: [] })
    // The last -f is the output format; earlier ones belong to inputs.
    expect(outputFormat(args)).toBe('matroska')
    expect(last(args)).toBe('H:\\vods\\session.mkv')
  })

  it('sets the keyframe interval from framerate x seconds', () => {
    expect(
      valueAfter(
        buildCaptureArgs({ ...base, settings: settings({ framerate: 60 }), audioInputs: [] }),
        '-g'
      )
    ).toBe('60')
    expect(
      valueAfter(
        buildCaptureArgs({
          ...base,
          settings: settings({ framerate: 30, keyframeIntervalSeconds: 2 }),
          audioInputs: []
        }),
        '-g'
      )
    ).toBe('60')
  })

  it('never emits a keyframe interval of zero', () => {
    const args = buildCaptureArgs({
      ...base,
      settings: settings({ keyframeIntervalSeconds: 0 }),
      audioInputs: []
    })
    expect(valueAfter(args, '-g')).toBe('1')
  })

  // ddagrab only produces a frame when the desktop changes. Without constant
  // frame rate output, a static screen yields variable timestamps and the
  // recording's timeline stops matching wall-clock time -- which is exactly
  // what bookmark placement depends on.
  it('forces constant frame rate output', () => {
    const args = buildCaptureArgs({ ...base, settings: settings(), audioInputs: [] })
    expect(valueAfter(args, '-fps_mode')).toBe('cfr')
    expect(valueAfter(args, '-r')).toBe('60')
  })

  it('adds no audio codec when there is no audio', () => {
    const args = buildCaptureArgs({ ...base, settings: settings(), audioInputs: [] })
    expect(args).not.toContain('-c:a')
    expect(allValuesAfter(args, '-map')).toEqual(['[v]'])
  })

  it('maps a single mixed audio track', () => {
    const args = buildCaptureArgs({ ...base, settings: settings(), audioInputs: [MIC] })
    expect(allValuesAfter(args, '-map')).toEqual(['[v]', '[a0]'])
    expect(valueAfter(args, '-c:a')).toBe('aac')
  })

  it('maps two mixed inputs to one track', () => {
    const args = buildCaptureArgs({
      ...base,
      settings: settings(),
      audioInputs: [MIC, LOOPBACK]
    })
    expect(allValuesAfter(args, '-map')).toEqual(['[v]', '[amix]'])
  })

  it('maps two separate inputs to two titled tracks', () => {
    const args = buildCaptureArgs({
      ...base,
      settings: settings({ audioTrackMode: 'separate' }),
      audioInputs: [MIC, LOOPBACK]
    })
    expect(allValuesAfter(args, '-map')).toEqual(['[v]', '[a0]', '[a1]'])
    expect(valueAfter(args, '-metadata:s:a:0')).toBe('title=Microphone')
    expect(valueAfter(args, '-metadata:s:a:1')).toBe('title=Desktop')
  })

  it('declares a dshow input with wall-clock timestamps and a real queue', () => {
    const args = buildCaptureArgs({ ...base, settings: settings(), audioInputs: [MIC] })
    expect(args).toContain('dshow')
    expect(valueAfter(args, '-use_wallclock_as_timestamps')).toBe('1')
    expect(valueAfter(args, '-thread_queue_size')).toBe('1024')
    expect(args).toContain('audio=Microphone (Blue Yeti)')
  })

  it('declares the loopback bridge as raw float PCM', () => {
    const args = buildCaptureArgs({ ...base, settings: settings(), audioInputs: [LOOPBACK] })
    expect(args).toContain('f32le')
    expect(valueAfter(args, '-ar')).toBe('48000')
    expect(valueAfter(args, '-ac')).toBe('2')
    expect(args).toContain('tcp://127.0.0.1:47821')
  })

  it('declares every input before the filter graph that references it', () => {
    const args = buildCaptureArgs({
      ...base,
      settings: settings(),
      audioInputs: [MIC, LOOPBACK]
    })
    const lastInput = args.lastIndexOf('-i')
    expect(lastInput).toBeGreaterThan(-1)
    expect(args.indexOf('-filter_complex')).toBeGreaterThan(lastInput)
  })

  it('uses the settings encoder over the probed fallback', () => {
    const args = buildCaptureArgs(
      { ...base, settings: settings({ encoder: 'libx264' }), audioInputs: [] },
      'h264_nvenc'
    )
    expect(valueAfter(args, '-c:v')).toBe('libx264')
    expect(args).toContain('-crf')
  })

  it('uses the probed fallback when settings pin nothing', () => {
    const args = buildCaptureArgs(
      { ...base, settings: settings({ encoder: null }), audioInputs: [] },
      'h264_amf'
    )
    expect(valueAfter(args, '-c:v')).toBe('h264_amf')
  })

  // The full matrix required by the spec: every encoder, both rate modes,
  // scaled and native, and 0/1/2 audio inputs. Asserted structurally rather
  // than as golden strings so it fails on a real mistake, not on flag order.
  it('produces a coherent command across the whole matrix', () => {
    const encoders = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264']
    const scales: RecordingSettings['resolutionScale'][] = ['native', '1080p']
    const modes: RecordingSettings['rateControl'][] = ['quality', 'bitrate']
    const audioSets: AudioInputSpec[][] = [[], [MIC], [MIC, LOOPBACK]]

    for (const encoder of encoders) {
      for (const resolutionScale of scales) {
        for (const rateControl of modes) {
          for (const audioInputs of audioSets) {
            const args = buildCaptureArgs({
              settings: settings({ encoder, resolutionScale, rateControl }),
              target: TARGET_1440,
              outputPath: 'out.mkv',
              audioInputs
            })

            const label = `${encoder}/${resolutionScale}/${rateControl}/${audioInputs.length}`

            // One video encoder, one output, one filter graph.
            expect(allValuesAfter(args, '-c:v'), label).toEqual([encoder])
            expect(allValuesAfter(args, '-filter_complex'), label).toHaveLength(1)
            expect(last(args), label).toBe('out.mkv')
            expect(outputFormat(args), label).toBe('matroska')

            // Exactly one video map, plus one per expected audio track.
            const maps = allValuesAfter(args, '-map')
            expect(maps[0], label).toBe('[v]')
            expect(maps, label).toHaveLength(audioInputs.length === 0 ? 1 : 2)

            // Every label the graph maps must be defined by the graph.
            const graph = valueAfter(args, '-filter_complex') as string
            for (const map of maps) {
              expect(graph, label).toContain(map)
            }

            // One -i per audio input, and no stray video input.
            expect(allValuesAfter(args, '-i'), label).toHaveLength(audioInputs.length)
          }
        }
      }
    }
  })
})

describe('formatCommand', () => {
  it('quotes arguments containing spaces so the line can be pasted', () => {
    const line = formatCommand('C:\\ff\\ffmpeg.exe', [
      '-i',
      'audio=Microphone (Blue Yeti)',
      '-f',
      'matroska'
    ])
    expect(line).toBe('"C:\\ff\\ffmpeg.exe" -i "audio=Microphone (Blue Yeti)" -f matroska')
  })

  it('quotes the filter graph, which contains semicolons', () => {
    const line = formatCommand('ffmpeg', ['-filter_complex', 'ddagrab=0[v];[0:a]anull[a]'])
    expect(line).toContain('"ddagrab=0[v];[0:a]anull[a]"')
  })
})
