// Drives a full OBS recording session over obs-websocket and reports what
// happened, including whether game capture actually attached to a game.
//
// This is the script that answers the question the ffmpeg pipeline could never
// answer: is the capture receiving real frames, or is it producing a valid file
// full of nothing? OBS reports it directly via GetSourceActive on the game
// capture source, so there is no need to infer it from duplicate frame counts
// after the fact.
//
// Usage:
//   npx tsx scripts/test-obs-session.ts [--seconds 20] [--fullscreen] [--window "title:class:exe"]
//
// Run it with League (or any game) open to see game capture attach. With nothing
// running, videoActive stays false -- which is correct, and is exactly the state
// that used to be invisible.

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../src/shared/types'
import type { AudioInputSpec, CaptureTarget } from '../src/main/recorder/ffmpegArgs'
import type { CaptureScope } from '../src/main/recorder/captureBackend'
import {
  DISPLAY_CAPTURE_SCOPE,
  LEAGUE_CAPTURE_SCOPE,
  captureSourceName
} from '../src/main/recorder/obsConfig'
import { writeObsConfig } from '../src/main/recorder/obsConfigFiles'
import { ObsWebSocketClient } from '../src/main/recorder/obsWebSocket'

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const OBS_ROOT = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'leaguevid',
  'obs',
  'obs-studio-32.2.1'
)
const CONFIG_ROOT = join(OBS_ROOT, 'config', 'obs-studio')
const PORT = 4455

/**
 * Where OBS writes.
 *
 * Overridable because the default temp path hid a real bug: paths under
 * ...\AppData\Local\Temp\... contain no character that forms an ini escape
 * sequence, so they round-tripped intact while H:\LeagueVid\recordings did not.
 * Pointing this at the actual recordings folder is what reproduces it.
 */
const OUT_DIR =
  flag('out') ?? join(process.env.TEMP ?? '.', 'leaguevid-obs-test')

async function main(): Promise<void> {
  const executable = join(OBS_ROOT, 'bin', '64bit', 'obs64.exe')
  if (!existsSync(executable)) {
    console.error(`No OBS at ${OBS_ROOT}`)
    process.exit(1)
  }

  const seconds = Number(flag('seconds') ?? 20)
  const password = randomBytes(16).toString('base64')

  const settings: RecordingSettings = {
    ...DEFAULT_RECORDING_SETTINGS,
    framerate: 60,
    resolutionScale: 'native',
    rateControl: 'quality',
    quality: 21,
    keyframeIntervalSeconds: 1
  }
  const target: CaptureTarget = { outputIdx: 0, width: 2560, height: 1440, isHdr: false }
  const audioInputs: AudioInputSpec[] = [
    { kind: 'dshow', source: 'default', role: 'desktop', volume: 100 }
  ]

  const windowFlag = flag('window')
  // --display mirrors what pressing Record by hand does; the default mirrors
  // automatic recording, which follows the League match.
  const scope: CaptureScope = has('display')
    ? DISPLAY_CAPTURE_SCOPE
    : windowFlag
      ? { kind: 'game', window: windowFlag }
      : LEAGUE_CAPTURE_SCOPE

  const basename = `obs-session-${Date.now()}`

  writeObsConfig({
    obsRoot: OBS_ROOT,
    configRoot: CONFIG_ROOT,
    settings,
    target,
    audioInputs,
    recordingDirectory: OUT_DIR,
    fileBasename: basename,
    scope,
    webSocketPort: PORT,
    webSocketPassword: password
  })
  console.log(
    `config written; scope: ${scope.kind}${scope.kind === 'game' ? ` (${scope.window})` : ''}`
  )

  const obs = launchObs(executable)
  const client = new ObsWebSocketClient(`ws://127.0.0.1:${PORT}`, password)

  try {
    await connectWithRetry(client)
    await client.waitUntilReady()
    const version = await client.version()
    console.log(`connected: OBS ${version.obsVersion}, obs-websocket ${version.obsWebSocketVersion}`)

    client.onEvent((type, data) => {
      if (type === 'RecordStateChanged') {
        console.log(`  event RecordStateChanged: ${String(data.outputState)}`)
      }
    })

    if (scope.kind === 'game') {
      // What OBS can actually see. When a capture reports itself detached, the
      // first question is whether the game is visible to game capture at all,
      // and these are the exact match strings the source expects.
      const windows = await client
        .captureWindowOptions(captureSourceName(scope))
        .catch(() => [] as Array<{ name: string; value: string }>)

      console.log(`\ngame capture can see ${windows.length} window(s):`)
      for (const option of windows) console.log(`  ${option.value}`)

      const league = windows.filter((option) => /League of Legends\.exe/i.test(option.value))
      console.log(
        league.length > 0
          ? `\nLeague found: ${league.map((l) => l.value).join(', ')}`
          : '\nLeague is NOT running — expect hooked=false, which is the correct answer.'
      )
    } else {
      const monitors = await client
        .monitorOptions(captureSourceName(scope))
        .catch(() => [] as Array<{ name: string; value: string }>)
      console.log(`\ndisplay capture sees ${monitors.length} monitor(s):`)
      for (const monitor of monitors) console.log(`  ${monitor.name}`)
    }
    console.log('')

    // Mirrors what the backend does: monitor_capture has no monitor selected
    // until this is set, and an unset monitor_id records pure black.
    if (scope.kind === 'display') {
      const monitors = await client.monitorOptions(captureSourceName(scope))
      const chosen =
        monitors.find((monitor) => /primary/i.test(monitor.name)) ?? monitors[0]
      if (chosen) {
        await client.setInputSettings(captureSourceName(scope), { monitor_id: chosen.value })
        console.log(`selected monitor: ${chosen.name}`)
      }
    }

    await client.startRecord()
    console.log(`recording started; sampling for ${seconds}s`)

    const samples = await sample(client, seconds, scope)
    const outputPath = await client.stopRecord()
    console.log(`\nstopped. OBS wrote: ${outputPath}`)

    summarise(samples)

    await client.shutdown()
  } catch (err) {
    console.error(`\nFAILED: ${(err as Error).message}`)
  } finally {
    client.close()
    await settle(obs)
  }

  console.log(`\n--- files in ${OUT_DIR} ---`)
  for (const name of readdirSync(OUT_DIR)) {
    const size = statSync(join(OUT_DIR, name)).size
    console.log(`${name}  ${(size / 1024 / 1024).toFixed(2)} MB`)
  }
}

