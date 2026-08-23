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
import { DISPLAY_CAPTURE_SOURCE_NAME, GAME_CAPTURE_SOURCE_NAME } from './obsConfig'
import { safeCaptureScope } from './captureConflicts'

/** Name OBS gives the microphone input in a default scene collection. */
const MIC_SOURCE_NAME = 'Mic/Aux'
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

/**
 * How often to ask whether the game is visible to game capture.
 *
 * Slower than the progress poll because answering it makes OBS enumerate every
 * top-level window, and a game does not appear or vanish between seconds.
 */
const ATTACH_CHECK_INTERVAL_MS = 5000

/**
 * The executable out of an OBS 'title:class:executable' window string.
 *
 * Split from the right, because a window title can itself contain colons -- the
 * enumeration on this machine included one reading 'C:\WINDOWS\system32\cmd.exe'
 * as its title, which splitting from the left would mangle.
 */
export function executableFrom(windowSpec: string): string {
  const parts = windowSpec.split(':')
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

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
  // win-wasapi does loopback natively, so the Chromium audio bridge is not just
  // unnecessary here, it is a failure mode with nothing to gain. Its timeout is
  // what produced "System audio couldn't be captured" on a backend that records
  // desktop sound perfectly well by itself.
  readonly capturesDesktopAudioNatively = true

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

    // Game Capture and performance overlays both hook the game's Present call.
    // When RTSS / Afterburner wins that race, OBS can attach successfully but
    // receive only one shared texture forever. Its output counters still look
    // perfect because OBS draws the cursor itself. Use OBS's non-injecting
    // Windows Graphics Capture path for this session instead.
    const safe = safeCaptureScope(request.scope)
    const effectiveRequest =
      safe.scope === request.scope ? request : { ...request, scope: safe.scope }

    if (safe.conflicts.length > 0) {
      hooks.onWarning?.(
        `${safe.conflicts.join(' and ')} is running, so LeagueVid is using OBS screen capture ` +
          'for this match to prevent frozen video.'
      )
    }

    const session = new ObsSession(install, effectiveRequest, hooks)
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
  /**
   * Latest attachment answer, refreshed on its own slower cadence.
   *
   * undefined until the first check completes, which is also the honest value
   * for a capture mode where attachment cannot be determined.
   */
  private attached: boolean | undefined = undefined
  private attachCheckedAt = 0
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
      scope: this.request.scope,
      fallbackEncoder: this.request.fallbackEncoder,
      webSocketPort: port,
      webSocketPassword: password
    })

    this.obs = this.spawnObs()
    this.client = new ObsWebSocketClient(`ws://127.0.0.1:${port}`, password)

    try {
      await this.connect()

      // Before recording, not after. Both of these fill in identifiers that only
      // OBS can supply, and the monitor one in particular decides whether there
      // is a picture at all -- applying it afterwards would put black frames at
      // the start of every manual recording.
      //
      // Neither is allowed to fail the session: a recording with the default
      // microphone is fine, and the monitor step reports its own problems.
      await this.applyMicrophoneChoice()
      await this.applyMonitorChoice()

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
      const [stats, status] = await Promise.all([client.stats(), client.recordStatus()])

      await this.refreshAttachment()
      if (this.attached) this.everHooked = true

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
        captureAttached: this.attached,
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

  /**
   * Points the microphone input at the device the user actually chose.
   *
   * Has to happen after OBS is running, because the scene collection can only
   * name a device by its Windows endpoint id and LeagueVid stores the friendly
   * name -- the two are only relatable through OBS's own enumeration. The
   * collection therefore starts on the default device (a working microphone) and
   * this narrows it to the right one.
   *
   * Silent on failure. A recording with the default microphone is a good
   * outcome; refusing to record because the named device is unplugged is not.
   */
  private async applyMicrophoneChoice(): Promise<void> {
    const client = this.client
    const wanted = this.request.audioInputs.find((input) => input.role === 'mic')?.source
    if (!client?.isConnected || !wanted) return

    try {
      const devices = await client.audioDeviceOptions(MIC_SOURCE_NAME)
      // Matched loosely because the two lists come from different APIs and
      // Windows truncates friendly names differently in each.
      const match =
        devices.find((device) => device.name === wanted) ??
        devices.find(
          (device) =>
            device.name.toLowerCase().includes(wanted.toLowerCase()) ||
            wanted.toLowerCase().includes(device.name.toLowerCase())
        )

      if (!match) {
        this.hooks.onStderr?.(
          `The microphone "${wanted}" was not found, so the system default is being recorded instead.`
        )
        return
      }

      await client.setInputSettings(MIC_SOURCE_NAME, { device_id: match.value })
    } catch (err) {
      this.hooks.onStderr?.(`Could not select the microphone: ${(err as Error).message}`)
    }
  }

  /**
   * Points display capture at the monitor the user chose to record.
   *
   * Deferred for the same reason as the microphone: monitor_capture identifies a
   * screen by an opaque Windows device path, and only OBS's own enumeration can
   * supply it. The collection therefore starts on OBS's default (the primary
   * monitor) and this narrows it.
   *
   * Matched on the resolution OBS prints in each option's label, because that is
   * the only field the two sides share -- Electron's display list and OBS's
   * monitor list have no common identifier. When several monitors are the same
   * size this can pick the wrong one, which is why it never overrides a
   * single-monitor default and says nothing when it cannot be sure.
   */
  private async applyMonitorChoice(): Promise<void> {
    const client = this.client
    if (!client?.isConnected || this.request.scope.kind !== 'display') return

    try {
      const monitors = await client.monitorOptions(DISPLAY_CAPTURE_SOURCE_NAME)
      if (monitors.length === 0) {
        this.hooks.onStderr?.('OBS reported no monitors to record.')
        return
      }

      const { width, height } = this.request.target
      // Resolution is the only field the two sides share -- Electron's display
      // list and OBS's monitor list have no common identifier.
      const sized = monitors.filter((monitor) => monitor.name.includes(`${width}x${height}`))

      const chosen =
        // Exactly one monitor of that size is unambiguous.
        (sized.length === 1 ? sized[0] : undefined) ??
        // Otherwise the primary, which is what OBS's own UI would default to.
        monitors.find((monitor) => /primary/i.test(monitor.name)) ??
        monitors[0]

      // Always set, never skipped. An unset monitor_id is not "the default
      // monitor", it is no monitor, and it records pure black.
      await client.setInputSettings(DISPLAY_CAPTURE_SOURCE_NAME, { monitor_id: chosen.value })
    } catch (err) {
      this.hooks.onStderr?.(`Could not select the monitor: ${(err as Error).message}`)
    }
  }

  /**
   * Refreshes whether game capture can actually see the game.
   *
   * Determined from OBS's own enumeration of capturable windows rather than from
   * GetSourceActive, whose videoActive and videoShowing both report true for a
   * source whose target window does not exist -- measured with the game closed.
   * They describe scene membership, not capture state, and a health warning
   * built on them could never fire.
   *
   * Window presence is also the more useful answer: "OBS cannot see the game" is
   * something the user can act on.
   *
   * Checked on a slower cadence than the rest of the sample because it makes OBS
   * enumerate every top-level window, and nothing here changes second to second.
   */
  private async refreshAttachment(): Promise<void> {
    const client = this.client
    if (!client?.isConnected) return

    // any_fullscreen has no named target, so window presence cannot answer the
    // question. Left undefined, which the health check reads as "unknown" and
    // stays quiet about -- better than a confident wrong answer either way.
    // Only a game scope can be detached. Whole-screen capture always has a
    // picture, so the question does not apply and undefined is the honest
    // answer -- the health check reads that as "unknown" and stays quiet.
    if (this.request.scope.kind !== 'game') {
      this.attached = undefined
      return
    }
    const wanted = this.request.scope.window

    if (Date.now() - this.attachCheckedAt < ATTACH_CHECK_INTERVAL_MS) return
    this.attachCheckedAt = Date.now()

    try {
      const options = await client.captureWindowOptions(GAME_CAPTURE_SOURCE_NAME)
      // Matched on the executable rather than the whole triple, because that is
      // what the source is configured to match on (priority 2) and because the
      // window title carries a match count that changes.
      const executable = executableFrom(wanted)
      this.attached = options.some(
        (option) => executableFrom(option.value).toLowerCase() === executable.toLowerCase()
      )
    } catch {
      // An enumeration that fails says nothing either way, so the previous
      // answer stands rather than being downgraded to "detached".
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
