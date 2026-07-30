/**
 * Measures real capture throughput for the pipeline variants.
 *
 * Exists because "it drops frames" and "it's fine" are both unfalsifiable
 * without numbers. Each variant records the actual desktop for a few seconds and
 * reports frames encoded, average fps against target, dropped frames and encode
 * speed -- the same figures the in-app preflight test reports.
 *
 *   npx tsx scripts/bench-capture.ts
 *   npx tsx scripts/bench-capture.ts --seconds 10
 */
import { existsSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startCapture } from '../src/main/recorder/ffmpegProcess'
import { assessCaptureHealth } from '../src/main/recorder/progressParser'

function ffmpegPath(): string {
  const path = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  if (!existsSync(path)) throw new Error(`No bundled ffmpeg at ${path}`)
  return path
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const SECONDS = Number(flag('seconds', '8'))

interface Variant {
  name: string
  note: string
  fps: number
  filter: string
  encoderArgs: string[]
}

/** Constant-quality NVENC everywhere, so only the capture path differs. */
const NVENC = ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '21', '-b:v', '0']

const variants: Variant[] = [
  {
    name: 'native-1440p60',
    note: 'GPU only, no scaling. The current default.',
    fps: 60,
    filter: 'ddagrab=output_idx=0:framerate=60:draw_mouse=0:allow_fallback=1[v]',
    encoderArgs: NVENC
  },
  {
    name: 'cpu-scaled-1080p60',
    note: 'hwdownload + CPU scale. What any resolution other than Native costs.',
    fps: 60,
    filter:
      'ddagrab=output_idx=0:framerate=60:draw_mouse=0:allow_fallback=1,' +
      'hwdownload,format=bgra,scale=-2:1080,format=nv12[v]',
    encoderArgs: NVENC
  },
  {
    name: 'gpu-scaled-1080p60',
    note: 'hwmap to CUDA + scale_cuda. Never leaves the GPU.',
    fps: 60,
    filter:
      'ddagrab=output_idx=0:framerate=60:draw_mouse=0:allow_fallback=1,' +
      'hwmap=derive_device=cuda,scale_cuda=-2:1080:format=nv12[v]',
    encoderArgs: NVENC
  },
  {
    name: 'native-1440p120',
    note: 'High refresh, no scaling. This display runs at 239Hz.',
    fps: 120,
    filter: 'ddagrab=output_idx=0:framerate=120:draw_mouse=0:allow_fallback=1[v]',
    encoderArgs: NVENC
  },
  {
    name: 'gpu-scaled-1080p120',
    note: 'High refresh with GPU scaling.',
    fps: 120,
    filter:
      'ddagrab=output_idx=0:framerate=120:draw_mouse=0:allow_fallback=1,' +
      'hwmap=derive_device=cuda,scale_cuda=-2:1080:format=nv12[v]',
    encoderArgs: NVENC
  },
  {
    name: 'native-1440p60-no-cfr',
    note: 'Without -r/-fps_mode cfr, so only ddagrab regulates the rate.',
    fps: 60,
    filter: 'ddagrab=output_idx=0:framerate=60:draw_mouse=0:allow_fallback=1[v]',
    encoderArgs: NVENC
  }
]

async function run(variant: Variant): Promise<void> {
  const outputPath = join(tmpdir(), `lv-bench-${variant.name}.mkv`)

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
    '-init_hw_device',
    'd3d11va',
    '-filter_complex',
    variant.filter,
    '-map',
    '[v]',
    ...variant.encoderArgs,
    '-g',
    String(variant.fps)
  ]

  // The variant that exists to test whether double rate regulation costs frames.
  if (!variant.name.endsWith('no-cfr')) {
    args.push('-r', String(variant.fps), '-fps_mode', 'cfr')
  }

  args.push('-f', 'matroska', '-y', outputPath)

  let stderr = ''
  const handle = startCapture({
    ffmpegPath: ffmpegPath(),
    args,
    onStderr: (line) => {
      stderr += line
    }
  })

  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000))
  const exit = await handle.stop()

  const last = exit.lastProgress
  const seconds = (last?.outTimeMs ?? 0) / 1000
  const averageFps = seconds > 0 ? (last?.frame ?? 0) / seconds : 0
  const health = last ? assessCaptureHealth(last) : null

  const sizeMb = existsSync(outputPath) ? statSync(outputPath).size / 1024 ** 2 : 0

  console.log(`\n${variant.name}  (target ${variant.fps} fps)`)
  console.log(`  ${variant.note}`)
  if (!last || last.frame === 0) {
    console.log(`  NO FRAMES. exit=${exit.code} ${stderr.trim().split('\n').slice(-2).join(' ')}`)
    return
  }
  console.log(
    `  frames=${last.frame}  avg=${averageFps.toFixed(1)}fps  ` +
      `dropped=${last.dropFrames}  dup=${last.dupFrames}  speed=${last.speed.toFixed(2)}x  ` +
      `size=${sizeMb.toFixed(1)}MB`
  )
  console.log(
    `  reached ${((averageFps / variant.fps) * 100).toFixed(0)}% of target — ` +
      `${health?.healthy ? 'healthy' : 'UNHEALTHY: ' + health?.reasons.join(' ')}`
  )

  try {
    if (existsSync(outputPath)) unlinkSync(outputPath)
  } catch {
    // Temp leftovers are harmless.
  }
}

async function main(): Promise<void> {
  console.log(`Benchmarking capture for ${SECONDS}s per variant...`)
  for (const variant of variants) {
    await run(variant)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
