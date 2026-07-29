import { screen } from 'electron'
import { GameWatcher } from '../league/gameWatcher'
import { fetchMatchHint } from '../league/lcuClient'
import { getSettings, getRecordingSettings, getEncoderCapabilitiesCache } from '../db/repository'
import { AutoRecorder } from './autoRecorder'
import { checkFreeSpaceForStart, checkFreeSpaceWhileRecording, DISK_CHECK_INTERVAL_MS } from './diskSpace'
import { mapDisplaysToOutputs, resolveCaptureDisplay } from './displays'
import type { AudioInputSpec, CaptureTarget } from './ffmpegArgs'
import { startLoopbackBridge, stopLoopbackBridge } from './loopbackAudio'
import { recordingsDir } from './outputPaths'
import {
  hasActiveCapture,
  isProducingFrames,
  onFramesFlowing,
  persistLiveEventsForCurrentSession,
  reportRecorderProblem,
  startRecording,
  stopForGameEnd,
  stopRecording
} from './recorderService'

// Assembles the automatic recording pipeline: the game watcher, the decision
// layer, and the service that owns the capture child.
//
// This module is deliberately thin and untested -- it is wiring. Everything it
// wires has its own tests, which is what makes leaving this part to integration
// verification reasonable rather than lazy.

let watcher: GameWatcher | null = null
let auto: AutoRecorder | null = null
let diskTimer: NodeJS.Timeout | null = null

/** The display a recording started now would capture, or null if there is none. */
export function currentCaptureTarget(): CaptureTarget | null {
  return currentTarget()
}

function currentTarget(): CaptureTarget | null {
  const settings = getRecordingSettings()
  const displays = mapDisplaysToOutputs(
    screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      size: d.size,
      scaleFactor: d.scaleFactor,
      internal: d.internal,
      label: d.label,
      rotation: d.rotation
    })),
    screen.getPrimaryDisplay().id
  )

  const resolved = resolveCaptureDisplay(displays, settings.displayId)
  if (!resolved) return null

  if (resolved.substitutedFor != null) {
    reportRecorderProblem(
      `The monitor chosen for recording isn't connected, so ${resolved.display.label} is being used instead.`
    )
  }

  return {
    outputIdx: resolved.display.outputIdx,
    width: resolved.display.width,
    height: resolved.display.height,
    // Detecting Windows HDR needs an API Electron doesn't expose. ddagrab is
    // given allow_fallback=1 regardless, so an HDR display still captures --
    // the preflight test is where a washed-out result gets diagnosed.
    isHdr: false
  }
}

/**
 * Audio inputs for a session, starting the loopback bridge if it's wanted.
 *
 * Failure to start the bridge degrades to recording without system audio and
 * says so, rather than failing the recording: losing the game is worse than
 * losing its sound. What it must never do is quietly produce a silent track.
 */
export async function resolveAudioInputs(): Promise<AudioInputSpec[]> {
  const settings = getRecordingSettings()
  const inputs: AudioInputSpec[] = []

  if (settings.micDeviceName) {
    inputs.push({ kind: 'dshow', source: settings.micDeviceName, role: 'mic' })
  }

  // A real loopback device the user has installed takes precedence: it's fewer
  // moving parts than the bridge.
  if (settings.desktopAudioDeviceName) {
    inputs.push({ kind: 'dshow', source: settings.desktopAudioDeviceName, role: 'desktop' })
    return inputs
  }

  if (settings.useLoopbackBridge) {
    try {
      const bridge = await startLoopbackBridge()
      inputs.push({ kind: 'loopback-socket', source: bridge.url, role: 'desktop' })
    } catch (err) {
      reportRecorderProblem(
        `System audio couldn't be captured, so this recording has no game sound: ${
          (err as Error).message
        }`
      )
    }
  }

  return inputs
}

/** Synchronous count, for the disk estimate before a session starts. */
function audioInputCount(): number {
  const settings = getRecordingSettings()
  let count = settings.micDeviceName ? 1 : 0
  if (settings.desktopAudioDeviceName || settings.useLoopbackBridge) count += 1
  return count
}

/** The platform of the first linked account, for composing the match id. */
function primaryPlatform(): string | null {
  return getSettings()?.accounts[0]?.platform ?? null
}

export function startAutoRecording(): void {
  if (watcher) return

  auto = new AutoRecorder({
    getSettings: getRecordingSettings,
    resolveTarget: currentTarget,
    checkDisk: (target) => {
      const check = checkFreeSpaceForStart(
        recordingsDir(),
        getRecordingSettings(),
        target,
        audioInputCount()
      )
      return { ok: check.ok, reason: check.reason }
    },
    fetchMatchHint: async () => {
      const platform = primaryPlatform()
      // No linked account means no platform, so no match id can be composed.
      // Recording still happens; linking falls back to searching.
      if (!platform) return { matchId: null, queueId: null }
      const hint = await fetchMatchHint(platform)
      return { matchId: hint.matchId, queueId: hint.queueId }
    },
    startRecording: async (options) => {
      await startRecording({
        championName: options.championName,
        matchIdHint: options.matchIdHint,
        queueId: options.queueId,
        gameStartMs: options.gameStartMs,
        platform: primaryPlatform(),
        puuid: getSettings()?.accounts[0]?.puuid ?? null,
        target: options.target,
        audioInputs: await resolveAudioInputs(),
        fallbackEncoder: getEncoderCapabilitiesCache()?.chosen ?? 'libx264'
      })
    },
    stopForGameEnd: async () => {
      await stopForGameEnd()
    },
    stopWithReason: async (reason) => {
      await stopRecording(reason)
    },
    isCapturing: hasActiveCapture,
    isProducingFrames,
    persistLiveEvents: persistLiveEventsForCurrentSession,
    setWatcherRecording: (recording) => watcher?.setRecording(recording),
    reportProblem: reportRecorderProblem
  })

  // The service tells the decision layer when frames arrive, which is what
  // satisfies the second half of the readiness gate.
  onFramesFlowing(() => auto?.notifyFramesFlowing())

  watcher = new GameWatcher({
    onEvent: (event) => {
      void auto?.handleWatcherEvent(event)
    }
  })
  watcher.start()

  // Free space is re-checked while recording so a full disk stops the session
  // cleanly instead of taking the rest of the machine down with it.
  diskTimer = setInterval(() => {
    if (!hasActiveCapture()) return
    const check = checkFreeSpaceWhileRecording(recordingsDir())
    if (check.shouldStop && check.reason) {
      void auto?.stopForDiskSpace(check.reason)
    }
  }, DISK_CHECK_INTERVAL_MS)
}

export function stopAutoRecording(): void {
  // The bridge holds a hidden window and a listening socket, so it has to go
  // with the rest of the pipeline.
  stopLoopbackBridge()
  watcher?.stop()
  watcher = null
  auto?.dispose()
  auto = null
  onFramesFlowing(null)
  if (diskTimer) {
    clearInterval(diskTimer)
    diskTimer = null
  }
}
