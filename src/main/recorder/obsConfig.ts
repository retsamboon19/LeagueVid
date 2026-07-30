import type { RecordingSettings } from '../../shared/types'
import type { AudioInputSpec, CaptureTarget } from './ffmpegArgs'
import { effectiveScaleHeight } from './ffmpegArgs'

// Generates the OBS profile and scene collection LeagueVid records with.
//
// Pure: no filesystem, no spawning. That matters more here than it looks, for the
// same reason it mattered for the ffmpeg arguments -- a wrong key in an OBS
// config is *quiet*. OBS silently substitutes its own default for anything it
// does not recognise, so a typo in 'rate_control' does not fail, it records at
// the wrong bitrate. Being able to assert the generated config in a test is the
// only way to catch that without recording a game and inspecting the result.
//
// Every field below was checked against what OBS 32.2.1 itself wrote on this
// machine when run once with --portable, rather than recalled. The scene
// collection format in particular is not documented anywhere useful.

/**
 * OBS's encoder ids, which are not the ffmpeg names LeagueVid stores.
 *
 * The '_tex' suffix is the important part: those are the texture-based encoders
 * that take frames while they are still on the GPU. The non-tex variants exist
 * for sources already in system memory and would reintroduce exactly the
 * readback this whole migration is meant to remove.
 *
 * Confirmed available on this machine from the OBS log:
 *   obs_nvenc_h264_tex, obs_nvenc_hevc_tex, obs_nvenc_av1_tex
 */
const ENCODER_IDS: Record<string, string> = {
  h264_nvenc: 'obs_nvenc_h264_tex',
  hevc_nvenc: 'obs_nvenc_hevc_tex',
  av1_nvenc: 'obs_nvenc_av1_tex',
  h264_qsv: 'obs_qsv11_v2',
  h264_amf: 'h264_texture_amf',
  libx264: 'obs_x264'
}

/** Used when nothing better is known. x264 exists in every OBS build. */
const FALLBACK_ENCODER_ID = 'obs_x264'

/**
 * Escapes a value for OBS's ini parser.
 *
 * OBS treats backslash as an escape character in ini values, so a Windows path
 * written literally is silently misread. Not theoretical: recording failed with
 * "Recording stopped because of bad output path" because
 * `H:\LeagueVid\recordings` was parsed with `\r` as a carriage return, giving
 * `H:LeagueVid<CR>ecordings`. OBS then rewrote the file as
 * `H:\\LeagueVid\recordings`, which is how the escaping became visible.
 *
 * It also explains why this survived testing. The paths used during development
 * -- under `...\AppData\Local\Temp\...` -- contain no character that forms an
 * escape sequence, so they round-tripped intact and the fault only appeared
 * against a real recordings folder.
 */
export function escapeIniValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/**
 * Translates a LeagueVid encoder choice into an OBS encoder id.
 *
 * Falls back to x264 rather than guessing, because an unknown encoder id makes
 * OBS refuse to start the recording output at all -- a failure that would look
 * like "recording silently does nothing".
 */
export function obsEncoderId(encoder: string | null | undefined): string {
  if (!encoder) return ENCODER_IDS.h264_nvenc
  return ENCODER_IDS[encoder] ?? FALLBACK_ENCODER_ID
}

export interface ObsProfileInput {
  settings: RecordingSettings
  target: CaptureTarget
  /** Directory OBS writes the session file into. */
  recordingDirectory: string
  /** Exact basename, without extension. OBS appends the container's own. */
  fileBasename: string
  /** Encoder to use when settings pin none. */
  fallbackEncoder?: string
  /** How many audio tracks to record. */
  audioTrackCount: number
}

/**
 * Output resolution, honouring the scale setting.
 *
 * Worth noting that scaling is cheap here in a way it was not before. Under
 * ddagrab a non-native resolution forced a GPU-to-system-memory round trip per
 * frame and cost more than the pixels saved; OBS scales on the GPU as part of
 * compositing, so the setting now means what a user would expect it to mean.
 */
export function obsOutputSize(
  settings: RecordingSettings,
  target: CaptureTarget
): { width: number; height: number } {
  const scaleHeight = effectiveScaleHeight(settings, target)
  if (scaleHeight === null) return { width: target.width, height: target.height }

  const aspect = target.width / target.height
  // Even width: H.264 requires it, and OBS will not silently round for us.
  const width = Math.round((scaleHeight * aspect) / 2) * 2
  return { width, height: scaleHeight }
}

/**
 * Which tracks the recording includes, as OBS's bitmask.
 *
 * Track 1 is bit 0. Mixed audio needs only track 1; separate tracks need 1 and 2
 * so the editor can mute the microphone without losing game sound.
 */
export function recordTracksMask(trackCount: number): number {
  if (trackCount <= 1) return 1
  return (1 << trackCount) - 1
}

