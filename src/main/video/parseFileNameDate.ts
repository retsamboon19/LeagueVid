// Extracts a recording date/time embedded in a video's file name, when
// present. Recording tools commonly stamp the exact capture moment into the
// filename, which survives file copies/moves -- unlike filesystem
// birthtime/mtime, which reset whenever the file is touched.
//
// Supported patterns (checked in order, first match wins):
//   1. Outplay-style:      MM-DD-YYYY_[H]H-MM-SS[-mmm]
//        e.g. "League of Legends_07-22-2026_22-35-48-300.mp4"
//             "League of Legends 07-27-2026_1-02-21-702.mp4"
//   2. ISO-ish:            YYYY-MM-DD_HH-MM-SS or YYYY-MM-DD HH.MM.SS
//        e.g. "Recording_2026-07-22_22-35-48.mp4"
//   3. Compact timestamp:  YYYYMMDD_HHMMSS or YYYYMMDD-HHMMSS
//        e.g. "OBS_20260722_223548.mp4"
export function parseRecordedAtFromFileName(fileName: string): number | null {
  const patterns: Array<{
    regex: RegExp
    build: (m: RegExpMatchArray) => number
  }> = [
    {
      // MM-DD-YYYY_(H)H-MM-SS(-mmm)?
      //
      // The hour is 1-2 digits because Outplayed doesn't pad it: real file
      // names include "Desktop 07-27-2026_0-25-37-967.mp4" and
      // "League of Legends 07-27-2026_1-02-21-702.mp4". Requiring two digits
      // made every recording from midnight to 9am miss all three patterns
      // and fall back to birthtime/mtime -- i.e. the time the file was last
      // copied, not the time the game was played, which then sent match
      // linking looking in the wrong part of the day. Minutes and seconds
      // stay two-digit: they're always padded, and keeping them fixed limits
      // how much unrelated punctuation this can match by accident.
      regex: /(\d{2})-(\d{2})-(\d{4})[_ ](\d{1,2})-(\d{2})-(\d{2})(?:-(\d{1,3}))?/,
      build: (m) => {
        const [, mm, dd, yyyy, hh, min, ss, ms] = m
        return new Date(
          Number(yyyy),
          Number(mm) - 1,
          Number(dd),
          Number(hh),
          Number(min),
          Number(ss),
          ms ? Number(ms) : 0
        ).getTime()
      }
    },
    {
      // YYYY-MM-DD_HH-MM-SS or YYYY-MM-DD HH.MM.SS
      regex: /(\d{4})-(\d{2})-(\d{2})[_ ](\d{2})[-.:](\d{2})[-.:](\d{2})/,
      build: (m) => {
        const [, yyyy, mm, dd, hh, min, ss] = m
        return new Date(
          Number(yyyy),
          Number(mm) - 1,
          Number(dd),
          Number(hh),
          Number(min),
          Number(ss)
        ).getTime()
      }
    },
    {
      // YYYYMMDD_HHMMSS or YYYYMMDD-HHMMSS
      regex: /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/,
      build: (m) => {
        const [, yyyy, mm, dd, hh, min, ss] = m
        return new Date(
          Number(yyyy),
          Number(mm) - 1,
          Number(dd),
          Number(hh),
          Number(min),
          Number(ss)
        ).getTime()
      }
    }
  ]

  for (const { regex, build } of patterns) {
    const match = fileName.match(regex)
    if (!match) continue
    const timestamp = build(match)
    // Sanity check: reject obviously-invalid dates (e.g. month 13, or a
    // date far outside any plausible recording range) rather than trusting
    // a coincidental digit sequence that happens to match the pattern shape.
    if (Number.isFinite(timestamp) && isPlausibleRecordingDate(timestamp)) {
      return timestamp
    }
  }

  return null
}

function isPlausibleRecordingDate(timestamp: number): boolean {
  const EARLIEST = new Date(2009, 0, 1).getTime() // LoL's original release year
  const now = Date.now()
  const oneDayMs = 24 * 60 * 60 * 1000
  return timestamp >= EARLIEST && timestamp <= now + oneDayMs
}
