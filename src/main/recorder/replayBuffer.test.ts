import { describe, expect, it } from 'vitest'
import { teeTarget } from './ffmpegArgs'
import {
  SEGMENT_SECONDS,
  buildConcatList,
  ringFor,
  selectRecentSegments,
  type SegmentFile
} from './replayBuffer'

function segment(index: number, modifiedMs: number): SegmentFile {
  return {
    path: `H:\\rec\\buffer\\seg${String(index).padStart(3, '0')}.ts`,
    index,
    modifiedMs,
    sizeBytes: 1024 * 1024
  }
}

describe('selectRecentSegments', () => {
  it('returns nothing when the ring is empty', () => {
    expect(selectRecentSegments([], 120, SEGMENT_SECONDS)).toEqual([])
  })

  it('takes enough segments to cover the window', () => {
    const segments = [0, 1, 2, 3, 4, 5].map((i) => segment(i, 1000 + i * 2000))
    const selected = selectRecentSegments(segments, 6, 2)

    expect(selected).toHaveLength(3)
    expect(selected.map((s) => s.index)).toEqual([3, 4, 5])
  })

  it('rounds up so the window is covered rather than clipped', () => {
    const segments = [0, 1, 2, 3].map((i) => segment(i, 1000 + i * 2000))
    // 5 seconds of 2-second segments needs 3, not 2.
    expect(selectRecentSegments(segments, 5, 2)).toHaveLength(3)
  })

  it('returns them oldest first, ready for concatenation', () => {
    const segments = [0, 1, 2].map((i) => segment(i, 1000 + i * 2000))
    const selected = selectRecentSegments(segments, 6, 2)
    expect(selected.map((s) => s.modifiedMs)).toEqual([1000, 3000, 5000])
  })

  it('takes everything when the ring holds less than the window', () => {
    const segments = [0, 1].map((i) => segment(i, 1000 + i * 2000))
    expect(selectRecentSegments(segments, 120, 2)).toHaveLength(2)
  })

  // The behaviour this module exists for. segment_wrap makes ffmpeg reuse names
  // from 0, so after a wrap the highest-numbered file is the OLDEST. Selecting
  // by name would hand back the opening of the game instead of the moment the
  // user just pressed the key for.
  describe('across a wrap boundary', () => {
    it('picks the newest files even though their indices are lowest', () => {
      // A 6-slot ring that has wrapped: 003-005 are old, 000-002 were just
      // rewritten and hold the most recent footage.
      const segments = [
        segment(0, 20_000),
        segment(1, 22_000),
        segment(2, 24_000),
        segment(3, 12_000),
        segment(4, 14_000),
        segment(5, 16_000)
      ]

      const selected = selectRecentSegments(segments, 6, 2)
      expect(selected.map((s) => s.index)).toEqual([0, 1, 2])
    })

    it('spans the wrap when the window straddles it', () => {
      // Write head is at 001: 002-005 are older, 000-001 newest.
      const segments = [
        segment(0, 30_000),
        segment(1, 32_000),
        segment(2, 22_000),
        segment(3, 24_000),
        segment(4, 26_000),
        segment(5, 28_000)
      ]

      const selected = selectRecentSegments(segments, 8, 2)
      // Newest four, in time order: 005, 000, 001 plus 004.
      expect(selected.map((s) => s.index)).toEqual([4, 5, 0, 1])
      expect(selected.map((s) => s.modifiedMs)).toEqual([26_000, 28_000, 30_000, 32_000])
    })

    it('never returns segments out of time order', () => {
      const segments = [
        segment(0, 9000),
        segment(1, 11_000),
        segment(2, 5000),
        segment(3, 7000)
      ]
      const selected = selectRecentSegments(segments, 8, 2)

      for (let i = 1; i < selected.length; i++) {
        expect(selected[i].modifiedMs).toBeGreaterThan(selected[i - 1].modifiedMs)
      }
    })
  })
})

describe('buildConcatList', () => {
  it('writes one quoted file line per segment', () => {
    const list = buildConcatList([segment(0, 1000), segment(1, 3000)])
    expect(list).toBe(
      "file 'H:\\rec\\buffer\\seg000.ts'\nfile 'H:\\rec\\buffer\\seg001.ts'\n"
    )
  })

  // The concat demuxer treats backslashes literally inside single quotes, so a
  // Windows path needs no escaping -- but an apostrophe in a folder name does,
  // and getting it wrong reports "No such file or directory" for a file that
  // plainly exists.
  it('escapes an apostrophe in a path', () => {
    const odd: SegmentFile = { ...segment(0, 1000), path: "H:\\Bob's rec\\seg000.ts" }
    expect(buildConcatList([odd])).toContain("'H:\\Bob'\\''s rec\\seg000.ts'")
  })

  it('ends with a newline, which the demuxer requires', () => {
    expect(buildConcatList([segment(0, 1000)]).endsWith('\n')).toBe(true)
  })

  it('produces just a newline for no segments', () => {
    expect(buildConcatList([])).toBe('\n')
  })
})

describe('ringFor', () => {
  it('sizes the ring to the buffer duration plus a spare segment', () => {
    const ring = ringFor('H:\\rec\\buffer', 120)
    // 60 segments of 2s, plus one because the newest is always partial.
    expect(ring.segmentCount).toBe(61)
    expect(ring.segmentSeconds).toBe(2)
  })

  it('never sizes below two segments', () => {
    expect(ringFor('H:\\rec\\buffer', 1).segmentCount).toBe(2)
  })

  it('writes a numbered pattern the segment muxer understands', () => {
    expect(ringFor('H:\\rec\\buffer', 60).pattern).toBe('H:\\rec\\buffer\\seg%03d.ts')
  })
})

describe('teeTarget', () => {
  it('sends one encode to both the session file and the ring', () => {
    const target = teeTarget('H:\\rec\\session.mkv', {
      segmentPattern: 'H:\\rec\\buffer\\seg%03d.ts',
      segmentSeconds: 2,
      segmentCount: 61
    })

    expect(target).toContain('[f=matroska]')
    expect(target).toContain('f=segment')
    expect(target).toContain('segment_time=2')
    expect(target).toContain('segment_wrap=61')
    expect(target).toContain('segment_format=mpegts')
    expect(target).toContain('reset_timestamps=1')
  })

  // Inside a tee target ':' separates options and '|' separates legs, so an
  // unescaped Windows drive letter would be read as an option boundary.
  it('escapes colons and backslashes in Windows paths', () => {
    const target = teeTarget('H:\\rec\\session.mkv', {
      segmentPattern: 'H:\\rec\\seg%03d.ts',
      segmentSeconds: 2,
      segmentCount: 4
    })
    expect(target).toContain('H\\:\\\\rec\\\\session.mkv')
  })

  it('separates the two legs with a pipe', () => {
    const target = teeTarget('a.mkv', {
      segmentPattern: 'b%03d.ts',
      segmentSeconds: 2,
      segmentCount: 4
    })
    expect(target.split('|')).toHaveLength(2)
  })
})
