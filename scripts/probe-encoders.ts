/**
 * Reports which video encoders actually work on this machine.
 *
 * Run outside Electron on purpose: probing needs nothing from the app, and
 * running it standalone means the go/no-go answer for the quality presets can
 * be obtained without launching the UI.
 *
 *   npx tsx scripts/probe-encoders.ts
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { probeEncoders, readInventory } from '../src/main/recorder/encoderCapabilities'
import { describeEncoder } from '../src/main/recorder/encoderParsing'

function ffmpegPath(): string {
  // Resolved directly rather than through ffmpegBinary.ts, which imports
  // electron for its packaged-build branch.
  const path = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  if (!existsSync(path)) {
    throw new Error(`No bundled ffmpeg at ${path}`)
  }
  return path
}

async function main(): Promise<void> {
  const path = ffmpegPath()
  console.log(`ffmpeg: ${path}\n`)

  const inventory = await readInventory(path)
  console.log(`Compiled-in encoders found: ${inventory.encoders.size}`)
  console.log(`Compiled-in filters found:  ${inventory.filters.size}\n`)

  console.log('Probing each candidate (one child process, hard timeout)...\n')
  const capabilities = await probeEncoders(path)

  for (const outcome of capabilities.outcomes) {
    const status = !outcome.available ? 'ABSENT ' : outcome.passed ? 'PASS   ' : 'FAIL   '
    const timing = outcome.durationMs > 0 ? `${outcome.durationMs}ms` : '-'
    console.log(`  ${status} ${outcome.name.padEnd(12)} ${timing.padStart(7)}`)
    if (outcome.error) console.log(`          ${outcome.error}`)
  }

  console.log(`\nCapture filter (ddagrab):  ${capabilities.hasDdagrab ? 'yes' : 'NO'}`)
  console.log(`Scaling filters:           ${capabilities.hasScalingFilters ? 'yes' : 'no'}`)
  console.log(`Tonemap filters (HDR):     ${capabilities.hasTonemapFilters ? 'yes' : 'no'}`)
  console.log(`\nDefault encoder: ${describeEncoder(capabilities.chosen)}`)

  if (!capabilities.chosen) {
    console.log('\nNo usable encoder. Recording is not possible on this machine.')
  } else if (capabilities.chosen === 'libx264') {
    console.log('\nSoftware encoding only -- quality presets should be centred on x264.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