/**
 * The profile's basic.ini.
 *
 * Advanced output mode deliberately: Simple mode exposes a fixed menu of
 * quality presets and will not accept an explicit encoder plus explicit rate
 * control, which is the whole point of having recording settings.
 */
export function buildProfileIni(input: ObsProfileInput): string {
  const { settings, target, recordingDirectory, fileBasename } = input
  const encoderId = obsEncoderId(settings.encoder ?? input.fallbackEncoder)
  const output = obsOutputSize(settings, target)

  const lines = [
    '[General]',
    'Name=LeagueVid',
    '',
    '[Output]',
    // Advanced, so RecEncoder and recordEncoder.json are honoured.
    'Mode=Advanced',
    // The exact basename LeagueVid wants, which is read from [Output] for both
    // output modes -- putting it under [SimpleOutput] does nothing in Advanced
    // mode, and OBS then names the file with its own timestamp instead. Observed
    // doing precisely that before this moved.
    `FilenameFormatting=${escapeIniValue(fileBasename)}`,
    // Off, so the name above is used verbatim rather than having a counter or a
    // second timestamp appended.
    'OverwriteIfExists=true',
    '',
    '[AdvOut]',
    'RecType=Standard',
    // Matroska, for the same reason the ffmpeg path chose it: this file has to
    // survive the process dying mid-game, and a truncated MP4 has no moov atom
    // and will not play at all. Converted to MP4 afterwards.
    'RecFormat2=mkv',
    `RecEncoder=${encoderId}`,
    `RecFilePath=${escapeIniValue(recordingDirectory)}`,
    `RecTracks=${recordTracksMask(input.audioTrackCount)}`,
    // Off: LeagueVid supplies the exact filename and does its own retention.
    'RecRBSuffix=Replay',
    'FileNameWithoutSpace=false',
    '',
    '[Video]',
    // Base canvas is the display being captured; game capture is scaled to fit
    // it, so a game running at a different resolution still fills the frame.
    `BaseCX=${target.width}`,
    `BaseCY=${target.height}`,
    `OutputCX=${output.width}`,
    `OutputCY=${output.height}`,
    // FPSType 1 means "integer FPS", read from FPSInt. The default is 2, a
    // fraction, which ignores FPSInt entirely and silently records at 30.
    'FPSType=1',
    `FPSInt=${settings.framerate}`,
    // Bicubic downscale: the default bilinear is visibly soft on UI text, which
    // is half of what makes a VOD readable.
    'ScaleType=bicubic',
    '',
    '[Audio]',
    'SampleRate=48000',
    'ChannelSetup=Stereo',
    ''
  ]

  return lines.join('\n')
}

/**
 * The record encoder's own settings file.
 *
 * Separate from basic.ini because that is where OBS looks: in Advanced mode the
 * recording encoder's parameters live in recordEncoder.json inside the profile
 * directory, and anything put in basic.ini instead is ignored without complaint.
 */
export function buildRecordEncoderJson(
  settings: RecordingSettings,
  fallbackEncoder?: string
): Record<string, unknown> {
  const encoderId = obsEncoderId(settings.encoder ?? fallbackEncoder)
  const isNvenc = encoderId.startsWith('obs_nvenc')
  const isX264 = encoderId === 'obs_x264'

  const common = {
    keyint_sec: Math.max(0, Math.round(settings.keyframeIntervalSeconds)),
    bitrate: Math.round(settings.bitrateKbps)
  }

  if (settings.rateControl === 'quality') {
    if (isNvenc) {
      return {
        ...common,
        // CQP is NVENC's constant-quality mode. 'cqp' is the knob; leaving
        // rate_control at its CBR default would ignore it entirely.
        rate_control: 'CQP',
        cqp: Math.round(settings.quality),
        preset2: 'p5',
        profile: 'high',
        // Adaptive quantisation spends bits where the eye looks, which is worth
        // it on the dark, high-contrast scenes League is mostly made of.
        psycho_aq: true,
        lookahead: false,
        multipass: 'disabled'
      }
    }
    if (isX264) {
      return { ...common, rate_control: 'CRF', crf: Math.round(settings.quality), preset: 'veryfast' }
    }
    return { ...common, rate_control: 'CQP', cqp: Math.round(settings.quality) }
  }

  if (isNvenc) {
    return {
      ...common,
      rate_control: 'CBR',
      preset2: 'p5',
      profile: 'high',
      psycho_aq: true,
      lookahead: false,
      multipass: 'disabled'
    }
  }

  return { ...common, rate_control: 'CBR', ...(isX264 ? { preset: 'veryfast' } : {}) }
}

/** Fixed UUID of libobs' main canvas, as written by OBS 32. */
const MAIN_CANVAS_UUID = '6c69626f-6273-4c00-9d88-c5136d61696e'

