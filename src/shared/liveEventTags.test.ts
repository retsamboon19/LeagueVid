import { describe, expect, it } from 'vitest'
import {
  isSamePlayer,
  mapLiveEventsToTags,
  shouldUseLiveEventFallback,
  type LiveEventLike
} from './liveEventTags'

const ME = 'Yorickenjoyer#EUW'

function feed(...events: Array<Partial<LiveEventLike> & { EventName: string }>): LiveEventLike[] {
  return events.map((event, index) => ({
    EventID: index,
    EventTime: 100 + index,
    ...event
  }))
}

describe('isSamePlayer', () => {
  it('matches identical identifiers', () => {
    expect(isSamePlayer(ME, ME)).toBe(true)
  })

  // The feed is inconsistent about tags -- KillerName may carry 'Name#TAG'
  // while Assisters carries bare names. An exact comparison would classify
  // every one of your own kills as somebody else's.
  it('matches a tagged name against a bare one', () => {
    expect(isSamePlayer('Yorickenjoyer#EUW', 'Yorickenjoyer')).toBe(true)
    expect(isSamePlayer('Yorickenjoyer', 'Yorickenjoyer#EUW')).toBe(true)
  })

  it('ignores case', () => {
    expect(isSamePlayer('yorickenjoyer', 'Yorickenjoyer#EUW')).toBe(true)
  })

  it('does not match different players', () => {
    expect(isSamePlayer('Rockman#EUW', ME)).toBe(false)
  })

  it('does not match when either side is missing', () => {
    expect(isSamePlayer(undefined, ME)).toBe(false)
    expect(isSamePlayer(ME, undefined)).toBe(false)
  })
})

