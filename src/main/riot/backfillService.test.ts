import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMatchIdsByPuuid: vi.fn(),
  getMatchCached: vi.fn(),
  getMatchTimelineCached: vi.fn(),
  isMatchCached: vi.fn(),
  getSettings: vi.fn()
}))

vi.mock('./client', () => ({
  matchRegionForPlatform: () => 'sea'
}))

vi.mock('./clientSingleton', () => ({
  getRiotClient: () => ({ getMatchIdsByPuuid: mocks.getMatchIdsByPuuid })
}))

vi.mock('./matchCache', () => ({
  getMatchCached: mocks.getMatchCached,
  getMatchTimelineCached: mocks.getMatchTimelineCached,
  isMatchCached: mocks.isMatchCached
}))

vi.mock('../db/repository', () => ({
  getSettings: mocks.getSettings,
  getBackfillProgress: vi.fn(),
  resetBackfillTotal: vi.fn(),
  setBackfillProgress: vi.fn(),
  setBackfillTotal: vi.fn()
}))

import { refreshRecentMatchesNow } from './backfillService'

describe('refreshRecentMatchesNow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSettings.mockReturnValue({
      accounts: [{ platform: 'sg2', puuid: 'mine', gameName: 'Player', tagLine: 'SG2' }]
    })
    mocks.getMatchIdsByPuuid.mockResolvedValue(['SG2_cached', 'SG2_missing'])
    mocks.isMatchCached.mockImplementation(
      (_region: string, matchId: string) => matchId === 'SG2_cached'
    )
    mocks.getMatchCached.mockResolvedValue({})
    mocks.getMatchTimelineCached.mockResolvedValue({})
  })

  it('waits for missing recent match data before resolving', async () => {
    await refreshRecentMatchesNow()

    expect(mocks.getMatchIdsByPuuid).toHaveBeenCalledWith('sea', 'mine', {
      start: 0,
      count: 100,
      priority: 'foreground'
    })
    expect(mocks.getMatchCached).toHaveBeenCalledWith('sea', 'SG2_missing', 'foreground')
    expect(mocks.getMatchTimelineCached).toHaveBeenCalledWith('sea', 'SG2_missing', 'foreground')
    expect(mocks.getMatchCached).not.toHaveBeenCalledWith('sea', 'SG2_cached', 'foreground')
  })
})
