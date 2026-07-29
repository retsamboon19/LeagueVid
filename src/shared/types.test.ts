import { describe, expect, it } from 'vitest'
import { multiKillTagType } from './types'

// Doubles as the smoke test for the test harness itself: if this file runs,
// vitest can resolve and execute main/shared modules.
describe('multiKillTagType', () => {
  it('maps each streak length to its own tier', () => {
    expect(multiKillTagType(2)).toBe('doublekill')
    expect(multiKillTagType(3)).toBe('triplekill')
    expect(multiKillTagType(4)).toBe('quadrakill')
    expect(multiKillTagType(5)).toBe('pentakill')
  })

  // A streak longer than 5 is still a penta -- Riot has no tier above it,
  // and the library's filters match these types exactly (see
  // MULTIKILL_FILTER_TYPES), so an unmapped type would silently drop the
  // biggest plays out of every filter.
  it('treats anything above five as a pentakill', () => {
    expect(multiKillTagType(6)).toBe('pentakill')
    expect(multiKillTagType(9)).toBe('pentakill')
  })
})
