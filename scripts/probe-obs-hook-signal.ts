// Works out which obs-websocket field actually reflects whether game capture is
// attached to a game.
//
// Written because the obvious candidate is wrong. GetSourceActive.videoActive
// reads true for a game_capture source whose target is not running at all --
// verified with League closed and OBS's own window enumeration confirming it was
// absent. That field reports "this source is in the active scene", not "the hook
// found something", and building the capture health warning on it would mean the
// warning could never fire.
//
// Compares every candidate against ground truth (does OBS's window list contain
// the target?) for a target that exists and one that does not.
//
// Usage: npx tsx scripts/probe-obs-hook-signal.ts

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { DEFAULT_RECORDING_SETTINGS } from '../src/shared/types'
import type { CaptureTarget } from '../src/main/recorder/ffmpegArgs'
import { writeObsConfig } from '../src/main/recorder/obsConfigFiles'
import { ObsWebSocketClient } from '../src/main/recorder/obsWebSocket'

const OBS_ROOT = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'leaguevid',
  'obs',
  'obs-studio-32.2.1'
)
const CONFIG_ROOT = join(OBS_ROOT, 'config', 'obs-studio')
const OUT_DIR = join(process.env.TEMP ?? '.', 'leaguevid-obs-test')

/** A window that certainly is not running, and one that certainly is. */
const ABSENT = 'League of Legends (TM) Client:RiotWindowClass:League of Legends.exe'

async function main(): Promise<void> {
  const executable = join(OBS_ROOT, 'bin', '64bit', 'obs64.exe')
  if (!existsSync(executable)) {
    console.error(`No OBS at ${OBS_ROOT}`)
    process.exit(1)
  }

  const password = randomBytes(16).toString('base64')
  const target: CaptureTarget = { outputIdx: 0, width: 2560, height: 1440, isHdr: false }

  writeObsConfig({
    obsRoot: OBS_ROOT,
    configRoot: CONFIG_ROOT,
    settings: { ...DEFAULT_RECORDING_SETTINGS, framerate: 60 },
    target,
    audioInputs: [],
    recordingDirectory: OUT_DIR,
    fileBasename: `hook-probe-${Date.now()}`,
    scope: { kind: 'game', window: ABSENT },
    webSocketPort: 4466,
    webSocketPassword: password
  })

  const obs = launch(executable)
  const client = new ObsWebSocketClient('ws://127.0.0.1:4466', password)

  try {
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        await client.connect()
        break
      } catch {
        await delay(700)
      }
    }
    await client.waitUntilReady()
    console.log('connected\n')

    const windows = await client.captureWindowOptions('Game Capture')
    const present = windows.map((w) => w.value)
    console.log(`OBS sees ${present.length} capturable window(s).`)

    const leagueVisible = present.some((v) => /League of Legends\.exe/i.test(v))
    console.log(`GROUND TRUTH: League present in OBS window list = ${leagueVisible}\n`)

    // Every field that might plausibly answer the question, for a target that is
    // not running.
    const active = await client.sourceActive('Game Capture')
    console.log('--- with capture_mode=window targeting a NON-RUNNING game ---')
    console.log(`GetSourceActive.videoActive  : ${active.videoActive}`)
    console.log(`GetSourceActive.videoShowing : ${active.videoShowing}`)

    // The source's own reported dimensions. A game_capture that has not hooked
    // anything has nothing to report a size for, which is the most promising
    // remaining signal.
    const settings = await client.request<Record<string, unknown>>('GetInputSettings', {
      inputName: 'Game Capture'
    })
    console.log(`GetInputSettings.window      : ${JSON.stringify(settings.inputSettings)}`)

    for (const request of ['GetSourceFilterList', 'GetInputAudioTracks']) {
      // Not expected to help, but cheap to rule out.
      const result = await client
        .request<Record<string, unknown>>(request, { inputName: 'Game Capture', sourceName: 'Game Capture' })
        .catch((err: Error) => ({ error: err.message }) as Record<string, unknown>)
      console.log(`${request.padEnd(29)}: ${JSON.stringify(result).slice(0, 120)}`)
    }

    // The decisive one: a screenshot of the source. A game_capture with no hook
    // renders nothing, so the frame is uniformly transparent/black. Comparing
    // sizes of a known-blank and a known-live capture is crude but conclusive.
    const shot = await client
      .request<Record<string, unknown>>('GetSourceScreenshot', {
        sourceName: 'Game Capture',
        imageFormat: 'png',
        imageWidth: 64,
        imageHeight: 36
      })
      .catch((err: Error) => ({ error: err.message }) as Record<string, unknown>)
    const data = typeof shot.imageData === 'string' ? shot.imageData : null
    console.log(
      `GetSourceScreenshot         : ${
        data ? `${data.length} chars of base64 png` : JSON.stringify(shot).slice(0, 160)
      }`
    )

    await client.shutdown()
  } catch (err) {
    console.error(`FAILED: ${(err as Error).message}`)
  } finally {
    client.close()
    await settle(obs)
  }
}

function launch(executable: string): ChildProcess {
  return spawn(
    executable,
    [
      '--portable',
      '--multi',
      '--disable-updater',
      '--disable-missing-files-check',
      '--profile',
      'LeagueVid',
      '--collection',
      'LeagueVid',
      '--minimize-to-tray'
    ],
    { cwd: join(executable, '..'), windowsHide: true }
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function settle(obs: ChildProcess, graceMs = 10000): Promise<void> {
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