export const GAME_CAPTURE_SOURCE_NAME = 'Game Capture'
export const SCENE_NAME = 'LeagueVid'

/**
 * How game capture should find the game.
 *
 * 'window' with an executable match is the reliable choice for a known game and
 * is what LeagueVid uses, since it always knows it is recording League. The
 * window string is OBS's 'title:class:executable' triple.
 *
 * 'any_fullscreen' is the fallback for anything else, and is what makes this
 * useful for a manual recording of a game LeagueVid has no knowledge of.
 */
export interface GameCaptureTarget {
  mode: 'window' | 'any_fullscreen'
  /** OBS 'title:class:executable'. Required for window mode. */
  window?: string
}

/** League's game client, as game capture needs to match it. */
export const LEAGUE_GAME_WINDOW = 'League of Legends (TM) Client:RiotWindowClass:League of Legends.exe'

export const LEAGUE_CAPTURE_TARGET: GameCaptureTarget = {
  mode: 'window',
  window: LEAGUE_GAME_WINDOW
}

export interface ObsSceneInput {
  target: CaptureTarget
  audioInputs: AudioInputSpec[]
  audioTrackMode: RecordingSettings['audioTrackMode']
  drawMouse: boolean
  capture: GameCaptureTarget
  /** Injected so the generated collection is deterministic in tests. */
  uuid?: () => string
}

/**
 * The scene collection JSON.
 *
 * Shape verified against the collection OBS 32.2.1 wrote itself; the important
 * details are that global audio devices sit at the top level under
 * DesktopAudioDevice1 / AuxAudioDevice1 rather than in sources, and that a scene
 * references its contents by uuid through settings.items while the sources
 * themselves are separate entries in the sources array.
 */
export function buildSceneCollection(input: ObsSceneInput): Record<string, unknown> {
  const nextUuid = input.uuid ?? (() => crypto.randomUUID())
  const gameCaptureUuid = nextUuid()
  const sceneUuid = nextUuid()

  const desktop = input.audioInputs.find((source) => source.role === 'desktop')
  const mic = input.audioInputs.find((source) => source.role === 'mic')
  const separate = input.audioTrackMode === 'separate'

  const collection: Record<string, unknown> = {
    name: 'LeagueVid',
    sources: [
      gameCaptureSource(gameCaptureUuid, input),
      sceneSource(sceneUuid, gameCaptureUuid, input.target)
    ],
    groups: [],
    scene_order: [{ name: SCENE_NAME }],
    current_scene: SCENE_NAME,
    current_program_scene: SCENE_NAME,
    canvases: [],
    current_transition: 'Cut',
    transition_duration: 0,
    transitions: [],
    saved_projectors: [],
    version: 2
  }

  if (desktop) {
    collection.DesktopAudioDevice1 = audioSource({
      uuid: nextUuid(),
      name: 'Desktop Audio',
      // WASAPI loopback, natively. This is the whole reason the Chromium audio
      // bridge existed: the bundled ffmpeg has no loopback input on Windows, so
      // desktop sound had to be routed through a hidden renderer and a socket.
      // OBS ships win-wasapi, so none of that is needed here.
      id: 'wasapi_output_capture',
      deviceId: 'default',
      volume: volumeScalar(desktop.volume),
      // Track 1 always carries desktop audio; separate mode simply stops the
      // microphone sharing it.
      mixers: separate ? 1 : 255
    })
  }

  if (mic) {
    collection.AuxAudioDevice1 = audioSource({
      uuid: nextUuid(),
      name: 'Mic/Aux',
      id: 'wasapi_input_capture',
      // Deliberately the Windows default rather than the name the user picked.
      //
      // wasapi_input_capture's device_id is a Windows endpoint id -- an opaque
      // string like '{0.0.1.00000000}.{guid}' -- not a friendly name. Passing the
      // friendly name fails: observed as
      //   [WASAPISource::TryInitialize]:[Microphone (HyperX QuadCast)]
      //   Failed to enumerate device: 80070057
      // followed by "Device failed to start", i.e. a recording with no
      // microphone at all.
      //
      // The default device is right for almost everyone and is a working
      // microphone rather than a broken one. The specific device the user chose
      // is applied after OBS starts, once its own enumeration can map the name
      // to an id -- see ObsSession.applyMicrophoneChoice.
      deviceId: 'default',
      volume: volumeScalar(mic.volume),
      mixers: separate ? 2 : 255
    })
  }

  return collection
}

/** 0-100 as the linear multiplier OBS stores. */
export function volumeScalar(volume: number | undefined): number {
  if (volume == null) return 1
  const clamped = Math.min(100, Math.max(0, volume))
  return Number((clamped / 100).toFixed(4))
}

