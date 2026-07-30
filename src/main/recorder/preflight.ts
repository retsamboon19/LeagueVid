import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RecordingSettings } from '../../shared/types'
import { buildCaptureArgs, type AudioInputSpec, type CaptureTarget } from './ffmpegArgs'
import { ffmpegBinaryPath } from './ffmpegBinary'
import { startCapture } from './ffmpegProcess'
import { assessPreflight, measurementFromProgress, type PreflightVerdict } from './presets'

// Runs a short recording with the exact configured pipeline and reports what
// actually happened.
//
// The point is that nothing here is modelled. The estimator can tell you what a
// configuration should cost; only a real capture can tell you whether this
// machine sustains it -- and the ddagrab behaviour observed during development,
// where the display opens and no frames arrive, is invisible to any amount of
// static analysis.
//
// Written to the OS temp folder and deleted afterwards: a test recording has no
// business appearing in the library.

export const PREFLIGHT_DURATION_SECONDS = 10

export interface PreflightResult {
  verdict: PreflightVerdict
  frames: number
  droppedFrames: number
  averageFps: number
  targetFps: number
  sizeBytes: number
  durationSeconds: number
}

export async function runPreflightTest(input: {
  settings: RecordingSettings
  target: CaptureTarget
  audioInputs?: AudioInputSpec[]
  fallbackEncoder?: string
  durationSeconds?: number
}): Promise<PreflightResult> {
  const durationSeconds = input.durationSeconds ?? PREFLIGHT_DURATION_SECONDS
  const outputPath = join(tmpdir(), `leaguevid-preflight-${Date.now()}.mkv`)

  const args = buildCaptureArgs(
    {
      settings: input.settings,
      target: input.target,
      outputPath,
      audioInputs: input.audioInputs ?? []
    },
    input.fallbackEncoder
  )

  let error: string | null = null

  try {
    const handle = startCapture({ ffmpegPath: ffmpegBinaryPath(), args })

    // Stop by asking, exactly as a real recording does, so the test exercises
    // the same path -- including the container being finalized.
    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000))
    const exit = await handle.stop()

    if (exit.code !== 0 && exit.lastProgress === null) {
      error = exit.stderrTail.trim() || `The encoder exited with code ${exit.code}.`
    }

    const measurement = measurementFromProgress(
      exit.lastProgress,
      input.settings.framerate,
      error,
      input.settings.resolutionScale !== 'native'
    )

    return {
      verdict: assessPreflight(measurement),
      frames: measurement.frames,
      droppedFrames: measurement.droppedFrames,
      averageFps: measurement.averageFps,
      targetFps: measurement.targetFps,
      sizeBytes: measurement.sizeBytes,
      durationSeconds: measurement.durationSeconds
    }
  } catch (err) {
    const measurement = measurementFromProgress(
      null,
      input.settings.framerate,
      (err as Error).message,
      input.settings.resolutionScale !== 'native'
    )
    return {
      verdict: assessPreflight(measurement),
      frames: 0,
      droppedFrames: 0,
      averageFps: 0,
      targetFps: input.settings.framerate,
      sizeBytes: 0,
      durationSeconds: 0
    }
  } finally {
    // The measurements come from ffmpeg's progress stream, so the file itself is
    // of no further use.
    try {
      if (existsSync(outputPath)) unlinkSync(outputPath)
    } catch {
      // A leftover file in the temp folder is harmless.
    }
  }
}
