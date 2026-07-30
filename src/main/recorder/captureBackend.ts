import type { RecorderProgress, RecordingSettings } from '../../shared/types'
import type { AudioInputSpec, CaptureTarget, ReplayRingSpec } from './ffmpegArgs'
import type { CaptureHandle } from './ffmpegProcess'

// The seam between "record this game" and whatever actually captures it.
//
// This exists because the original pipeline was the wrong tool and could not be
// tuned into the right one. ffmpeg's ddagrab filter is the Desktop Duplication
// API: a screen scraper living outside the game, which only receives a frame
// when desktop composition changes and whose readback queues behind whatever the
// game has already handed the GPU. Measured on a real session, that produced
// 1186 distinct frames inside a 5777-frame file -- about 6 new frames a second,
// with 385 separate freezes -- while every counter ffmpeg reports said the
// capture was healthy.
//
// The fix is a different capture technology, not different settings, so the
// recorder needs somewhere to put a second one. OBS's game capture hooks the
// game's own Present call and reads its swapchain directly, never asking the
// desktop for anything. That is what Outplayed ships (verified: OBS 31.0.0 with
// win-capture, ow-graphics-hook64.dll and inject-helper64.exe) and it is why
// theirs is smooth.
//
// Deliberately shaped around what the *recorder* needs rather than around what
// either implementation happens to do, so neither leaks. The ffmpeg path stays
// as a fallback rather than being deleted: it needs no extra binaries, so it is
// what remains when OBS cannot be resolved.

/**
 * One recording session, described semantically.
 *
 * Note there is no argv here. Turning this into a command line is the ffmpeg
 * backend's private business, and turning it into a scene collection is the OBS
 * backend's -- the previous shape passed built arguments through the service,
 * which is exactly what made a second implementation impossible to add.
 */
export interface CaptureRequest {
  settings: RecordingSettings
  target: CaptureTarget
  /** Where the session file goes. Extension is the backend's to choose. */
  outputPath: string
  audioInputs: AudioInputSpec[]
  /**
   * Set when the replay buffer is on.
   *
   * Only meaningful to a backend whose ownsReplayBuffer is false. The ffmpeg
   * path needs the ring described because it implements the buffer itself with
   * the tee muxer and a segment ring; OBS has its own replay buffer output and
   * ignores this.
   */
  replay?: ReplayRingSpec
  /** Encoder to use when settings pin none -- whatever probing ranked first. */
  fallbackEncoder?: string
}

export interface CaptureHooks {
  onProgress?: (sample: RecorderProgress) => void
  /** Called once the backend is confident real frames are being encoded. */
  onFirstFrames?: (sample: RecorderProgress) => void
  /** Diagnostic output, for the recordings row when something goes wrong. */
  onStderr?: (line: string) => void
}

/**
 * Why a backend can or cannot be used, in terms a settings screen can show.
 *
 * A reason is required when unavailable. "OBS backend unavailable" tells the
 * user nothing they can act on, and the two causes -- binaries missing versus
 * the process refusing to start -- need different responses.
 */
export interface BackendAvailability {
  available: boolean
  /** Present when unavailable; plain language, naming what to do about it. */
  reason?: string
  /** Version of the underlying capture engine, when it can be determined. */
  version?: string
}

export type CaptureBackendId = 'ffmpeg-ddagrab' | 'obs'

export interface CaptureBackend {
  readonly id: CaptureBackendId
  /** Shown in Settings. */
  readonly label: string
  /**
   * Container the session file is written in.
   *
   * Drives whether the post-capture step has to remux. The ffmpeg path writes
   * Matroska deliberately -- a truncated MP4 has no moov atom and will not play,
   * and that file exists to survive a crash mid-game -- then converts. A backend
   * that already writes a crash-safe MP4 must not be put through a pointless
   * re-containerisation.
   */
  readonly sessionContainer: 'matroska' | 'mp4'
  /**
   * True when the backend can record system sound by itself.
   *
   * This exists to stop work being done that is not only unnecessary but
   * actively harmful. The ffmpeg path has no WASAPI loopback input on Windows, so
   * desktop audio has to travel through a hidden Chromium window and a localhost
   * socket -- a bridge that can fail, and did, producing "System audio couldn't
   * be captured" on a backend that never needed it. OBS ships win-wasapi and
   * captures loopback natively.
   */
  readonly capturesDesktopAudioNatively: boolean
  /**
   * True when the backend implements the replay buffer itself.
   *
   * The two approaches are not compatible: the ffmpeg path tees the encode into
   * a segment ring on disk that the service later concatenates, whereas OBS
   * keeps its buffer in memory and writes a file when asked. The service has to
   * know which one it is talking to before it goes looking for segments.
   */
  readonly ownsReplayBuffer: boolean

  /** Checked before selection, and reported in Settings. */
  probe(): Promise<BackendAvailability>

  /**
   * Begins capturing. Rejects if the capture could not be started at all.
   *
   * Async because a backend may need a handshake before it can honestly say
   * capture began -- OBS has to be spawned and connected to, and reporting
   * success before that is what turns a failed start into a silently empty
   * recording.
   */
  start(request: CaptureRequest, hooks: CaptureHooks): Promise<CaptureHandle>

  /**
   * Saves the last N seconds, for backends that own their replay buffer.
   *
   * Returns the file written. Backends with ownsReplayBuffer false leave this
   * undefined and the service uses the segment ring instead.
   */
  saveReplay?(): Promise<{ outputPath: string; durationSeconds: number }>
}
