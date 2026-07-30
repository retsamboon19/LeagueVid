// Writes the generated OBS configuration into the managed install, runs OBS
// against it, and reports what OBS made of it.
//
// This exists because a wrong key in an OBS config is silent: OBS substitutes its
// own default for anything it does not recognise, so the only honest way to know
// the generated profile is correct is to hand it to OBS and read the log back.
//
// Usage:
//   npx tsx scripts/test-obs-config.ts [--seconds 12] [--fullscreen] [--write-only]
//
// Notes:
//   --fullscreen  use any_fullscreen instead of matching League's window, which
//                 is what you want when validating against some other game.
//   --write-only  generate the config and stop, without launching OBS.

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { homedir } from 'os'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../src/shared/types'
import type { AudioInputSpec, CaptureTarget } from '../src/main/recorder/ffmpegArgs'
import {
  LEAGUE_CAPTURE_TARGET,
  buildProfileIni,
  buildRecordEncoderJson,
  buildSceneCollection,
  buildUserIni,
  buildWebSocketConfig,
  obsEncoderId
} from '../src/main/recorder/obsConfig'

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? '') : null
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
const OUT_DIR = join(process.env.TEMP ?? '.', 'leaguevid-obs-test')

function main(): void {
  if (!existsSync(join(OBS_ROOT, 'bin', '64bit', 'obs64.exe'))) {
    console.error(`No OBS at ${OBS_ROOT}`)
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })

  const settings: RecordingSettings = {
    ...DEFAULT_RECORDING_SETTINGS,
    framerate: 60,
    resolutionScale: 'native',
    rateControl: 'quality',
    quality: 21,
    keyframeIntervalSeconds: 1,
    audioTrackMode: 'mixed'
  }

  // 1440p, matching this machine's panel. Only used for the canvas size.
  const target: CaptureTarget = { outputIdx: 0, width: 2560, height: 1440, isHdr: false }
  const audioInputs: AudioInputSpec[] = [
    { kind: 'dshow', source: 'default', role: 'desktop', volume: 100 }
  ]

  const basename = `obs-config-test-${Date.now()}`
  const password = randomBytes(12).toString('base64')

  // Deterministic uuids make the generated collection diffable between runs.
  let counter = 0
  const uuid = (): string => {
    counter += 1
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  }

  const profileDir = join(CONFIG_ROOT, 'basic', 'profiles', 'LeagueVid')
  const scenesDir = join(CONFIG_ROOT, 'basic', 'scenes')
  const wsDir = join(CONFIG_ROOT, 'plugin_config', 'obs-websocket')
  for (const dir of [profileDir, scenesDir, wsDir]) mkdirSync(dir, { recursive: true })

  writeFileSync(
    join(profileDir, 'basic.ini'),
    buildProfileIni({
      settings,
      target,
      recordingDirectory: OUT_DIR,
      fileBasename: basename,
      audioTrackCount: 1
    })
  )
  writeFileSync(
    join(profileDir, 'recordEncoder.json'),
    JSON.stringify(buildRecordEncoderJson(settings), null, 2)
  )
  writeFileSync(
    join(scenesDir, 'LeagueVid.json'),
    JSON.stringify(
      buildSceneCollection({
        target,
        audioInputs,
        audioTrackMode: settings.audioTrackMode,
        drawMouse: settings.drawMouse,
        capture: has('fullscreen') ? { mode: 'any_fullscreen' } : LEAGUE_CAPTURE_TARGET,
        uuid
      }),
      null,
      2
    )
  )
  writeFileSync(join(CONFIG_ROOT, 'user.ini'), buildUserIni())
  writeFileSync(
    join(wsDir, 'config.json'),
    JSON.stringify(buildWebSocketConfig(4455, password), null, 2)
  )
  // Portable marker, so OBS keeps config inside the distribution.
  writeFileSync(join(OBS_ROOT, 'bin', '64bit', 'obs_portable_mode.txt'), '')

  console.log(`config written to ${CONFIG_ROOT}`)
  console.log(`encoder id: ${obsEncoderId(settings.encoder)}`)
  console.log(`recording into: ${OUT_DIR}`)
  if (has('write-only')) return

  const seconds = Number(flag('seconds') ?? 12)
  runObs(seconds).then((code) => report(code, seconds))
}

function runObs(seconds: number): Promise<number | null> {
  const args = [
    '--portable',
    '--multi',
    '--disable-updater',
    '--disable-missing-files-check',
    '--profile',
    'LeagueVid',
    '--collection',
    'LeagueVid',
    '--startrecording',
    '--minimize-to-tray'
  ]
  console.log(`launching: obs64.exe ${args.join(' ')}`)

  const child = spawn(join(OBS_ROOT, 'bin', '64bit', 'obs64.exe'), args, {
    cwd: join(OBS_ROOT, 'bin', '64bit'),
    windowsHide: true
  })

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Hard kill on purpose: Matroska is meant to survive it, and that property
      // is worth confirming rather than assuming.
      console.log(`killing OBS after ${seconds}s (testing that mkv survives it)`)
      child.kill()
    }, seconds * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    child.on('error', (err) => {
      console.error(`spawn failed: ${err.message}`)
      clearTimeout(timer)
      resolve(null)
    })
  })
}

function report(code: number | null, seconds: number): void {
  console.log(`\nOBS exited with ${code}`)

  const logDir = join(CONFIG_ROOT, 'logs')
  const logs = readdirSync(logDir)
    .filter((name) => name.endsWith('.txt'))
    .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  if (logs.length > 0) {
    const text = readFileSync(join(logDir, logs[0].name), 'utf-8')
    console.log(`\n--- log: ${logs[0].name} ---`)
    const interesting =
      /profile|scene collection|game_capture|game capture|nvenc|encoder|Recording|output|error|fail|warn|websocket|Unknown|invalid/i
    for (const line of text.split('\n')) {
      if (interesting.test(line)) console.log(line.trimEnd())
    }
  }

  console.log(`\n--- output files in ${OUT_DIR} ---`)
  for (const name of readdirSync(OUT_DIR)) {
    const size = statSync(join(OUT_DIR, name)).size
    console.log(`${name}  ${(size / 1024 / 1024).toFixed(2)} MB  (${seconds}s run)`)
  }
}

main()
