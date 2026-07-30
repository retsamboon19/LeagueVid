import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync, renameSync } from 'fs'
import { basename, dirname, extname, join, normalize } from 'path'
import { randomBytes } from 'crypto'
import type { RecorderProgress } from '../../shared/types'
import type {
  BackendAvailability,
  CaptureBackend,
  CaptureHooks,
  CaptureRequest
} from './captureBackend'
import type { CaptureExit, CaptureHandle } from './ffmpegProcess'
import {
  findObsInstall,
  obsConfigRoot,
  type ObsInstall
} from './obsBinary'
import { GAME_CAPTURE_SOURCE_NAME, LEAGUE_CAPTURE_TARGET } from './obsConfig'
import { writeObsConfig } from './obsConfigFiles'
import { ObsWebSocketClient } from './obsWebSocket'

// Recording through OBS's game capture.
//
// This is the backend that fixes the problem the whole exercise started from.
// ddagrab scrapes the desktop; OBS's game_capture injects a hook into the game
// and reads its swapchain at Present, so it sees the game's own frames, works in
// exclusive fullscreen, and never waits on desktop composition. Verified on this
// machine against OBS 32.2.1: a steady 60.0 fps with zero skipped frames on both
// the renderer and the output, against 6 unique frames per second from ddagrab.
//
// OBS runs as a separate process driven over obs-websocket. That is partly
// pragmatic -- there is no maintained in-process binding for this Electron
// version -- and partly deliberate: OBS is GPL-2.0, and a process boundary is the
// clean way to combine it with anything else.
//
// One thing this backend can do that the old pipeline structurally could not:
// report whether the capture is actually attached to the game. GetSourceActive on
// the game capture source answers it directly, so "recording a black rectangle"
// is now a detectable state rather than something to infer from frame counters
// afterwards.

/** How often OBS is polled for progress. Matches the renderer's update rate. */
const POLL_INTERVAL_MS = 1000

/** How long to wait for OBS to start, connect and become ready. */
const STARTUP_TIMEOUT_MS = 45000

/** How long to wait for OBS to exit after being asked to. */
const SHUTDOWN_GRACE_MS = 15000

export class ObsGameCaptureBackend implements CaptureBackend {
  readonly id = 'obs' as const
  readonly label = 'OBS game capture'
  // Matroska for the same reason the ffmpeg path chose it: this file must survive
  // the process dying mid-game, and a truncated MP4 has no moov atom. Confirmed
  // by hard-killing OBS mid-recording -- the mkv played back fine.
  readonly sessionContainer = 'matroska' as const
  // OBS keeps its replay buffer in memory and writes a file on request, rather
  // than the service assembling one from a segment ring on disk.
  readonly ownsReplayBuffer = true

  /** Set while a session is in flight, so saveReplay can reach the same OBS. */
  private session: ObsSession | null = null

  async probe(): Promise<BackendAvailability> {
    const install = findObsInstall()
    if (!install) {
      return {
        available: false,
        reason:
          'OBS is not installed for LeagueVid yet. It records the game directly rather than ' +
          'scraping the screen, which is what keeps the capture smooth.'
      }
    }

    // Checked rather than assumed: an install missing the game capture plugin is
    // an install that would record a black screen, and that is worth catching
    // here instead of at the start of a game.
    const missing = missingComponents(install)
    if (missing.length > 0) {
      return {
        available: false,
        reason: `This OBS copy is incomplete -- missing ${missing.join(', ')}. Reinstalling it should fix it.`
      }
    }

    return { available: true, version: install.origin }
  }

  async start(request: CaptureRequest, hooks: CaptureHooks): Promise<CaptureHandle> {
    const install = findObsInstall()
    if (!install) throw new Error('OBS is not available to record with.')

    const session = new ObsSession(install, request, hooks)
    await session.start()
    this.session = session

    // Cleared when the session ends, whether it was asked to or not, so a later
    // replay-save cannot address an OBS that has gone.
    void session.exited.then(() => {
      if (this.session === session) this.session = null
    })

    return session
  }

