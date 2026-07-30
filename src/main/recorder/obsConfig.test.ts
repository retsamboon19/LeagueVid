import { describe, expect, it } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/types'
import type { AudioInputSpec, CaptureTarget } from './ffmpegArgs'
import {
  GAME_CAPTURE_SOURCE_NAME,
  LEAGUE_CAPTURE_TARGET,
  buildProfileIni,
  buildRecordEncoderJson,
  buildSceneCollection,
  buildUserIni,
  buildWebSocketConfig,
  obsEncoderId,
  obsOutputSize,
  recordTracksMask,
  volumeScalar
} from './obsConfig'
import { audioTrackCount } from './obsConfigFiles'

// Asserted rather than eyeballed because a wrong key in an OBS config does not
// fail -- OBS substitutes its own default for anything it does not recognise. A
// typo in 'rate_control' records at the wrong bitrate, a wrong FPSType records at
// 30 regardless of what FPSInt says, and neither produces an error anywhere.
//
// The expectations below match what OBS 32.2.1 itself wrote on this machine.

function settings(overrides: Partial<RecordingSettings> = {}): RecordingSettings {
  return { ...DEFAULT_RECORDING_SETTINGS, ...overrides }
}

const TARGET_1440: CaptureTarget = { outputIdx: 0, width: 2560, height: 1440, isHdr: false }
const TARGET_1080: CaptureTarget = { outputIdx: 0, width: 1920, height: 1080, isHdr: false }

function profile(overrides: Partial<RecordingSettings> = {}, target = TARGET_1440): string {
  return buildProfileIni({
    settings: settings(overrides),
    target,
    recordingDirectory: 'H:\\rec',
    fileBasename: 'League of Legends Draven 2026-07-30 20-43-44',
    audioTrackCount: 1
  })
}

describe('obsEncoderId', () => {
  // The '_tex' suffix is the point: those encoders take frames while still on the
  // GPU. The non-tex variants would reintroduce the readback this migration
  // exists to remove.
  it('maps NVENC to the texture-based encoder', () => {
    expect(obsEncoderId('h264_nvenc')).toBe('obs_nvenc_h264_tex')
    expect(obsEncoderId('hevc_nvenc')).toBe('obs_nvenc_hevc_tex')
    expect(obsEncoderId('av1_nvenc')).toBe('obs_nvenc_av1_tex')
  })

  it('defaults to NVENC H.264 when nothing is pinned', () => {
    expect(obsEncoderId(null)).toBe('obs_nvenc_h264_tex')
    expect(obsEncoderId(undefined)).toBe('obs_nvenc_h264_tex')
  })

  // An unknown encoder id makes OBS refuse to start the recording output at all,
  // which looks like "recording silently does nothing".
  it('falls back to x264 for an encoder it does not know', () => {
    expect(obsEncoderId('some_future_encoder')).toBe('obs_x264')
  })
})

describe('buildProfileIni', () => {
  it('uses advanced output mode, so the encoder choice is honoured', () => {
    expect(profile()).toContain('Mode=Advanced')
  })

  // FPSType 2 is OBS's default and means "fractional", which ignores FPSInt
  // entirely and records at 30 no matter what else is set.
  it('sets integer framerate, not the fractional default', () => {
    const ini = profile({ framerate: 120 })
    expect(ini).toContain('FPSType=1')
    expect(ini).toContain('FPSInt=120')
  })

  it('records Matroska, which survives the process being killed', () => {
    expect(profile()).toContain('RecFormat2=mkv')
  })

  // Observed failure: with this under [SimpleOutput] it is ignored in Advanced
  // mode and OBS names the file with its own timestamp instead.
  it('puts the filename format in [Output], where advanced mode reads it', () => {
    const ini = profile()
    const outputSection = ini.slice(ini.indexOf('[Output]'), ini.indexOf('[AdvOut]'))
    expect(outputSection).toContain('FilenameFormatting=League of Legends Draven 2026-07-30 20-43-44')
  })

  it('sets the canvas to the captured display', () => {
    const ini = profile({}, TARGET_1080)
    expect(ini).toContain('BaseCX=1920')
    expect(ini).toContain('BaseCY=1080')
  })

  it('records at native size when no scaling is asked for', () => {
    const ini = profile({ resolutionScale: 'native' })
    expect(ini).toContain('OutputCX=2560')
    expect(ini).toContain('OutputCY=1440')
  })

  it('scales the output when asked', () => {
    const ini = profile({ resolutionScale: '1080p' })
    expect(ini).toContain('OutputCX=1920')
    expect(ini).toContain('OutputCY=1080')
  })
})

