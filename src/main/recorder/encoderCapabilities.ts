import { spawn } from 'child_process'
import type { EncoderCapabilities, EncoderProbeOutcome } from '../../shared/types'
import {
  ENCODER_CANDIDATES,
  chooseDefaultEncoder,
  parseEncoderNames,
  parseFilterNames,
  sortOutcomesByRank
} from './encoderParsing'

// Discovers which encoders actually work on this machine.
//
// Two stages, because "compiled into ffmpeg" and "works here" are different
// claims. A build advertising h264_nvenc on a machine with an AMD card still
// advertises it; the encoder only fails when something tries to initialize it.
//
// Stage two is deliberately one child process per candidate with a hard
// timeout. Hardware encoder initialization can hang inside the vendor driver
// rather than returning an error -- OBS ships separate obs-nvenc-test.exe and
// obs-qsv-test.exe helpers precisely so that a hang costs a probe result
// instead of the application. A child process with a timer that kills it is
// the same isolation without shipping extra executables.

/** Long enough for a cold driver init, short enough not to stall Settings. */
const PROBE_TIMEOUT_MS = 12000
const LIST_TIMEOUT_MS = 10000

export interface FfmpegInventory {
  encoders: Set<string>
  filters: Set<string>
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/**
 * Runs ffmpeg with a hard ceiling on how long it may live.
 *
 * Resolves rather than rejects on failure: a probe that fails is a result, not
 * an exception. The kill-on-timeout is the whole point -- see the module note.
 */
function runBounded(ffmpegPath: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(ffmpegPath, args, { windowsHide: true })

    const timer = setTimeout(() => {
      timedOut = true
      // SIGKILL equivalent on Windows. Safe here in a way it isn't for a real
      // recording: these probes write to the null muxer, so there is no
      // container to leave unfinalized.
      child.kill('SIGKILL')
    }, timeoutMs)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 400_000) stdout = stdout.slice(-400_000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    // A binary that won't spawn at all is a failed run, not a thrown error --
    // the caller's job is to report which candidates work.
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/** What this ffmpeg build says it can do. Cheap: no encoding happens. */
export async function readInventory(ffmpegPath: string): Promise<FfmpegInventory> {
  const [encoders, filters] = await Promise.all([
    runBounded(ffmpegPath, ['-hide_banner', '-encoders'], LIST_TIMEOUT_MS),
    runBounded(ffmpegPath, ['-hide_banner', '-filters'], LIST_TIMEOUT_MS)
  ])

  return {
    // ffmpeg writes these listings to stdout, but older builds and some
    // wrappers put them on stderr, so both are parsed.
    encoders: parseEncoderNames(`${encoders.stdout}\n${encoders.stderr}`),
    filters: parseFilterNames(`${filters.stdout}\n${filters.stderr}`)
  }
}

/**
 * Encodes one second of synthetic video to the null muxer. Proves the encoder
 * initializes and produces frames without writing a file or needing a display.
 */
async function probeOne(ffmpegPath: string, encoder: string): Promise<EncoderProbeOutcome> {
  const result = await runBounded(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=640x480:rate=30',
      '-c:v',
      encoder,
      '-f',
      'null',
      '-'
    ],
    PROBE_TIMEOUT_MS
  )

  const passed = result.code === 0 && !result.timedOut

  return {
    name: encoder,
    available: true,
    passed,
    error: passed
      ? null
      : result.timedOut
        ? `Timed out after ${PROBE_TIMEOUT_MS / 1000}s -- the encoder did not finish initializing.`
        : result.stderr.trim().split(/\r?\n/).slice(-3).join(' ') ||
          `Exited with code ${result.code}.`,
    durationMs: result.durationMs
  }
}

/**
 * Probes every candidate and picks a default.
 *
 * Sequential on purpose. Two hardware encoders initializing at once can
 * contend for the same fixed-function block, so a parallel run can fail a
 * candidate that works fine on its own -- and a false negative here silently
 * downgrades every future recording to software encoding.
 */
export async function probeEncoders(ffmpegPath: string): Promise<EncoderCapabilities> {
  const inventory = await readInventory(ffmpegPath)

  const outcomes: EncoderProbeOutcome[] = []
  for (const candidate of ENCODER_CANDIDATES) {
    if (!inventory.encoders.has(candidate.name)) {
      outcomes.push({
        name: candidate.name,
        available: false,
        passed: false,
        error: 'Not included in this ffmpeg build.',
        durationMs: 0
      })
      continue
    }
    outcomes.push(await probeOne(ffmpegPath, candidate.name))
  }

  return {
    probedAt: Date.now(),
    outcomes: sortOutcomesByRank(outcomes),
    chosen: chooseDefaultEncoder(outcomes),
    hasDdagrab: inventory.filters.has('ddagrab'),
    hasScalingFilters:
      inventory.filters.has('hwdownload') &&
      inventory.filters.has('scale') &&
      inventory.filters.has('format'),
    hasTonemapFilters: inventory.filters.has('zscale') && inventory.filters.has('tonemap')
  }
}
