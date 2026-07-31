import { describe, expect, it } from 'vitest'
import { ACHIEVEMENTS } from './definitions'
import { THRESHOLDS } from './thresholds'
import { TIER_META, TIER_ORDER, byTierThenPriority, tierForDefinition, tierForPriority } from './tiers'
import type { AchievementTier } from './types'

// Guards the two things about the rarity/catalog layer that a future edit can
// silently break: a new rule shipping without a browsable description, and the
// tier bands drifting until the rare badge stops being rare.

describe('tierForPriority', () => {
  it('maps the documented priority bands onto tiers', () => {
    expect(tierForPriority(100)).toBe('SSR')
    expect(tierForPriority(THRESHOLDS.tiers.ssr)).toBe('SSR')
    expect(tierForPriority(THRESHOLDS.tiers.ssr - 1)).toBe('S')
    expect(tierForPriority(THRESHOLDS.tiers.s)).toBe('S')
    expect(tierForPriority(THRESHOLDS.tiers.s - 1)).toBe('R')
    expect(tierForPriority(0)).toBe('R')
  })

  it('honours an explicit override over the derived band', () => {
    expect(tierForDefinition({ priority: 10 })).toBe('R')
    expect(tierForDefinition({ priority: 10, tier: 'SSR' })).toBe('SSR')
  })
})

describe('byTierThenPriority', () => {
  it('sorts rarest first, then by priority inside a tier', () => {
    const sorted = [
      { tier: 'R' as AchievementTier, priority: 50 },
      { tier: 'SSR' as AchievementTier, priority: 90 },
      { tier: 'S' as AchievementTier, priority: 61 },
      { tier: 'S' as AchievementTier, priority: 80 }
    ].sort(byTierThenPriority)

    expect(sorted.map((s) => `${s.tier}${s.priority}`)).toEqual(['SSR90', 'S80', 'S61', 'R50'])
  })
})

describe('achievement definitions', () => {
  it('gives every achievement a unique id', () => {
    const ids = ACHIEVEMENTS.map((def) => def.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every achievement a hint for the browse-all catalog', () => {
    const missing = ACHIEVEMENTS.filter((def) => !def.hint || def.hint.trim().length === 0)
    expect(missing.map((def) => def.id)).toEqual([])
  })

  // The whole point of `hint` is that it says what an achievement is about
  // without publishing the bar. A digit in one is the tell that a threshold
  // leaked in -- which both spoils the discovery and goes stale the next time
  // the rules are recalibrated.
  it('keeps hints free of numbers', () => {
    const numeric = ACHIEVEMENTS.filter((def) => /\d/.test(def.hint))
    expect(numeric.map((def) => `${def.id}: ${def.hint}`)).toEqual([])
  })

  it('ends every hint as a sentence', () => {
    const unpunctuated = ACHIEVEMENTS.filter((def) => !def.hint.trim().endsWith('.'))
    expect(unpunctuated.map((def) => def.id)).toEqual([])
  })

  it('resolves every achievement to a tier that has display metadata', () => {
    for (const def of ACHIEVEMENTS) {
      const tier = tierForDefinition(def)
      expect(TIER_ORDER).toContain(tier)
      expect(TIER_META[tier]).toBeDefined()
    }
  })

  // The badge only means something while the top band stays small. If a
  // priority bump pushes a chunk of the rule set into SSR, that's a signal to
  // reconsider the priority rather than to loosen this.
  it('keeps SSR a small minority of the rule set', () => {
    const ssr = ACHIEVEMENTS.filter((def) => tierForDefinition(def) === 'SSR')
    expect(ssr.length).toBeGreaterThan(0)
    expect(ssr.length / ACHIEVEMENTS.length).toBeLessThan(0.15)
  })

  it('uses every tier at least once', () => {
    const used = new Set(ACHIEVEMENTS.map((def) => tierForDefinition(def)))
    for (const tier of TIER_ORDER) expect(used).toContain(tier)
  })
})
