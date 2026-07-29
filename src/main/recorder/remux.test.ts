import { describe, expect, it } from 'vitest'
import { mp4PathFor } from './remux'

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