function gameCaptureSource(uuid: string, input: ObsSceneInput): Record<string, unknown> {
  const settings: Record<string, unknown> =
    input.capture.mode === 'window'
      ? {
          capture_mode: 'window',
          window: input.capture.window,
          // Match on executable. Titles are localised and the class can change
          // between patches, but the exe name is stable.
          priority: 2
        }
      : { capture_mode: 'any_fullscreen' }

  return {
    prev_ver: 537001985,
    name: GAME_CAPTURE_SOURCE_NAME,
    uuid,
    id: 'game_capture',
    versioned_id: 'game_capture',
    settings: {
      ...settings,
      capture_cursor: input.drawMouse,
      // Compatibility hooking. Costs nothing when unnecessary and is what lets
      // capture work with anti-cheat present, which League has.
      anti_cheat_hook: true,
      // Never limit to the game's own rate here: the recording framerate is set
      // once, in the profile, and limiting in two places compounds.
      limit_framerate: false,
      capture_overlays: false,
      allow_transparency: false,
      force_scaling: false,
      hook_rate: 1
    },
    mixers: 0,
    sync: 0,
    flags: 0,
    volume: 1.0,
    balance: 0.5,
    enabled: true,
    muted: false,
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {}
  }
}

function sceneSource(
  uuid: string,
  gameCaptureUuid: string,
  target: CaptureTarget
): Record<string, unknown> {
  return {
    prev_ver: 537001985,
    name: SCENE_NAME,
    uuid,
    id: 'scene',
    versioned_id: 'scene',
    settings: {
      id_counter: 1,
      custom_size: false,
      items: [
        {
          name: GAME_CAPTURE_SOURCE_NAME,
          source_uuid: gameCaptureUuid,
          visible: true,
          locked: false,
          rot: 0.0,
          pos: { x: 0.0, y: 0.0 },
          scale: { x: 1.0, y: 1.0 },
          align: 5,
          // Scale-to-inner-bounds against the canvas. Without bounds, a game
          // running at a lower resolution than the canvas is captured in the
          // corner with black around it, which is the classic OBS mistake.
          bounds_type: 2,
          bounds_alignment: 0,
          bounds: { x: target.width, y: target.height },
          crop_left: 0,
          crop_top: 0,
          crop_right: 0,
          crop_bottom: 0,
          id: 1,
          group_item_backup: false,
          scale_filter: 'disable',
          blend_method: 'default',
          blend_type: 'normal',
          show_transition: { duration: 0 },
          hide_transition: { duration: 0 }
        }
      ]
    },
    mixers: 0,
    sync: 0,
    flags: 0,
    volume: 1.0,
    balance: 0.5,
    enabled: true,
    muted: false,
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    canvas_uuid: MAIN_CANVAS_UUID,
    private_settings: {}
  }
}

function audioSource(input: {
  uuid: string
  name: string
  id: string
  deviceId: string
  volume: number
  mixers: number
}): Record<string, unknown> {
  return {
    prev_ver: 537001985,
    name: input.name,
    uuid: input.uuid,
    id: input.id,
    versioned_id: input.id,
    settings: { device_id: input.deviceId },
    mixers: input.mixers,
    sync: 0,
    flags: 0,
    volume: input.volume,
    balance: 0.5,
    enabled: true,
    muted: false,
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {}
  }
}

/**
 * user.ini, which is what actually selects the profile and scene collection.
 *
 * OBS 30 and later split what used to be global.ini: the per-user selection now
 * lives here, and writing it to global.ini has no effect. Also sets FirstRun so
 * the auto-configuration wizard cannot appear -- it is modal, and a modal dialog
 * would block recording forever with nothing on screen to explain why.
 */
export function buildUserIni(): string {
  return [
    '[General]',
    'FirstRun=true',
    'ConfirmOnExit=false',
    '',
    '[Basic]',
    'Profile=LeagueVid',
    'ProfileDir=LeagueVid',
    'SceneCollection=LeagueVid',
    'SceneCollectionFile=LeagueVid',
    '',
    '[BasicWindow]',
    'SysTrayEnabled=true',
    // Started minimised to the tray: LeagueVid is the user interface, and a
    // second window appearing when a game starts would be alarming.
    'SysTrayWhenStarted=true',
    'PreviewEnabled=false',
    ''
  ].join('\n')
}

/**
 * obs-websocket's config file.
 *
 * Authentication stays on with a generated password. obs-websocket does not bind
 * to loopback only, so disabling auth -- tempting, since we generate both ends --
 * would expose full control of OBS, including arbitrary file output paths, to
 * anything that can reach the machine.
 */
export function buildWebSocketConfig(port: number, password: string): Record<string, unknown> {
  return {
    alerts_enabled: false,
    auth_required: true,
    first_load: false,
    server_enabled: true,
    server_password: password,
    server_port: port
  }
}
