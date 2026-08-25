import { multiKillTagType, type AutoTagEvent, type AutoTagType } from './types'
import { dragonDisplayName } from './dragonLabels'

// Turns League's in-game event feed into bookmarks.
//
// This is the fallback, not the primary path. When a recording links to a Riot
// match, the match timeline wins: it carries positions, assist lists, item
// purchases, ward placements and everything else the derived tags are built
// from. The live feed carries a fraction of that.
//
// It exists for the games the API never describes -- custom games, which are
// never published to match-v5 at all, and matches Riot simply never returns. In
// those cases the choice is between these bookmarks and none, and a kill marker
// with no assist list still takes you to the kill.
//
// Shared rather than main-only because the fallback is applied by the same
// renderer code that discovers linking has permanently failed.

/** One entry from `events.Events` in the allgamedata payload. */
export interface LiveEventLike {
  EventID: number
  EventName: string
  /** Seconds on the in-game clock. */
  EventTime: number
  KillerName?: string
  VictimName?: string
  Assisters?: string[]
  DragonType?: string
  Stolen?: string
  TurretKilled?: string
  InhibKilled?: string
  KillStreak?: number
  Acer?: string
  AcingTeam?: string
}

/**
 * Compares two League identifiers.
 *
 * The feed is inconsistent about tags: KillerName may be 'Name#TAG' while
 * Assisters carries bare names, and it has changed between patches. Comparing
 * the part before the '#' is what makes kill/death/assist attribution work at
 * all -- an exact comparison silently classifies every one of your own kills as
 * somebody else's.
 */
export function isSamePlayer(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return a.split('#')[0].toLowerCase() === b.split('#')[0].toLowerCase()
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000)
}

/**
 * Maps the feed to bookmark events.
 *
 * Only events that identify a moment worth jumping to are kept. Deliberately
 * dropped: GameStart and MinionsSpawning (fixed times, nothing happened),
 * FirstBrick (duplicates a TurretKilled event), and anything unrecognised --
 * an unknown event name becomes no bookmark rather than a bookmark reading
 * "unknown", because Riot adds event types and a mystery marker is worse than
 * a missing one.
 */
export function mapLiveEventsToTags(
  events: LiveEventLike[],
  activePlayerName: string | null
): AutoTagEvent[] {
  const tags: AutoTagEvent[] = []

  for (const event of events) {
    const gameTimestampMs = secondsToMs(event.EventTime)
    const byMe = isSamePlayer(event.KillerName, activePlayerName ?? undefined)
    const toMe = isSamePlayer(event.VictimName, activePlayerName ?? undefined)
    const assistedByMe = (event.Assisters ?? []).some((name) =>
      isSamePlayer(name, activePlayerName ?? undefined)
    )

    switch (event.EventName) {
      case 'ChampionKill': {
        // Attribution order matters: a kill you also assisted is a kill, and
        // your own death takes precedence over having "killed" nothing.
        let type: AutoTagType | null = null
        let label = ''

        if (toMe) {
          type = 'death'
          label = event.KillerName ? `Killed by ${bareName(event.KillerName)}` : 'Death'
        } else if (byMe) {
          type = 'kill'
          label = event.VictimName ? `Killed ${bareName(event.VictimName)}` : 'Kill'
        } else if (assistedByMe) {
          type = 'assist'
          label = event.VictimName ? `Assisted on ${bareName(event.VictimName)}` : 'Assist'
        }

        // A kill between two other players is not a bookmark on your VOD.
        if (type) tags.push({ type, gameTimestampMs, label })
        break
      }

      case 'Multikill': {
        // Only the local player's multikills are worth marking.
        if (!byMe || !event.KillStreak) break
        const type = multiKillTagType(event.KillStreak)
        tags.push({
          type,
          gameTimestampMs,
          label: `${event.KillStreak}x multikill`
        })
        break
      }

      case 'TurretKilled':
        tags.push({
          type: 'turret',
          gameTimestampMs,
          label: byMe ? 'Turret destroyed' : 'Turret lost',
          detail: event.TurretKilled ?? undefined
        })
        break

      case 'InhibKilled':
        tags.push({
          type: 'inhibitor',
          gameTimestampMs,
          label: byMe ? 'Inhibitor destroyed' : 'Inhibitor lost',
          detail: event.InhibKilled ?? undefined
        })
        break

      case 'DragonKill':
        tags.push({
          type: 'dragon',
          gameTimestampMs,
          label: dragonDisplayName(event.DragonType),
          // Riot sends 'True'/'False' as strings here.
          detail: isTrue(event.Stolen) ? 'Stolen' : undefined
        })
        break

      case 'HeraldKill':
        tags.push({
          type: 'herald',
          gameTimestampMs,
          label: 'Rift Herald',
          detail: isTrue(event.Stolen) ? 'Stolen' : undefined
        })
        break

      case 'BaronKill':
        tags.push({
          type: 'baron',
          gameTimestampMs,
          label: 'Baron Nashor',
          detail: isTrue(event.Stolen) ? 'Stolen' : undefined
        })
        break

      case 'Ace':
        tags.push({
          type: 'other_objective',
          gameTimestampMs,
          label: 'Ace',
          detail: event.AcingTeam ?? undefined
        })
        break

      default:
        // Unrecognised, or deliberately uninteresting. No bookmark.
        break
    }
  }

  return tags.sort((a, b) => a.gameTimestampMs - b.gameTimestampMs)
}

function bareName(name: string): string {
  return name.split('#')[0]
}

function isTrue(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'true'
}

/**
 * Whether the live feed should be used for a recording's bookmarks.
 *
 * Only once linking has permanently failed. While linking is still pending the
 * timeline may yet arrive, and writing live-event bookmarks in the meantime
 * would mean either duplicating them later or clearing the user's view of their
 * own game twice.
 */
export function shouldUseLiveEventFallback(input: {
  linkState: string | null
  hasMatchId: boolean
  hasLiveEvents: boolean
}): boolean {
  if (input.hasMatchId) return false
  if (!input.hasLiveEvents) return false
  return input.linkState === 'failed'
}
