import { describe, expect, it } from 'vitest'
import { parseRecordedAtFromFileName } from '../video/parseFileNameDate'
import { formatFileNameStamp, sanitizeFileNamePart } from './outputPaths'

describe('formatFileNameStamp', () => {
  it('formats as ISO-ordered date and hyphenated time', () => {
    expect(formatFileNameStamp(new Date(2026, 6, 29, 14, 32, 7))).toBe('2026-07-29 14-32-07')
  })

  it('pads every component', () => {
    expect(formatFileNameStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03-04-05')
  })

  // The point of this format: a recorded file that later gets re-imported from
  // disk -- after a library reset, or by pointing a linked folder at the
  // recordings directory -- resolves its own timestamp from its name rather
  // than falling back to a filesystem time that reflects the last copy.
  it('produces a name the existing filename date parser can read back', () => {
    const when = new Date(2026, 6, 29, 2, 5, 9)
    const fileName = `League of Legends Yorick ${formatFileNameStamp(when)}.mp4`

    const parsed = parseRecordedAtFromFileName(fileName)
    expect(parsed).toBe(new Date(2026, 6, 29, 2, 5, 9).getTime())
  })

  it('round-trips an early-morning time, which is what the parser fix was about', () => {
    const when = new Date(2026, 6, 29, 0, 25, 37)
    const parsed = parseRecordedAtFromFileName(`League of Legends ${formatFileNameStamp(when)}.mp4`)
    expect(parsed).toBe(when.getTime())
  })
})

describe('sanitizeFileNamePart', () => {
  it('strips characters Windows forbids', () => {
    expect(sanitizeFileNamePart('Kai<sa>:"/\\|?*')).toBe('Kaisa')
  })

  it('collapses whitespace', () => {
    expect(sanitizeFileNamePart('  Lee   Sin  ')).toBe('Lee Sin')
  })

  it('falls back rather than producing an empty name', () => {
    expect(sanitizeFileNamePart('///')).toBe('Recording')
    expect(sanitizeFileNamePart('   ')).toBe('Recording')
  })

  it('caps length so a long champion name cannot blow the path limit', () => {
    expect(sanitizeFileNamePart('x'.repeat(200)).length).toBe(60)
  })
})