  async saveReplay(): Promise<{ outputPath: string; durationSeconds: number }> {
    const session = this.session
    if (!session) {
      throw new Error('The replay buffer is not running. Turn it on in Settings before recording.')
    }
    return session.saveReplay()
  }
}

/** Files that have to be present for game capture and control to work at all. */
function missingComponents(install: ObsInstall): string[] {
  const required: Array<[string, string]> = [
    ['game capture', join(install.root, 'obs-plugins', '64bit', 'win-capture.dll')],
    ['the capture hook', join(install.root, 'data', 'obs-plugins', 'win-capture', 'graphics-hook64.dll')],
    ['the control plugin', join(install.root, 'obs-plugins', '64bit', 'obs-websocket.dll')],
    ['audio capture', join(install.root, 'obs-plugins', '64bit', 'win-wasapi.dll')]
  ]
  return required.filter(([, path]) => !existsSync(path)).map(([name]) => name)
}

/**
 * One OBS recording session, presented as a CaptureHandle.
 *
 * Implements the same contract the ffmpeg path does, so recorderService cannot
 * tell them apart: stop() finishes cleanly and resolves with totals, exited
 * resolves whether or not it was asked to, and isProducingFrames gates readiness.
 */
class ObsSession implements CaptureHandle {
  private obs: ChildProcess | null = null
  private client: ObsWebSocketClient | null = null
  private timer: NodeJS.Timeout | null = null

  private progress: RecorderProgress | null = null
  private framesSamples = 0
  private ready = false
  /** Whether game capture has ever reported being attached to the game. */
  private everHooked = false
  private forced = false
  private settled = false
  private stderrTail = ''

  /** Where OBS says it actually wrote the file. */
  private writtenPath: string | null = null

  private resolveExit!: (exit: CaptureExit) => void
  readonly exited: Promise<CaptureExit>

  constructor(
    private readonly install: ObsInstall,
    private readonly request: CaptureRequest,
    private readonly hooks: CaptureHooks
  ) {
    this.exited = new Promise<CaptureExit>((resolve) => {
      this.resolveExit = resolve
    })
  }

  async start(): Promise<void> {
    const port = await freePort()
    const password = randomBytes(18).toString('base64')

    const target = normalize(this.request.outputPath)
    const container = extname(target) || '.mkv'
    const fileBasename = basename(target, container)

    writeObsConfig({
      obsRoot: this.install.root,
      configRoot: obsConfigRoot(this.install),
      settings: this.request.settings,
      target: this.request.target,
      audioInputs: this.request.audioInputs,
      recordingDirectory: dirname(target),
      fileBasename,
      // League by default, because that is what LeagueVid records. Falling back
      // to any_fullscreen would silently capture whatever else is open.
      capture: LEAGUE_CAPTURE_TARGET,
      fallbackEncoder: this.request.fallbackEncoder,
      webSocketPort: port,
      webSocketPassword: password
    })

    this.obs = this.spawnObs()
    this.client = new ObsWebSocketClient(`ws://127.0.0.1:${port}`, password)

    try {
      await this.connect()
      await this.client.startRecord()
    } catch (err) {
      // A session that cannot start recording must not leave an OBS behind.
      await this.teardown(true)
      throw err
    }

    this.watchProcess()
    this.startPolling()

    if (this.request.settings.replayBufferEnabled) {
      // Best effort: losing the replay buffer is not worth losing the recording,
      // which is already running by this point.
      try {
        await this.client.startReplayBuffer()
      } catch (err) {
        this.hooks.onStderr?.(`Replay buffer did not start: ${(err as Error).message}`)
      }
    }
  }

