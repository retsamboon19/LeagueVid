import { ipcMain } from 'electron'
import { RiotApiError, accountRegionForPlatform, matchRegionForPlatform } from './client'
import { getRiotClient } from './clientSingleton'
import { getMatchCached, getMatchTimelineCached } from './matchCache'
import { extractPlayerEvents } from './extractEvents'
import {
  getLeadSwingBulk,
  getMatchActionTimeline,
  getMatchStats,
  type GetLeadSwingBulkArgs,
  type GetMatchStatsArgs
} from './matchStats'
import { requestBackfillNow } from './backfillService'
import { listCachedMatchEntries } from '../db/repository'
import type { PlatformRouting } from './types'
import type { MatchRosterData } from '../../shared/types'
import type { MatchInfoDto, ParticipantDto } from './types'

const getClient = getRiotClient

export interface FindAccountArgs {
  platform: PlatformRouting
  gameName: string
  tagLine: string
}

export interface FetchRecentMatchesArgs {
  accounts: Array<{ platform: PlatformRouting; puuid: string; accountLabel: string }>
  count?: number
  // Epoch ms window to search within, instead of just "most recent N
  // matches" -- needed to find older games (Riot's match history endpoint
  // only returns matches in recency order, so a video from months ago would
  // never surface without narrowing the search to its actual time range).
  startTimeMs?: number
  endTimeMs?: number
}

export interface FetchMatchBundleArgs {
  platform: PlatformRouting
  matchId: string
  puuid: string
}

// teamPosition can come back as '' on some matches (Riot's position
// inference occasionally fails, especially on older matches or non-
// Ranked/Draft modes). Fall back to individualPosition in that case before
// giving up on identifying the opposing laner. Shared by the match picker
// summary and the full match bundle so both agree on who "my laner" is.
function findEnemyLaner(match: { info: MatchInfoDto }, participant: ParticipantDto): ParticipantDto | undefined {
  const myPosition = participant.teamPosition || participant.individualPosition
  if (!myPosition || myPosition === 'Invalid') return undefined
  return match.info.participants.find((p) => {
    const theirPosition = p.teamPosition || p.individualPosition
    return p.teamId !== participant.teamId && theirPosition === myPosition
  })
}

interface AccountRef {
  platform: PlatformRouting
  puuid: string
  accountLabel: string
}

function buildMatchSummary(
  matchId: string,
  match: { info: MatchInfoDto },
  participant: ParticipantDto,
  account: AccountRef
) {
  const enemyLaner = findEnemyLaner(match, participant)
  return {
    matchId,
    gameStartTimestamp: match.info.gameStartTimestamp,
    gameEndTimestamp: match.info.gameEndTimestamp,
    gameDuration: match.info.gameDuration,
    gameMode: match.info.gameMode,
    gameVersion: match.info.gameVersion,
    championName: participant.championName,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    win: participant.win,
    teamPosition: participant.teamPosition,
    enemyChampionName: enemyLaner?.championName ?? null,
    puuid: account.puuid,
    platform: account.platform,
    accountLabel: account.accountLabel
  }
}

function toClientError(err: unknown): Error {
  if (err instanceof RiotApiError) {
    if (err.status === 403) return new Error('Riot API key is invalid or expired.')
    if (err.status === 404) return new Error('Not found. Double check the Riot ID or region.')
    if (err.status === 429) return new Error('Rate limited by Riot API. Try again shortly.')
    return new Error(err.message)
  }
  return err instanceof Error ? err : new Error('Unknown Riot API error')
}

