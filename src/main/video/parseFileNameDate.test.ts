import { describe, expect, it } from 'vitest'
import { parseRecordedAtFromFileName } from './parseFileNameDate'

/** Local-time expectation, built the same way the parser builds its result. */
function localTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0
): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime()
}

describe('parseRecordedAtFromFileName', () => {
  describe('Outplayed-style MM-DD-YYYY_HH-MM-SS-mmm', () => {
    it('parses a padded two-digit hour', () => {
      expect(parseRecordedAtFromFileName('League of Legends_07-22-2026_22-35-48-300.mp4')).toBe(
        localTime(2026, 7, 22, 22, 35, 48, 300)
      )
    })

    // The reason this fix exists. Outplayed does not pad the hour, so every
    // recording made between midnight and 9am matched none of the patterns
    // and silently fell back to the file's birthtime/mtime -- which is the
    // time the file was last copied, not the time the game was played. Both
    // of these are real file names from the user's recordings folder.
    it('parses an unpadded midnight-hour name', () => {
      expect(parseRecordedAtFromFileName('Desktop 07-27-2026_0-25-37-967.mp4')).toBe(
        localTime(2026, 7, 27, 0, 25, 37, 967)
      )
    })

    it('parses an unpadded 1am name', () => {
      expect(parseRecordedAtFromFileName('League of Legends 07-27-2026_1-02-21-702.mp4')).toBe(
        localTime(2026, 7, 27, 1, 2, 21, 702)
      )
    })

    it('parses every unpadded hour from 0 to 9', () => {
      for (let hour = 0; hour <= 9; hour++) {
        expect(parseRecordedAtFromFileName(`Desktop 07-27-2026_${hour}-05-09-120.mp4`)).toBe(
          localTime(2026, 7, 27, hour, 5, 9, 120)
        )
      }
    })

    it('parses without the milliseconds suffix', () => {
      expect(parseRecordedAtFromFileName('Desktop 07-27-2026_9-05-09.mp4')).toBe(
        localTime(2026, 7, 27, 9, 5, 9, 0)
      )
    })

    it('accepts a space between the date and the time', () => {
      expect(parseRecordedAtFromFileName('Desktop 07-27-2026 8-15-00.mp4')).toBe(
        localTime(2026, 7, 27, 8, 15, 0)
      )
    })
  })

  describe('other supported shapes', () => {
    it('parses the ISO-ish form', () => {
      expect(parseRecordedAtFromFileName('Recording_2026-07-22_22-35-48.mp4')).toBe(
        localTime(2026, 7, 22, 22, 35, 48)
      )
    })

    it('parses the ISO-ish form with dotted time', () => {
      expect(parseRecordedAtFromFileName('Recording 2026-07-22 22.35.48.mp4')).toBe(
        localTime(2026, 7, 22, 22, 35, 48)
      )
    })

    it('parses the compact form', () => {
      expect(parseRecordedAtFromFileName('OBS_20260722_223548.mp4')).toBe(
        localTime(2026, 7, 22, 22, 35, 48)
      )
    })
  })

  describe('rejection', () => {
    it('returns null when there is no timestamp at all', () => {
      expect(parseRecordedAtFromFileName('Yorick top gap.mp4')).toBeNull()
    })

    it('returns null for a date before League existed', () => {
      expect(parseRecordedAtFromFileName('Desktop 07-27-2001_5-25-37-967.mp4')).toBeNull()
    })

    it('returns null for a date well in the future', () => {
      expect(parseRecordedAtFromFileName('Desktop 07-27-2099_5-25-37-967.mp4')).toBeNull()
    })

    // A single-digit hour widens what pattern 1 will match, so it's worth
    // pinning that a bare resolution-looking sequence still isn't read as a
    // date.
    it('returns null for a resolution-like digit run', () => {
      expect(parseRecordedAtFromFileName('clip 1920-1080 60fps.mp4')).toBeNull()
    })
  })
})
