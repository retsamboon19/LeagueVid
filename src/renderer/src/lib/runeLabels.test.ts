import { describe, expect, it } from 'vitest'
import { labelRuneVars } from './runeLabels'

describe('rune performance labels', () => {
  it('labels Conqueror var1 as its post-game healing total', () => {
    expect(labelRuneVars(8010, [889, 0, 0])).toEqual({
      mapped: true,
      entries: [{ label: 'Total healing', value: 889, format: 'number' }]
    })
  })
})
