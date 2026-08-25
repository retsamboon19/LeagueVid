import { describe, expect, it } from 'vitest'
import { shouldShowFirstRunOnboarding } from './firstRunOnboarding'

describe('first-run onboarding', () => {
  it('appears when no account settings have ever been saved', () => {
    expect(shouldShowFirstRunOnboarding(null)).toBe(true)
  })

  it('does not return after an existing user removes every account', () => {
    expect(shouldShowFirstRunOnboarding({ accounts: [] })).toBe(false)
  })

  it('does not appear when retained install data contains an account', () => {
    expect(
      shouldShowFirstRunOnboarding({
        accounts: [
          {
            gameName: 'Player',
            tagLine: 'SG2',
            platform: 'sg2',
            puuid: 'existing-puuid'
          }
        ]
      })
    ).toBe(false)
  })
})
