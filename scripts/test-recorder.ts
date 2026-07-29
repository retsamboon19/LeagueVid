/**
 * Prints -- and optionally runs -- the exact ffmpeg command a recording
 * session would use.
 *
 * Runs outside Electron so the argument builder can be exercised without
 * launching the app.
 *
 *   npx tsx scripts/test-recorder.ts --print
 *   npx tsx scripts/test-recorder.ts --print --encoder libx264 --scale 1080p --audio mic
 *   npx tsx scripts/test-recorder.ts --record 5
 *
 * --record spawns the real pipeline for N seconds and writes the file into
 * the OS temp folder, which is how the argv gets validated against ffmpeg
 * itself rather than only against the test suite's expectations.
 */
import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../src/shared/types'
import {
  buildCaptureArgs,
  formatCommand,
  type AudioInputSpec,
  type CaptureTarget
} from '../src/main/recorder/ffmpegArgs'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function ffmpegPath(): string {
  const path = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  if (!existsSync(path)) throw new Error(`No bundled ffmpeg at ${path}`)
  return path
}

function buildSettings(): RecordingSettings {
  const settings: RecordingSettings = { ...DEFAULT_RECORDING_SETTINGS }
  const encoder = flag('encoder')
  if (encoder) settings.encoder = encoder
  const scale = flag('scale')
  if (scale) settings.resolutionScale = scale as RecordingSettings['resolutionScale']
  const fps = flag('fps')
  if (fps) settings.framerate = Number(fps) as RecordingSettings['framerate']
  if (has('bitrate')) settings.rateControl = 'bitrate'
  if (has('cursor')) settings.drawMouse = true
  if (has('separate-tracks')) settings.audioTrackMode = 'separate'
  return settings
}

function buildAudioInputs(): AudioInputSpec[] {
  const audio = flag('audio')
  if (!audio || audio === 'none') return []
  const inputs: AudioInputSpec[] = []
  if (audio === 'mic' || audio === 'both') {
    inputs.push({ kind: 'dshow', source: flag('mic-device') ?? 'Microphone', role: 'mic' })
  }
  if (audio === 'desktop' || audio === 'both') {
    inputs.push({ kind: 'loopback-socket', source: 'tcp://127.0.0.1:47821', role: 'desktop' })
  }
  return inputs
}

function target(): CaptureTarget {
  return {
    outputIdx: Number(flag('display') ?? 0),
    width: Number(flag('width') ?? 2560),
    height: Number(flag('height') ?? 1440),
    isHdr: has('hdr')
  }
}

async function record(path: string, args: string[], seconds: number): Promise<void> {
  console.log(`\nRecording ${seconds}s to ${args.at(-1)}\n`)

  const child = spawn(path, args, { windowsHide: true })
  let lastLine = ''

  child.stdout.on('data', (chunk) => {
    // -progress output: key=value blocks, one per flush.
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.startsWith('frame=') || line.startsWith('fps=') || line.startsWith('out_time=')) {
        lastLine = line
        console.log(`  ${line}`)
      }
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)))

  const finished = new Promise<number | null>((resolve) => child.on('close', resolve))

  setTimeout(() => {
    // Graceful stop. Never a signal: ffmpeg does not finalize the container
    // when it's killed, and the whole point of this file is that it survives.
    console.log('\n  sending q for a graceful stop')
    child.stdin.write('q')
  }, seconds * 1000)

  const code = await finished
  console.log(`\nffmpeg exited with ${code}. Last progress: ${lastLine || '(none)'}`)

  const outputPath = args.at(-1) as string
  if (existsSync(outputPath)) {
    const size = statSync(outputPath).size
    console.log(`Output: ${outputPath} (${(size / 1024 / 1024).toFixed(2)} MB)`)
  } else {
    console.log('No output file was produced.')
  }
}

async function main(): Promise<void> {
  const seconds = flag('record')
  const outputPath = seconds
    ? join(tmpdir(), `leaguevid-test-${Date.now()}.mkv`)
    : 'H:\\LeagueVid\\recordings\\session.mkv'

  const args = buildCaptureArgs({
    settings: buildSettings(),
    target: target(),
    outputPath,
    audioInputs: buildAudioInputs()
  })

  const path = ffmpegPath()
  console.log(formatCommand(path, args))

  if (seconds) await record(path, args, Number(seconds))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