describe('mapLiveEventsToTags', () => {
  it('converts in-game seconds to milliseconds', () => {
    const tags = mapLiveEventsToTags(
      feed({ EventName: 'BaronKill', EventTime: 1234.567 }),
      ME
    )
    expect(tags[0].gameTimestampMs).toBe(1_234_567)
  })

  describe('champion kills', () => {
    it('marks a kill by the local player', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'ChampionKill', KillerName: ME, VictimName: 'Rockman#EUW' }),
        ME
      )
      expect(tags).toHaveLength(1)
      expect(tags[0].type).toBe('kill')
      expect(tags[0].label).toBe('Killed Rockman')
    })

    it('marks a death', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'ChampionKill', KillerName: 'Rockman#EUW', VictimName: ME }),
        ME
      )
      expect(tags[0].type).toBe('death')
      expect(tags[0].label).toBe('Killed by Rockman')
    })

    it('marks an assist', () => {
      const tags = mapLiveEventsToTags(
        feed({
          EventName: 'ChampionKill',
          KillerName: 'Ally#EUW',
          VictimName: 'Rockman#EUW',
          Assisters: ['Yorickenjoyer']
        }),
        ME
      )
      expect(tags[0].type).toBe('assist')
      expect(tags[0].label).toBe('Assisted on Rockman')
    })

    // A death you also somehow assisted is still a death, and a kill you
    // assisted is a kill -- the order these are checked in is the behaviour.
    it('prefers death over assist when both apply', () => {
      const tags = mapLiveEventsToTags(
        feed({
          EventName: 'ChampionKill',
          KillerName: 'Rockman#EUW',
          VictimName: ME,
          Assisters: [ME]
        }),
        ME
      )
      expect(tags[0].type).toBe('death')
    })

    it('prefers kill over assist when both apply', () => {
      const tags = mapLiveEventsToTags(
        feed({
          EventName: 'ChampionKill',
          KillerName: ME,
          VictimName: 'Rockman#EUW',
          Assisters: [ME]
        }),
        ME
      )
      expect(tags[0].type).toBe('kill')
    })

    // Someone else's kill across the map is not a bookmark on your VOD.
    it('ignores a kill the local player had no part in', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'ChampionKill', KillerName: 'A#EUW', VictimName: 'B#EUW' }),
        ME
      )
      expect(tags).toEqual([])
    })
  })

  describe('multikills', () => {
    it('maps a streak to its own tier', () => {
      const tags = mapLiveEventsToTags(
        feed(
          { EventName: 'Multikill', KillerName: ME, KillStreak: 2 },
          { EventName: 'Multikill', KillerName: ME, KillStreak: 3 },
          { EventName: 'Multikill', KillerName: ME, KillStreak: 4 },
          { EventName: 'Multikill', KillerName: ME, KillStreak: 5 }
        ),
        ME
      )
      expect(tags.map((t) => t.type)).toEqual([
        'doublekill',
        'triplekill',
        'quadrakill',
        'pentakill'
      ])
    })

    it('ignores other players multikills', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'Multikill', KillerName: 'Rockman#EUW', KillStreak: 3 }),
        ME
      )
      expect(tags).toEqual([])
    })

    it('ignores a multikill with no streak length', () => {
      const tags = mapLiveEventsToTags(feed({ EventName: 'Multikill', KillerName: ME }), ME)
      expect(tags).toEqual([])
    })
  })

  describe('objectives', () => {
    it('names the dragon subtype', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'DragonKill', KillerName: ME, DragonType: 'Infernal' }),
        ME
      )
      expect(tags[0].type).toBe('dragon')
      expect(tags[0].label).toBe('Infernal Dragon')
    })

    it('names the elder dragon properly rather than "Elder Dragon Dragon"', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'DragonKill', KillerName: ME, DragonType: 'Elder' }),
        ME
      )
      expect(tags[0].label).toBe('Elder Dragon')
    })

    // Riot sends these as the strings 'True' and 'False', not booleans.
    it('notes a stolen objective', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'BaronKill', KillerName: ME, Stolen: 'True' }),
        ME
      )
      expect(tags[0].detail).toBe('Stolen')
    })

    it('does not mark an unstolen objective as stolen', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'BaronKill', KillerName: ME, Stolen: 'False' }),
        ME
      )
      expect(tags[0].detail).toBeUndefined()
    })

    it('distinguishes a turret destroyed from a turret lost', () => {
      const tags = mapLiveEventsToTags(
        feed(
          { EventName: 'TurretKilled', KillerName: ME, TurretKilled: 'Turret_T2_L_03_A' },
          { EventName: 'TurretKilled', KillerName: 'Rockman#EUW' }
        ),
        ME
      )
      expect(tags[0].label).toBe('Turret destroyed')
      expect(tags[0].detail).toBe('Turret_T2_L_03_A')
      expect(tags[1].label).toBe('Turret lost')
    })

    it('marks heralds, barons, inhibitors and aces', () => {
      const tags = mapLiveEventsToTags(
        feed(
          { EventName: 'HeraldKill', KillerName: ME },
          { EventName: 'BaronKill', KillerName: ME },
          { EventName: 'InhibKilled', KillerName: ME },
          { EventName: 'Ace', Acer: ME, AcingTeam: 'ORDER' }
        ),
        ME
      )
      expect(tags.map((t) => t.type)).toEqual(['herald', 'baron', 'inhibitor', 'other_objective'])
    })
  })

  describe('what is deliberately dropped', () => {
    // Fixed-time events where nothing happened, and FirstBrick which duplicates
    // a TurretKilled event at the same moment.
    it('ignores GameStart, MinionsSpawning and FirstBrick', () => {
      const tags = mapLiveEventsToTags(
        feed(
          { EventName: 'GameStart', EventTime: 0.05 },
          { EventName: 'MinionsSpawning', EventTime: 65 },
          { EventName: 'FirstBrick', KillerName: ME }
        ),
        ME
      )
      expect(tags).toEqual([])
    })

    // Riot adds event types. A bookmark reading "unknown" is worse than no
    // bookmark at all.
    it('ignores an event name it does not recognise', () => {
      const tags = mapLiveEventsToTags(
        feed({ EventName: 'AtakhanKill2026', KillerName: ME }),
        ME
      )
      expect(tags).toEqual([])
    })
  })

  it('returns bookmarks in game-time order', () => {
    const tags = mapLiveEventsToTags(
      [
        { EventID: 0, EventName: 'BaronKill', EventTime: 1200, KillerName: ME },
        { EventID: 1, EventName: 'DragonKill', EventTime: 400, KillerName: ME },
        { EventID: 2, EventName: 'ChampionKill', EventTime: 800, KillerName: ME, VictimName: 'x' }
      ],
      ME
    )
    expect(tags.map((t) => t.gameTimestampMs)).toEqual([400_000, 800_000, 1_200_000])
  })

  it('produces nothing when the local player is unknown', () => {
    const tags = mapLiveEventsToTags(
      feed({ EventName: 'ChampionKill', KillerName: ME, VictimName: 'Rockman#EUW' }),
      null
    )
    // Kill attribution is impossible, so no kill/death/assist markers.
    expect(tags.filter((t) => ['kill', 'death', 'assist'].includes(t.type))).toEqual([])
  })

  it('handles an empty feed', () => {
    expect(mapLiveEventsToTags([], ME)).toEqual([])
  })
})

describe('shouldUseLiveEventFallback', () => {
  // Riot's timeline is strictly richer -- positions, assist lists, item
  // purchases -- so it wins whenever it exists.
  it('is false once the video has a match link', () => {
    expect(
      shouldUseLiveEventFallback({ linkState: 'failed', hasMatchId: true, hasLiveEvents: true })
    ).toBe(false)
  })

  // While linking is still pending the timeline may yet arrive. Writing live
  // bookmarks now would mean either duplicating them later or rewriting the
  // user's view of their own game twice.
  it('is false while linking is still being attempted', () => {
    expect(
      shouldUseLiveEventFallback({ linkState: 'pending', hasMatchId: false, hasLiveEvents: true })
    ).toBe(false)
  })

  it('is true once linking has permanently failed', () => {
    expect(
      shouldUseLiveEventFallback({ linkState: 'failed', hasMatchId: false, hasLiveEvents: true })
    ).toBe(true)
  })

  it('is false with no events to fall back on', () => {
    expect(
      shouldUseLiveEventFallback({ linkState: 'failed', hasMatchId: false, hasLiveEvents: false })
    ).toBe(false)
  })
})