export function registerRiotHandlers(): void {
  ipcMain.handle('riot:findAccount', async (_e, args: FindAccountArgs) => {
    try {
      const region = accountRegionForPlatform(args.platform)
      return await getClient().getAccountByRiotId(region, args.gameName, args.tagLine)
    } catch (err) {
      throw toClientError(err)
    }
  })

  // Returns lightweight per-player match summaries, suitable for a match
  // picker UI (avoids shipping all 10 participants' data to the renderer).
  // Searches across every linked account in parallel and merges the
  // results, since a recording could belong to any one of them.
  //
  // ALWAYS calls Riot live for the match id list -- deliberately not
  // cached. A previous version cached "what match ids exist in this time
  // window" and that broke in a way that was hard to detect: an empty
  // result is a valid, truthy JS array, so a window that genuinely (or
  // transiently) came back with zero matches got cached as "confirmed
  // empty" and served back forever afterward, silently hiding real
  // matches with no error surfaced anywhere. Individual match bodies
  // (immutable once a game ends) are still cached via getMatchCached --
  // that part was never the problem.
  ipcMain.handle('riot:fetchRecentMatches', async (_e, args: FetchRecentMatchesArgs) => {
    try {
      const perAccountResults = await Promise.all(
        args.accounts.map(async (account) => {
          const region = matchRegionForPlatform(account.platform)
          const hasTimeWindow = args.startTimeMs !== undefined || args.endTimeMs !== undefined
          const startTime =
            args.startTimeMs !== undefined ? Math.floor(args.startTimeMs / 1000) : undefined
          const endTime = args.endTimeMs !== undefined ? Math.floor(args.endTimeMs / 1000) : undefined

          // A time window needs every match id in range, not just the
          // first page -- otherwise a player with >100 games in a wide
          // window silently loses the older half of it. "Most recent N"
          // lookups (no window) stay a single page since they're already
          // bounded by args.count.
          const ids = hasTimeWindow
            ? await getClient().getAllMatchIdsByPuuid(region, account.puuid, {
                startTime,
                endTime
              })
            : await getClient().getMatchIdsByPuuid(region, account.puuid, {
                count: args.count ?? 20
              })

          console.log(
            `[riot] fetchRecentMatches: ${account.accountLabel} (${region}) ${
              hasTimeWindow ? `window ${startTime}-${endTime}` : `count=${args.count ?? 20}`
            } -> ${ids.length} match id(s)`
          )

          const summaries = await Promise.all(
            ids.map(async (id) => {
              const match = await getMatchCached(region, id)
              const participant = match.info.participants.find((p) => p.puuid === account.puuid)
              if (!participant) return null
              return buildMatchSummary(id, match, participant, account)
            })
          )
          return summaries.filter((s): s is NonNullable<typeof s> => s !== null)
        })
      )

      return perAccountResults
        .flat()
        .sort((a, b) => b.gameEndTimestamp - a.gameEndTimestamp)
    } catch (err) {
      throw toClientError(err)
    }
  })

  // Returns every match already downloaded to the local cache that any of
  // the given accounts played in -- no network calls, no date window, no
  // rate limit. This backs manual linking: rather than guessing a time
  // range, the user filters over whatever history has been downloaded so
  // far (the background backfill service keeps this growing).
  //
  // Unlike the retired "local match index", there's no coverage-shortcut
  // logic here that could suppress a live search -- this handler only ever
  // reports what it actually has, and manual mode presents it as exactly
  // that, so an incomplete cache can't silently look like "no matches
  // exist."
  ipcMain.handle('riot:listCachedMatches', (_e, args: { accounts: AccountRef[] }) => {
    const entries = listCachedMatchEntries<{ info: MatchInfoDto }>()
    const summaries: ReturnType<typeof buildMatchSummary>[] = []

    for (const entry of entries) {
      const match = entry.value
      if (!match?.info?.participants) continue

      for (const account of args.accounts) {
        const participant = match.info.participants.find((p) => p.puuid === account.puuid)
        if (!participant) continue
        summaries.push(buildMatchSummary(entry.matchId, match, participant, account))
      }
    }

    console.log(
      `[riot] listCachedMatches: ${entries.length} cached match(es) on disk -> ${summaries.length} playable by linked account(s)`
    )

    return summaries.sort((a, b) => b.gameEndTimestamp - a.gameEndTimestamp)
  })

  // Forces an immediate re-walk of match history so anything not yet cached
  // gets downloaded. Cheap to repeat -- already-cached matches are skipped
  // without a network request.
  ipcMain.handle('riot:downloadMatchData', () => {
    requestBackfillNow()
  })

  // Derives the full stats payload for the player page's stats panel from
  // locally cached data only. Never touches the network -- browsing your own
  // VODs must not consume Riot API budget (see matchStats.ts).
  ipcMain.handle('riot:getMatchStats', (_e, args: GetMatchStatsArgs) => {
    return getMatchStats(args)
  })

  // Match-wide action events (all 10 players) for the "where's the action"
  // curve, as opposed to the recording owner's own bookmark tags.
  ipcMain.handle('riot:getMatchActionTimeline', (_e, args: GetMatchStatsArgs) => {
    return getMatchActionTimeline(args)
  })

  // Per-match gold-diff-vs-lane-opponent series for many videos at once,
  // backing the library's comeback/lead-throw filter. Only worth calling
  // while that filter is actually in use (see Library.tsx) -- it reads and
  // parses cached match+timeline files per match, heavier than a DB query.
  ipcMain.handle('riot:getLeadSwingBulk', (_e, args: GetLeadSwingBulkArgs) => {
    return getLeadSwingBulk(args)
  })

  // Fetches match + timeline and extracts auto-tag events for the given player.
  // Also computes derived fields used by the library's filters/tiles: the
  // opposing laner (same teamPosition, other team), gold diff against them,
  // total CS, and a lightweight roster (both teams, items, KDA) for tile art.
  ipcMain.handle('riot:fetchMatchBundle', async (_e, args: FetchMatchBundleArgs) => {
    try {
      const region = matchRegionForPlatform(args.platform)
      const [match, timeline] = await Promise.all([
        getMatchCached(region, args.matchId),
        getMatchTimelineCached(region, args.matchId)
      ])

      const participant = match.info.participants.find((p) => p.puuid === args.puuid)
      if (!participant) {
        throw new Error('Player not found in this match.')
      }

      const events = extractPlayerEvents(timeline, participant.participantId, match.info)

      const enemyLaner = findEnemyLaner(match, participant)

      const cs = participant.totalMinionsKilled + participant.neutralMinionsKilled
      const enemyCs = enemyLaner
        ? enemyLaner.totalMinionsKilled + enemyLaner.neutralMinionsKilled
        : null
      const goldDiff = enemyLaner ? participant.goldEarned - enemyLaner.goldEarned : null

      const primaryKeystoneId = (p: ParticipantDto): number | null => {
        const primaryStyle = p.perks?.styles.find((s) => s.description === 'primaryStyle')
        return primaryStyle?.selections[0]?.perk ?? null
      }

      const toRosterEntry = (p: ParticipantDto) => ({
        puuid: p.puuid,
        championName: p.championName,
        teamPosition: p.teamPosition,
        isMe: p.puuid === args.puuid,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
        summoner1Id: p.summoner1Id,
        summoner2Id: p.summoner2Id,
        keystoneId: primaryKeystoneId(p),
        cs: p.totalMinionsKilled + p.neutralMinionsKilled,
        goldEarned: p.goldEarned
      })

      const rosterData: MatchRosterData = {
        allies: match.info.participants
          .filter((p) => p.teamId === participant.teamId)
          .map(toRosterEntry),
        enemies: match.info.participants
          .filter((p) => p.teamId !== participant.teamId)
          .map(toRosterEntry),
        gameDurationSeconds: match.info.gameDuration
      }

      return {
        match,
        participant,
        events,
        derived: {
          enemyChampionName: enemyLaner?.championName ?? null,
          cs,
          enemyCs,
          goldDiff,
          keystoneId: primaryKeystoneId(participant),
          rosterData,
          teamPosition: participant.teamPosition || participant.individualPosition || null,
          queueId: match.info.queueId ?? null
        }
      }
    } catch (err) {
      throw toClientError(err)
    }
  })
}