describe('obsOutputSize', () => {
  it('is the display size for native capture', () => {
    expect(obsOutputSize(settings({ resolutionScale: 'native' }), TARGET_1440)).toEqual({
      width: 2560,
      height: 1440
    })
  })

  it('never upscales', () => {
    expect(obsOutputSize(settings({ resolutionScale: '1440p' }), TARGET_1080)).toEqual({
      width: 1920,
      height: 1080
    })
  })

  it('keeps the width even, which H.264 requires', () => {
    const odd: CaptureTarget = { outputIdx: 0, width: 2559, height: 1440, isHdr: false }
    expect(obsOutputSize(settings({ resolutionScale: '720p' }), odd).width % 2).toBe(0)
  })
})

describe('buildRecordEncoderJson', () => {
  // Leaving rate_control at its CBR default would ignore cqp entirely, so the
  // quality setting would silently do nothing.
  it('uses CQP with the quality value for NVENC quality mode', () => {
    const json = buildRecordEncoderJson(
      settings({ encoder: 'h264_nvenc', rateControl: 'quality', quality: 19 })
    )
    expect(json.rate_control).toBe('CQP')
    expect(json.cqp).toBe(19)
  })

  it('uses CBR with the bitrate for NVENC bitrate mode', () => {
    const json = buildRecordEncoderJson(
      settings({ encoder: 'h264_nvenc', rateControl: 'bitrate', bitrateKbps: 25000 })
    )
    expect(json.rate_control).toBe('CBR')
    expect(json.bitrate).toBe(25000)
  })

  // x264's constant-quality knob is CRF, not CQP; passing CQP would be ignored.
  it('uses CRF for x264 quality mode', () => {
    const json = buildRecordEncoderJson(
      settings({ encoder: 'libx264', rateControl: 'quality', quality: 21 })
    )
    expect(json.rate_control).toBe('CRF')
    expect(json.crf).toBe(21)
  })

  it('carries the keyframe interval through', () => {
    expect(buildRecordEncoderJson(settings({ keyframeIntervalSeconds: 2 })).keyint_sec).toBe(2)
  })
})

describe('recordTracksMask', () => {
  it('is track 1 alone for mixed audio', () => {
    expect(recordTracksMask(1)).toBe(1)
  })

  it('is tracks 1 and 2 for separate audio', () => {
    expect(recordTracksMask(2)).toBe(3)
  })
})

describe('audioTrackCount', () => {
  const desktop: AudioInputSpec = { kind: 'dshow', source: 'spk', role: 'desktop' }
  const mic: AudioInputSpec = { kind: 'dshow', source: 'mic', role: 'mic' }

  it('is one track when the sources are mixed', () => {
    expect(audioTrackCount([desktop, mic], 'mixed')).toBe(1)
  })

  it('is one per source when they are kept separate', () => {
    expect(audioTrackCount([desktop, mic], 'separate')).toBe(2)
  })

  // Separate mode with one source is still one track; a second empty track would
  // just cost an encoder.
  it('is one track for a single source regardless of mode', () => {
    expect(audioTrackCount([desktop], 'separate')).toBe(1)
  })

  it('is at least one track even with no sources', () => {
    expect(audioTrackCount([], 'mixed')).toBe(1)
  })
})

