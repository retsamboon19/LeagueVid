import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegPath from 'ffmpeg-static'
import { mp4PathFor, remuxToMp4 } from './remux'

it('preserves both audible audio tracks when converting a real MKV to MP4', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'leaguevid-audio-remux-'))
  try {
    const sourcePath = join(directory, 'separate.mkv')
    execFileSync(ffmpegPath!, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
      '-map', '0:a', '-map', '1:a', '-c:a', 'aac', sourcePath
    ], { windowsHide: true })
    const result = await remuxToMp4({ ffmpegPath: ffmpegPath!, sourcePath, deleteSourceOnSuccess: false })
    expect(result.ok).toBe(true)
    for (const track of [0, 1]) {
      const pcm = execFileSync(ffmpegPath!, [
        '-v', 'error', '-i', result.importPath, '-map', `0:a:${track}`,
        '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'
      ], { windowsHide: true, maxBuffer: 1024 * 1024 })
      expect(pcm.length).toBeGreaterThan(48000 * 4)
      let peak = 0
      for (let offset = 0; offset < pcm.length; offset += 4) {
        peak = Math.max(peak, Math.abs(pcm.readFloatLE(offset)))
      }
      expect(peak).toBeGreaterThan(0.01)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 15000)

describe('mp4PathFor', () => {
  it('swaps the mkv extension for mp4', () => {
    expect(mp4PathFor('H:\\recordings\\League of Legends 2026-07-29 14-32-07.mkv')).toBe(
      'H:\\recordings\\League of Legends 2026-07-29 14-32-07.mp4'
    )
  })

  it('is case-insensitive about the extension', () => {
    expect(mp4PathFor('C:\\a\\b.MKV')).toBe('C:\\a\\b.mp4')
  })

  // Only the extension may change. A path containing '.mkv' earlier on -- a
  // folder called 'mkv archive', say -- must come out with its directory
  // intact.
  it('only replaces a trailing extension', () => {
    expect(mp4PathFor('H:\\mkv.old\\session.mkv')).toBe('H:\\mkv.old\\session.mp4')
  })

  it('leaves a path that is not an mkv alone', () => {
    expect(mp4PathFor('H:\\recordings\\session.mp4')).toBe('H:\\recordings\\session.mp4')
  })
})
