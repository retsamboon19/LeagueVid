// End-to-end check that clipping actually works on a real recording:
// verifies both modes produce a playable file of the requested length.
//
// Usage: npx tsx scripts/test-clip.ts

import initSqlJs from 'sql.js'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import ffmpegPath from 'ffmpeg-static'

const dbPath = join(homedir(), 'AppData', 'Roaming', 'leaguevid', 'leaguevid.db')
const outDir = join(tmpdir(), 'leaguevid-clip-test')

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath as string, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

function probeDuration(file: string): Promise<number | null> {
  // ffmpeg (no ffprobe in ffmpeg-static) reports duration on stderr for a
  // null-output decode.
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath as string, ['-hide_banner', '-i', file, '-f', 'null', '-'], {
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.on('close', () => {
      const m = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/g)
      if (!m || m.length === 0) return resolve(null)
      const last = m[m.length - 1].replace('time=', '')
      const [h, mi, s] = last.split(':').map(Number)
      resolve(h * 3600 + mi * 60 + s)
    })
  })
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (f) => join(process.cwd(), 'node_modules', 'sql.js', 'dist', f)
  })
  const db = new SQL.Database(readFileSync(dbPath))
  const rows = db.exec(`SELECT file_path FROM videos WHERE match_id IS NOT NULL LIMIT 5`)[0]?.values ?? []
  db.close()

  const source = rows.map((r) => String(r[0])).find((p) => existsSync(p))
  if (!source) {
    console.error('No linked recording found on disk to test with.')
    process.exitCode = 1
    return
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  console.log(`Source: ${source}`)
  console.log(`ffmpeg: ${ffmpegPath}\n`)

  const startMs = 120_000
  const wantSeconds = 15

  for (const mode of ['fast', 'exact'] as const) {
    const out = join(outDir, `${mode}.mp4`)
    const start = '00:02:00.000'
    const dur = '00:00:15.000'

    const args =
      mode === 'fast'
        ? ['-hide_banner', '-loglevel', 'error', '-ss', start, '-i', source, '-t', dur,
           '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', out]
        : ['-hide_banner', '-loglevel', 'error', '-ss', start, '-i', source, '-t', dur,
           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
           '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', out]

    const t0 = Date.now()
    const { code, stderr } = await run(args)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    if (code !== 0) {
      console.log(`${mode.toUpperCase()}: FAILED (exit ${code})`)
      console.log(stderr.trim().split('\n').slice(0, 4).join('\n'))
      process.exitCode = 1
      continue
    }

    const size = statSync(out).size
    const actual = await probeDuration(out)
    const drift = actual === null ? null : Math.abs(actual - wantSeconds)

    console.log(`${mode.toUpperCase()}:`)
    console.log(`  took        : ${elapsed}s`)
    console.log(`  size        : ${(size / 1024 / 1024).toFixed(2)} MB`)
    console.log(`  duration    : ${actual === null ? 'unknown' : actual.toFixed(2) + 's'} (asked ${wantSeconds}s)`)
    if (drift !== null) {
      console.log(`  length drift: ${drift.toFixed(2)}s ${drift <= 1.5 ? 'OK' : 'TOO MUCH'}`)
    }
    console.log('')
  }

  console.log(`Clips left in ${outDir} -- open them to confirm they play.`)
  void startMs
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
