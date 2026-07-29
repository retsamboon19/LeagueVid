import { request } from 'https'

// Client for League's in-game HTTP API.
//
// The endpoint only exists while a game is actually running, which is what
// makes it a better start signal than watching for a process: League.exe is up
// during champion select and loading screens, but /liveclientdata only answers
// once the game itself is live.
//
// It serves a self-signed certificate (Riot's own, for 127.0.0.1), so
// certificate verification has to be off. That is safe here in a way it would
// not be generally: the connection is to loopback, and nothing outside this
// machine can answer it.

export const LIVE_CLIENT_BASE = 'https://127.0.0.1:2999'
const ALL_GAME_DATA_PATH = '/liveclientdata/allgamedata'

/** Shorter than the poll interval, so a slow reply can't stack requests. */
export const LIVE_CLIENT_TIMEOUT_MS = 1500

export interface LiveEvent {
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
  Recipient?: string
  KillStreak?: number
  Acer?: string
  AcingTeam?: string
}

/** What the recorder needs from a poll. */
export interface GameSnapshot {
  /** Seconds since the in-game clock started. */
  gameTime: number
  gameMode: string | null
  /** 11 = Summoner's Rift, 12 = Howling Abyss. */
  mapNumber: number | null
  /** The champion the local player is on, when it can be determined. */
  championName: string | null
  /** Riot ID or summoner name of the local player. */
  activePlayerName: string | null
  events: LiveEvent[]
  /** Wall clock when this sample was taken, for game-start anchoring. */
  sampledAt: number
}

interface AllGameDataResponse {
  activePlayer?: { summonerName?: string; riotId?: string; riotIdGameName?: string }
  allPlayers?: Array<{
    championName?: string
    summonerName?: string
    riotId?: string
    riotIdGameName?: string
  }>
  events?: { Events?: LiveEvent[] }
  gameData?: { gameMode?: string; gameTime?: number; mapNumber?: number; mapName?: string }
}

/**
 * Extracts what matters from the raw payload.
 *
 * Pure, and tolerant: Riot changes field names between patches (riotId,
 * riotIdGameName and summonerName have all been the canonical identifier at
 * some point), and a missing field must degrade rather than throw. Returning
 * null for the champion is fine -- it only affects the file name -- but
 * gameTime is required, because without it there is no clock to anchor to.
 */
export function extractGameSnapshot(raw: unknown, sampledAt: number): GameSnapshot | null {
  const data = raw as AllGameDataResponse | null
  const gameTime = data?.gameData?.gameTime

  // A game that reports no clock is not a game worth recording against.
  if (typeof gameTime !== 'number' || !Number.isFinite(gameTime)) return null

  const activePlayerName =
    data?.activePlayer?.riotId ??
    data?.activePlayer?.riotIdGameName ??
    data?.activePlayer?.summonerName ??
    null

  return {
    gameTime,
    gameMode: data?.gameData?.gameMode ?? null,
    mapNumber: typeof data?.gameData?.mapNumber === 'number' ? data.gameData.mapNumber : null,
    championName: findActiveChampion(data, activePlayerName),
    activePlayerName,
    events: Array.isArray(data?.events?.Events) ? (data?.events?.Events as LiveEvent[]) : [],
    sampledAt
  }
}

function findActiveChampion(
  data: AllGameDataResponse | null,
  activePlayerName: string | null
): string | null {
  if (!data?.allPlayers || !activePlayerName) return null

  const match = data.allPlayers.find((player) => {
    const candidates = [player.riotId, player.riotIdGameName, player.summonerName]
    if (candidates.includes(activePlayerName)) return true
    // 'Name#TAG' from one field against a bare 'Name' from another.
    const bare = activePlayerName.split('#')[0]
    return candidates.some((candidate) => candidate && candidate.split('#')[0] === bare)
  })

  return match?.championName ?? null
}

/**
 * The wall-clock time at which the in-game clock read zero, per this sample.
 *
 * Each sample carries request latency and polling jitter, so a single estimate
 * is never trusted -- see medianGameStart.
 */
export function estimateGameStart(snapshot: GameSnapshot): number {
  return snapshot.sampledAt - snapshot.gameTime * 1000
}

/**
 * The median of per-sample estimates.
 *
 * Median rather than mean because the error is one-sided: a reply can be late,
 * never early. A mean would be dragged upward by every slow response, and the
 * result is what every bookmark on the recording is positioned against -- a
 * second of drift here moves every marker by a second.
 */
export function medianGameStart(snapshots: GameSnapshot[]): number | null {
  if (snapshots.length === 0) return null

  const estimates = snapshots.map(estimateGameStart).sort((a, b) => a - b)
  const middle = Math.floor(estimates.length / 2)

  return estimates.length % 2 === 1
    ? estimates[middle]
    : Math.round((estimates[middle - 1] + estimates[middle]) / 2)
}

export interface PollResult {
  ok: boolean
  snapshot: GameSnapshot | null
  /** Why the poll failed: connection refused, timeout, bad payload. */
  reason: string | null
}

/** One request. Never throws: a failure is a result the watcher acts on. */
export function pollAllGameData(timeoutMs = LIVE_CLIENT_TIMEOUT_MS): Promise<PollResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: PollResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const req = request(
      {
        host: '127.0.0.1',
        port: 2999,
        path: ALL_GAME_DATA_PATH,
        method: 'GET',
        // Riot's local certificate is self-signed. The connection is to
        // loopback, so nothing off this machine can be on the other end.
        rejectUnauthorized: false,
        timeout: timeoutMs
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += String(chunk)
        })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            finish({ ok: false, snapshot: null, reason: `HTTP ${res.statusCode}` })
            return
          }
          try {
            const snapshot = extractGameSnapshot(JSON.parse(body), Date.now())
            finish(
              snapshot
                ? { ok: true, snapshot, reason: null }
                : { ok: false, snapshot: null, reason: 'No game clock in the response' }
            )
          } catch (err) {
            finish({ ok: false, snapshot: null, reason: (err as Error).message })
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      finish({ ok: false, snapshot: null, reason: `Timed out after ${timeoutMs}ms` })
    })
    // ECONNREFUSED is the normal case: no game is running.
    req.on('error', (err) => finish({ ok: false, snapshot: null, reason: err.message }))
    req.end()
  })
}
