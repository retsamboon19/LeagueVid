import { describe, expect, it } from 'vitest'
import { dedupeEarnedByGroup } from './evaluate'
import type { EarnedAchievement } from './types'

function earned(overrides: Partial<EarnedAchievement>): EarnedAchievement {
  return {
    id: 'x',
    title: 'X',
    description: '',
    category: 'positive',
    group: 'deaths',
    priority: 50,
    tier: 'R',
    icon: 'award',
    isEstimate: false,
    isFiller: false,
    ...overrides
  }
}

describe('dedupeEarnedByGroup', () => {
  // The bug this exists to prevent: a deathless game satisfies four rules in the
  // `deaths`/`longevity` space that all describe the same thing, and an uncapped
  // list would print all of them.
  it('keeps only the highest-priority entry per group', () => {
    const result = dedupeEarnedByGroup([
      earned({ id: 'survivor', group: 'deaths', priority: 63 }),
      earned({ id: 'flawless', group: 'deaths', priority: 90 }),
      earned({ id: 'untouchable', group: 'deaths', priority: 51 })
    ])

    expect(result.map((a) => a.id)).toEqual(['flawless'])
  })

  it('lets a group contribute to both categories', () => {
    const result = dedupeEarnedByGroup([
      earned({ id: 'cs_machine', group: 'farming', priority: 66 }),
      earned({ id: 'low_cs', group: 'farming', priority: 56, category: 'negative' })
    ])

    expect(result.map((a) => a.id).sort()).toEqual(['cs_machine', 'low_cs'])
  })

  // Unlike the capped selection, fillers are not held in a separate lane here:
  // "Farm Machine" beside "Kept Farming" is the padding the grouping exists to
  // remove, and a real rule always outranks a filler on priority.
  it('lets a real achievement suppress the filler covering the same ground', () => {
    const result = dedupeEarnedByGroup([
      earned({ id: 'steady_farm', group: 'farming', priority: 24, isFiller: true }),
      earned({ id: 'cs_machine', group: 'farming', priority: 66 })
    ])

    expect(result.map((a) => a.id)).toEqual(['cs_machine'])
  })

  it('puts positives before negatives', () => {
    const result = dedupeEarnedByGroup([
      earned({ id: 'bad', group: 'damage', category: 'negative' }),
      earned({ id: 'good', group: 'deaths' })
    ])

    expect(result.map((a) => a.id)).toEqual(['good', 'bad'])
  })
})