  private spawnObs(): ChildProcess {
    const args = [
      // Keeps configuration inside the distribution rather than in the user's
      // own %APPDATA%/obs-studio.
      '--portable',
      // Allows a second OBS alongside one the user is already running, instead
      // of showing a modal "already running" warning nobody would ever see.
      '--multi',
      '--disable-updater',
      '--disable-missing-files-check',
      '--profile',
      'LeagueVid',
      '--collection',
      'LeagueVid',
      // LeagueVid is the user interface. A second window appearing when a game
      // starts would be alarming, so OBS lives in the tray.
      '--minimize-to-tray'
    ]

    const child = spawn(this.install.executable, args, {
      // OBS resolves its data and plugin directories relative to this, and finds
      // neither when started from anywhere else.
      cwd: this.install.workingDirectory,
      windowsHide: true
    })

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      this.stderrTail = (this.stderrTail + text).slice(-8000)
      this.hooks.onStderr?.(text)
    })

    return child
  }

  /**
   * Connects, retrying while OBS starts, then waits for it to be ready.
   *
   * Two separate waits on purpose. The websocket server does not exist for the
   * first second or two of OBS's life, so connecting needs retries; and being
   * connected is still not being ready -- obs-websocket accepts the connection
   * while the frontend loads and answers every request with NotReady until it
   * finishes. Both were observed on a cold start.
   */
  private async connect(): Promise<void> {
    const client = this.client
    if (!client) throw new Error('No OBS connection to use.')

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let lastError: Error | null = null

    while (Date.now() < deadline) {
      if (this.obs?.exitCode !== null && this.obs?.exitCode !== undefined) {
        throw new Error(`OBS exited during startup with code ${this.obs.exitCode}.`)
      }
      try {
        await client.connect()
        await client.waitUntilReady(Math.max(1000, deadline - Date.now()))
        return
      } catch (err) {
        lastError = err as Error
        await delay(600)
      }
    }

    throw new Error(`OBS did not become ready: ${lastError?.message ?? 'timed out'}`)
  }

  private watchProcess(): void {
    this.obs?.on('close', (code) => this.finish(code))
    this.obs?.on('error', (err) => {
      this.stderrTail = (this.stderrTail + `\n${err.message}`).slice(-8000)
      this.finish(null)
    })
  }

  private startPolling(): void {
    this.timer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)
  }

  /**
   * One progress sample, translated into the shape the recorder already speaks.
   *
   * The interesting asymmetry with ffmpeg: OBS does not pad the output to hold a
   * constant framerate, so there is no duplicate-frame count to interpret. A
   * capture that receives nothing produces no frames rather than a full-rate file
   * of repeats, which is why this backend cannot fail the way the old one did.
   */
  private async poll(): Promise<void> {
    const client = this.client
    if (!client || !client.isConnected) return

    try {
      const [stats, status, source] = await Promise.all([
        client.stats(),
        client.recordStatus(),
        client
          .sourceActive(GAME_CAPTURE_SOURCE_NAME)
          .catch(() => ({ videoActive: false, videoShowing: false }))
      ])

      if (source.videoActive) this.everHooked = true

      const sample: RecorderProgress = {
        frame: stats.outputTotalFrames,
        fps: stats.activeFps,
        totalSizeBytes: status.outputBytes,
        outTimeMs: status.outputDuration,
        // Both kinds of loss matter and neither is the other: renderSkipped means
        // libobs could not composite in time, outputSkipped means the encoder or
        // the disk could not keep up.
        dropFrames: stats.renderSkippedFrames + stats.outputSkippedFrames,
        // Always zero, and truthfully so -- see the note above.
        dupFrames: 0,
        // OBS records in real time or drops frames trying; there is no
        // equivalent of ffmpeg falling behind and buffering.
        speed: status.outputActive ? 1 : 0,
        // The signal screen capture could never provide. Reported live rather
        // than as everHooked, so a hook that detaches mid-game -- the game
        // crashing, or being alt-tabbed into a state where it stops presenting --
        // is visible while it is happening.
        captureAttached: source.videoActive,
        ended: false
      }

      this.progress = sample

      if (!this.ready && sample.frame > 0) {
        this.framesSamples += 1
        // Readiness is deliberately "the encoder is producing frames", not "the
        // game is hooked". Gating on the hook would abort a recording started
        // while the game is still loading, which is exactly when LeagueVid starts.
        if (this.framesSamples >= 2) {
          this.ready = true
          this.hooks.onFirstFrames?.(sample)
        }
      }

      this.hooks.onProgress?.(sample)
    } catch {
      // A failed poll is not a failed recording. OBS is still writing; the next
      // sample will either succeed or the process will close and settle this.
    }
  }

  isProducingFrames(): boolean {
    return this.ready
  }

  lastProgress(): RecorderProgress | null {
    return this.progress
  }

  /** Whether game capture ever attached, for the health report. */
  isHookedToGame(): boolean {
    return this.everHooked
  }

  async stop(graceMs = SHUTDOWN_GRACE_MS): Promise<CaptureExit> {
    await this.teardown(false, graceMs)
    return this.exited
  }

  /**
   * Ends the recording and the process.
   *
   * Order matters: the recording is stopped before OBS is asked to quit, because
   * stopping the output is what finalizes the container and reports where the
   * file went. Quitting first would leave the muxer to be closed during shutdown,
   * which works but loses the output path.
   */
  private async teardown(failed: boolean, graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    const client = this.client

    if (client?.isConnected && !failed) {
      try {
        this.writtenPath = await client.stopRecord()
      } catch (err) {
        this.hooks.onStderr?.(`Stopping the recording failed: ${(err as Error).message}`)
      }
      try {
        await client.shutdown()
      } catch {
        // Falls through to the kill below.
      }
    }

    client?.close()

    const child = this.obs
    if (!child || child.exitCode !== null) {
      this.finish(child?.exitCode ?? null)
      return
    }

    // A wedged OBS must not be able to block a quit, but it is given a real
    // chance first -- being killed is what would leave the container unfinished.
    const killTimer = setTimeout(() => {
      this.forced = true
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }, graceMs)

    void this.exited.then(() => clearTimeout(killTimer))
  }

  private finish(code: number | null): void {
    if (this.settled) return
    this.settled = true

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.reconcileOutputPath()

    const last = this.progress ? { ...this.progress, ended: true } : null
    this.resolveExit({
      code,
      forced: this.forced,
      stderrTail: this.stderrTail,
      lastProgress: last
    })
  }

  /**
   * Moves OBS's file to the path LeagueVid asked for, if they differ.
   *
   * They normally do not -- the profile sets the exact basename -- but OBS owns
   * the final say on the name and will sanitise or de-duplicate it. Everything
   * downstream, including the library row already written, refers to the
   * requested path, so a mismatch has to be corrected here rather than
   * propagated.
   */
  private reconcileOutputPath(): void {
    const written = this.writtenPath ? normalize(this.writtenPath) : null
    if (!written) return

    const wanted = normalize(this.request.outputPath)
    if (written.toLowerCase() === wanted.toLowerCase()) return
    if (!existsSync(written)) return

    try {
      renameSync(written, wanted)
    } catch (err) {
      this.hooks.onStderr?.(
        `OBS wrote ${written} instead of ${wanted} and it could not be moved: ${(err as Error).message}`
      )
    }
  }

  async saveReplay(): Promise<{ outputPath: string; durationSeconds: number }> {
    const client = this.client
    if (!client?.isConnected) throw new Error('OBS is not running, so there is nothing buffered.')

    await client.saveReplayBuffer()

    // The path appears only once OBS has finished writing it, which is not
    // instant for a couple of minutes of footage.
    let path: string | null = null
    for (let attempt = 0; attempt < 20 && !path; attempt++) {
      await delay(250)
      path = await client.lastReplayPath().catch(() => null)
    }

    if (!path) throw new Error('OBS saved a replay but did not report where.')

    return {
      outputPath: normalize(path),
      durationSeconds: this.request.settings.replayBufferSeconds
    }
  }
}

/**
 * An unused localhost port for obs-websocket.
 *
 * Asked of the OS rather than fixed at 4455, because that is obs-websocket's
 * default and would collide with an OBS the user is already running -- in which
 * case our OBS silently fails to start its server and the session hangs waiting
 * to connect to theirs.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('No free port for OBS.'))))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const obsBackend = new ObsGameCaptureBackend()