function launchObs(executable: string): ChildProcess {
  const args = [
    '--portable',
    '--multi',
    '--disable-updater',
    '--disable-missing-files-check',
    '--profile',
    'LeagueVid',
    '--collection',
    'LeagueVid',
    '--minimize-to-tray'
  ]
  console.log(`launching obs64.exe ${args.join(' ')}`)
  return spawn(executable, args, { cwd: join(executable, '..'), windowsHide: true })
}

/**
 * Connects, retrying while OBS starts up.
 *
 * The websocket server does not exist for the first second or two of OBS's life,
 * so a single attempt fails on a cold start almost every time.
 */
async function connectWithRetry(client: ObsWebSocketClient, attempts = 20): Promise<void> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await client.connect()
      return
    } catch (err) {
      lastError = err as Error
      await delay(750)
    }
  }
  throw lastError ?? new Error('Could not connect to OBS.')
}

interface Sample {
  atMs: number
  activeFps: number
  renderSkipped: number
  renderTotal: number
  outputSkipped: number
  outputTotal: number
  videoActive: boolean
  bytes: number
  durationMs: number
}

async function sample(
  client: ObsWebSocketClient,
  seconds: number,
  scope: CaptureScope
): Promise<Sample[]> {
  const samples: Sample[] = []
  const started = Date.now()

  while (Date.now() - started < seconds * 1000) {
    await delay(1000)
    const [stats, status, windows] = await Promise.all([
      client.stats(),
      client.recordStatus(),
      // Attachment comes from OBS's window enumeration, not GetSourceActive --
      // videoActive reads true for a target that is not running at all. Only
      // meaningful for a game scope; whole-screen capture is always attached.
      scope.kind === 'game'
        ? client
            .captureWindowOptions(captureSourceName(scope))
            .catch(() => [] as Array<{ name: string; value: string }>)
        : Promise.resolve([] as Array<{ name: string; value: string }>)
    ])
    const source = {
      videoActive:
        scope.kind === 'game'
          ? windows.some((w) => /League of Legends\.exe/i.test(w.value))
          : true
    }

    const s: Sample = {
      atMs: Date.now() - started,
      activeFps: stats.activeFps,
      renderSkipped: stats.renderSkippedFrames,
      renderTotal: stats.renderTotalFrames,
      outputSkipped: stats.outputSkippedFrames,
      outputTotal: stats.outputTotalFrames,
      videoActive: source.videoActive,
      bytes: status.outputBytes,
      durationMs: status.outputDuration
    }
    samples.push(s)
    console.log(
      `  ${(s.atMs / 1000).toFixed(0)}s  fps=${s.activeFps.toFixed(1)}  ` +
        `hooked=${s.videoActive}  renderSkip=${s.renderSkipped}/${s.renderTotal}  ` +
        `outSkip=${s.outputSkipped}/${s.outputTotal}  ${(s.bytes / 1024 / 1024).toFixed(1)}MB`
    )
  }

  return samples
}

function summarise(samples: Sample[]): void {
  if (samples.length === 0) return
  const last = samples[samples.length - 1]

  console.log('\n--- summary ---')
  console.log(`game capture attached : ${samples.some((s) => s.videoActive)}`)
  console.log(`composited frames     : ${last.renderTotal} (${last.renderSkipped} skipped)`)
  console.log(`encoded frames        : ${last.outputTotal} (${last.outputSkipped} skipped)`)
  console.log(`footage written       : ${(last.durationMs / 1000).toFixed(1)}s`)

  if (last.durationMs > 0) {
    // The number that matters: frames the encoder produced per second of
    // footage. Under ddagrab this looked fine while the picture was frozen,
    // because ffmpeg padded it. OBS does not pad, so this is the real rate.
    const encodedFps = last.outputTotal / (last.durationMs / 1000)
    console.log(`encoded fps           : ${encodedFps.toFixed(1)}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Waits for OBS to exit, killing it only if it refuses. */
function settle(obs: ChildProcess, graceMs = 12000): Promise<void> {
  return new Promise((resolve) => {
    if (obs.exitCode !== null) return resolve()
    const timer = setTimeout(() => {
      obs.kill()
      resolve()
    }, graceMs)
    obs.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

void main()
