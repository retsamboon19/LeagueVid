import { spawn } from 'child_process'
import type { AudioCaptureDevice } from '../../shared/types'

export type { AudioCaptureDevice }

// Enumerates DirectShow capture devices, which on Windows is the only audio
// input the bundled ffmpeg has at all -- there is no WASAPI loopback in this
// build. That single fact shapes the whole audio story: a microphone is easy,
// and desktop audio requires either a virtual loopback device the user has
// installed themselves or LeagueVid's own Chromium loopback bridge.
//
// Real output from `ffmpeg -list_devices true -f dshow -i dummy` on the
// development machine:
//
//   [dshow @ 000001ee] "Headset Microphone (2- DualSense Wireless Controller)" (audio)
//   [dshow @ 000001ee]   Alternative name "@device_cm_{33D9A762-...}\wave_{60AA2801-...}"
//   [dshow @ 000001ee] "Microphone (HyperX QuadCast)" (audio)
//   [dshow @ 000001ee]   Alternative name "@device_cm_{33D9A762-...}\wave_{6252AACF-...}"
//
// Two things about that command matter. It writes to stderr, not stdout, and
// it always exits non-zero ("Immediate exit requested") because listing
// devices is a side effect of deliberately failing to open an input named
// 'dummy'. Treating a non-zero exit as failure would report no devices on
// every machine.

/**
 * Names that indicate a device carrying system audio rather than a mic.
 *
 * 'Stereo Mix' is the Realtek driver's own loopback, usually disabled by
 * default. The rest are third-party virtual cables. Deliberately narrow:
 * something like "Steam Streaming Microphone" is virtual but is not desktop
 * audio, and flagging it would send users down a dead end.
 */
const LOOPBACK_HINTS = [
  /stereo\s*mix/i,
  /what\s*u\s*hear/i,
  /\bvb-?cable\b/i,
  /\bcable\s+output\b/i,
  /voicemeeter/i,
  /virtual-?audio-?capturer/i,
  /virtual\s+audio\s+(cable|device)/i,
  /\bloopback\b/i
]

export function looksLikeLoopback(name: string): boolean {
  return LOOPBACK_HINTS.some((pattern) => pattern.test(name))
}

/**
 * Parses the device listing.
 *
 * Handles both shapes ffmpeg has used: the current one, where each line is
 * tagged `(audio)` or `(video)`, and the older one, which printed
 * "DirectShow audio devices" section headers with untagged names beneath.
 */
export function parseAudioDevices(output: string): AudioCaptureDevice[] {
  const devices: AudioCaptureDevice[] = []
  let sectionIsAudio: boolean | null = null

  for (const rawLine of output.split(/\r?\n/)) {
    // Strip the '[dshow @ 000001ee...] ' prefix, keeping leading whitespace of
    // the remainder -- indentation is what marks an alternative-name line.
    const line = rawLine.replace(/^\s*\[dshow[^\]]*\]\s?/, '')

    const header = line.match(/DirectShow\s+(audio|video)\s+devices/i)
    if (header) {
      sectionIsAudio = header[1].toLowerCase() === 'audio'
      continue
    }

    const alternative = line.match(/^\s+Alternative name\s+"(.+)"\s*$/)
    if (alternative && devices.length > 0) {
      devices[devices.length - 1].alternativeName = alternative[1]
      continue
    }

    // A quoted name, optionally followed by its media type.
    const named = line.match(/^\s*"(.+)"(?:\s+\((audio|video)\))?\s*$/)
    if (!named) continue

    const [, name, kind] = named
    const isAudio = kind ? kind === 'audio' : sectionIsAudio === true
    if (!isAudio) continue

    devices.push({
      name,
      alternativeName: null,
      likelyLoopback: looksLikeLoopback(name)
    })
  }

  return devices
}

/** How long to wait for enumeration before giving up. */
const LIST_TIMEOUT_MS = 10000

export async function listAudioDevices(ffmpegPath: string): Promise<AudioCaptureDevice[]> {
  const output = await new Promise<string>((resolve) => {
    let collected = ''
    let settled = false

    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true }
    )

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(collected)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish()
    }, LIST_TIMEOUT_MS)

    // The listing goes to stderr. stdout is read too, in case a future build
    // moves it.
    child.stderr?.on('data', (chunk) => {
      collected += String(chunk)
    })
    child.stdout?.on('data', (chunk) => {
      collected += String(chunk)
    })

    child.on('error', finish)
    // Resolves on any exit code. This command always fails by design.
    child.on('close', finish)
  })

  return parseAudioDevices(output)
}
