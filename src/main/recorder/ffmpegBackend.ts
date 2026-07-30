import { existsSync } from 'fs'
import type {
  BackendAvailability,
  CaptureBackend,
  CaptureHooks,
  CaptureRequest
} from './captureBackend'
import { buildCaptureArgs } from './ffmpegArgs'
import { ffmpegBinaryPath } from './ffmpegBinary'
import { startCapture, type CaptureHandle } from './ffmpegProcess'

// The original pipeline, moved behind the backend interface without changing
// what it does.
//
// Kept rather than deleted because it is the one capture path that needs no
// binaries beyond the ffmpeg already bundled for clipping, so it is what is left
// when OBS cannot be resolved. Its limitation is structural and worth stating
// plainly: ddagrab is the Desktop Duplication API, so it captures the desktop
// rather than the game. It cannot see a game in exclusive fullscreen, it only
// receives a frame when composition changes, and its GPU readback waits behind
// the game's own queued work. On a machine under load that shows up as a file at
// the requested framerate in which most frames are repeats.
//
// So this is the fallback, not the default. See captureBackend.ts for the
// measurements behind that ordering.

export class FfmpegDdagrabBackend implements CaptureBackend {
  readonly id = 'ffmpeg-ddagrab' as const
  readonly label = 'Built-in (screen capture)'
  // Matroska survives a truncated write; MP4 without its moov atom does not,
  // and this file has to survive a crash mid-game. Converted afterwards.
  readonly sessionContainer = 'matroska' as const
  // The buffer is a tee'd segment ring on disk, assembled by the service.
  readonly ownsReplayBuffer = false

  async probe(): Promise<BackendAvailability> {
    try {
      const path = ffmpegBinaryPath()
      if (!existsSync(path)) {
        return { available: false, reason: 'The bundled video encoder is missing from this build.' }
      }
      return { available: true }
    } catch (err) {
      return { available: false, reason: (err as Error).message }
    }
  }

  async start(request: CaptureRequest, hooks: CaptureHooks): Promise<CaptureHandle> {
    const args = buildCaptureArgs(
      {
        settings: request.settings,
        target: request.target,
        outputPath: request.outputPath,
        audioInputs: request.audioInputs,
        replay: request.replay
      },
      request.fallbackEncoder
    )

    // startCapture throws synchronously if the child cannot be spawned. Inside
    // an async method that surfaces as a rejection, which is what the interface
    // promises.
    return startCapture({
      ffmpegPath: ffmpegBinaryPath(),
      args,
      onProgress: hooks.onProgress,
      onFirstFrames: hooks.onFirstFrames,
      onStderr: hooks.onStderr
    })
  }
}

export const ffmpegBackend = new FfmpegDdagrabBackend()