describe('buildSceneCollection', () => {
  const desktop: AudioInputSpec = { kind: 'dshow', source: 'spk', role: 'desktop', volume: 100 }
  const mic: AudioInputSpec = {
    kind: 'dshow',
    source: 'Microphone (HyperX QuadCast)',
    role: 'mic',
    volume: 80
  }

  let counter = 0
  const uuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

  function collection(overrides: Partial<Parameters<typeof buildSceneCollection>[0]> = {}) {
    counter = 0
    return buildSceneCollection({
      target: TARGET_1440,
      audioInputs: [desktop, mic],
      audioTrackMode: 'mixed',
      drawMouse: false,
      capture: LEAGUE_CAPTURE_TARGET,
      uuid,
      ...overrides
    })
  }

  function sourceById(result: Record<string, unknown>, id: string): Record<string, unknown> {
    const sources = result.sources as Array<Record<string, unknown>>
    return sources.find((source) => source.id === id) as Record<string, unknown>
  }

  it('contains a game capture source', () => {
    const capture = sourceById(collection(), 'game_capture')
    expect(capture).toBeTruthy()
    expect(capture.name).toBe(GAME_CAPTURE_SOURCE_NAME)
  })

  it('targets League by executable, which is stable across patches', () => {
    const capture = sourceById(collection(), 'game_capture')
    const config = capture.settings as Record<string, unknown>
    expect(config.capture_mode).toBe('window')
    expect(String(config.window)).toContain('League of Legends.exe')
    // priority 2 is "match by executable"; title is localised and the class can
    // change between patches.
    expect(config.priority).toBe(2)
  })

  it('can capture any fullscreen game instead', () => {
    const capture = sourceById(collection({ capture: { mode: 'any_fullscreen' } }), 'game_capture')
    expect((capture.settings as Record<string, unknown>).capture_mode).toBe('any_fullscreen')
  })

  // League has anti-cheat, and the compatibility hook is what lets capture work
  // alongside it.
  it('enables the anti-cheat compatible hook', () => {
    const capture = sourceById(collection(), 'game_capture')
    expect((capture.settings as Record<string, unknown>).anti_cheat_hook).toBe(true)
  })

  // Native WASAPI loopback. This is what makes the Chromium audio bridge
  // unnecessary -- the bundled ffmpeg has no loopback input on Windows, so
  // desktop sound previously had to travel through a hidden renderer and a socket.
  it('captures desktop audio with wasapi loopback', () => {
    const result = collection()
    const audio = result.DesktopAudioDevice1 as Record<string, unknown>
    expect(audio.id).toBe('wasapi_output_capture')
  })

  it('captures the microphone the user chose, not the system default', () => {
    const audio = collection().AuxAudioDevice1 as Record<string, unknown>
    expect((audio.settings as Record<string, unknown>).device_id).toBe(
      'Microphone (HyperX QuadCast)'
    )
  })

  it('omits audio devices that were not requested', () => {
    const result = collection({ audioInputs: [desktop] })
    expect(result.DesktopAudioDevice1).toBeTruthy()
    expect(result.AuxAudioDevice1).toBeUndefined()
  })

  // Separate tracks are the point of the setting: the editor has to be able to
  // drop the microphone without losing game sound.
  it('puts desktop and mic on different tracks when kept separate', () => {
    const result = collection({ audioTrackMode: 'separate' })
    expect((result.DesktopAudioDevice1 as Record<string, unknown>).mixers).toBe(1)
    expect((result.AuxAudioDevice1 as Record<string, unknown>).mixers).toBe(2)
  })

  it('shares one track when mixed', () => {
    const result = collection({ audioTrackMode: 'mixed' })
    expect((result.DesktopAudioDevice1 as Record<string, unknown>).mixers).toBe(255)
    expect((result.AuxAudioDevice1 as Record<string, unknown>).mixers).toBe(255)
  })

  // Without bounds, a game running below the canvas resolution is captured in
  // the corner with black around it -- the classic OBS mistake.
  it('scales the capture to fill the canvas', () => {
    const scene = sourceById(collection(), 'scene')
    const items = (scene.settings as { items: Array<Record<string, unknown>> }).items
    expect(items[0].bounds_type).toBe(2)
    expect(items[0].bounds).toEqual({ x: 2560, y: 1440 })
  })

  it('references the game capture source by its uuid', () => {
    const result = collection()
    const capture = sourceById(result, 'game_capture')
    const scene = sourceById(result, 'scene')
    const items = (scene.settings as { items: Array<Record<string, unknown>> }).items
    expect(items[0].source_uuid).toBe(capture.uuid)
  })

  it('makes its scene the active one', () => {
    const result = collection()
    expect(result.current_scene).toBe('LeagueVid')
    expect(result.current_program_scene).toBe('LeagueVid')
  })
})

describe('volumeScalar', () => {
  it('leaves full volume alone', () => {
    expect(volumeScalar(100)).toBe(1)
    expect(volumeScalar(undefined)).toBe(1)
  })

  it('is linear, matching what a 0-100 slider implies', () => {
    expect(volumeScalar(50)).toBe(0.5)
  })

  it('honours zero as silence', () => {
    expect(volumeScalar(0)).toBe(0)
  })
})

describe('buildUserIni', () => {
  it('selects the LeagueVid profile and collection', () => {
    const ini = buildUserIni()
    expect(ini).toContain('Profile=LeagueVid')
    expect(ini).toContain('SceneCollection=LeagueVid')
  })

  // The wizard is modal. If it appeared, recording would block forever with
  // nothing on screen to explain why -- OBS is started minimised to the tray.
  it('marks first run as done so the wizard cannot appear', () => {
    expect(buildUserIni()).toContain('FirstRun=true')
  })

  // Also modal, and it would block the quit path at shutdown.
  it('disables the confirm-on-exit prompt', () => {
    expect(buildUserIni()).toContain('ConfirmOnExit=false')
  })

  it('starts in the tray, since LeagueVid is the interface', () => {
    expect(buildUserIni()).toContain('SysTrayWhenStarted=true')
  })
})

describe('buildWebSocketConfig', () => {
  it('enables the server on the given port', () => {
    const config = buildWebSocketConfig(4460, 'secret')
    expect(config.server_enabled).toBe(true)
    expect(config.server_port).toBe(4460)
    expect(config.server_password).toBe('secret')
  })

  // obs-websocket does not bind to loopback only -- its own log reports a LAN
  // address as connectable. Since it can set the recording output path, an
  // unauthenticated server would let anything on the network write files.
  it('keeps authentication on', () => {
    expect(buildWebSocketConfig(4455, 'secret').auth_required).toBe(true)
  })
})
