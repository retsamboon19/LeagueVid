import { describe, expect, it } from 'vitest'
import { dragonDisplayName } from './dragonLabels'

describe('dragonDisplayName', () => {
  it.each([
    ['AIR_DRAGON', 'Cloud Drake'],
    ['FIRE_DRAGON', 'Infernal Drake'],
    ['EARTH_DRAGON', 'Mountain Drake'],
    ['WATER_DRAGON', 'Ocean Drake'],
    ['HEXTECH_DRAGON', 'Hextech Drake'],
    ['CHEMTECH_DRAGON', 'Chemtech Drake'],
    ['ELDER_DRAGON', 'Elder Dragon']
  ])('maps Riot subtype %s to %s', (subtype, expected) => {
    expect(dragonDisplayName(subtype)).toBe(expected)
  })

  it('also accepts official names from the live event feed', () => {
    expect(dragonDisplayName('Infernal')).toBe('Infernal Drake')
    expect(dragonDisplayName('Cloud')).toBe('Cloud Drake')
  })

  it('keeps a generic fallback when Riot omits the subtype', () => {
    expect(dragonDisplayName(undefined)).toBe('Dragon')
  })
})
