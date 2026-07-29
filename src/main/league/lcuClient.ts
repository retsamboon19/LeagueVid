import { exec } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { request } from 'https'
import { join } from 'path'

// Best-effort client for the League *client* API (as opposed to the in-game
// one). Its only job here is to obtain the exact game id, which turns match
// linking from a search into a lookup.
//
// Every part of this is optional. If the lockfile has moved, if the client
// isn't running, if Riot renames an endpoint, the recorder carries on with
// Live Client Data alone and linking falls back to the existing filename-based
// search. Nothing in here may prevent or stop a recording -- a nicer match id
// is not worth a lost game.

/** Credentials for the local client API. */
export interface LcuCredentials {
  port: number
  /** Basic auth password; the username is always 'riot'. */
  password: string
  /** Where these came from, for diagnostics. */
  source: string
}

/**
 * Parses a League client lockfile.
 *
 * Format is five colon-separated fields:
 *   LeagueClient:12345:52847:AbCdEf0123:https
 *   name        :pid  :port :password  :protocol
 *
 * The password can itself contain characters that look like separators, so the
 * split is positional rather than greedy -- and the field count is checked
 * rather than assumed, because a half-written lockfile is a real state during
 * client startup.
 */
export function parseLockfile(contents: string): LcuCredentials | null {
  const parts = contents.trim().split(':')
  if (parts.length < 5) return null

  const port = Number.parseInt(parts[2], 10)
  const password = parts[3]
  if (!Number.isFinite(port) || port <= 0 || !password) return null

  return { port, password, source: 'lockfile' }
}

/**
 * Pulls credentials out of the client's command line.
 *
 * The last resort, used when no lockfile can be found: LeagueClientUx is
 * launched with --app-port and --remoting-auth-token, and those flags are
 * readable from the process list. Quoting varies -- Riot has shipped both
 * `--app-port=52847` and `--app-port="52847"` -- so both are accepted.
 */
export function extractCredentialsFromCommandLine(commandLine: string): LcuCredentials | null {
  const port = commandLine.match(/--app-port=["']?(\d+)["']?/)
  const token = commandLine.match(/--remoting-auth-token=["']?([\w-]+)["']?/)

  if (!port || !token) return null

  return {
    port: Number.parseInt(port[1], 10),
    password: token[1],
    source: 'process command line'
  }
}

/**
 * Composes a match-v5 match id from a platform and the client's game id.
 *
 * Match ids are 'PLATFORM_gameId' with the platform upper-cased -- 'EUW1_123',
 * not 'euw1_123' -- while LeagueVid stores platforms lower-cased for routing.
 * Getting the case wrong produces a 404 that looks exactly like "the match
 * isn't available yet", which is the kind of bug that costs an afternoon.
 */
export function composeMatchId(platform: string, gameId: number | string): string | null {
  const id = typeof gameId === 'string' ? Number.parseInt(gameId, 10) : gameId
  if (!platform || !Number.isFinite(id) || (id as number) <= 0) return null
  return `${platform.toUpperCase()}_${id}`
}

/**
 * Reads install locations from RiotClientInstalls.json.
 *
 * Riot writes this to a fixed location and it points at wherever the user
 * actually installed the game, which may be any drive.
 */
export function parseRiotClientInstalls(contents: string): string[] {
  try {
    const parsed = JSON.parse(contents) as Record<string, unknown>
    return Object.values(parsed)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.replace(/\\+/g, '\\'))
  } catch {
    return []
  }
}

/** Candidate lockfile locations, most likely first. */
export function candidateLockfilePaths(): string[] {
  const paths: string[] = []
  const localAppData = process.env.LOCALAPPDATA
  const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles

  // The default install, and the two other places installers commonly land.
  paths.push('C:\\Riot Games\\League of Legends\\lockfile')
  if (programFiles) {
    paths.push(join(programFiles, 'Riot Games', 'League of Legends', 'lockfile'))
  }

  // Wherever the user actually installed it.
  if (localAppData) {
    const installsFile = join(
      localAppData,
      'Riot Games',
      'Riot Client',
      'Config',
      'RiotClientInstalls.json'
    )
    if (existsSync(installsFile)) {
      try {
        for (const install of parseRiotClientInstalls(readFileSync(installsFile, 'utf8'))) {
          // Entries point at executables; the lockfile sits beside the game.
          const guess = install.replace(/\\[^\\]+\.exe$/i, '\\lockfile')
          if (guess !== install) paths.push(guess)
        }
      } catch {
        // Unreadable config is not worth reporting; the process fallback covers it.
      }
    }
  }

  return [...new Set(paths)]
}

/** Reads credentials from the first lockfile that exists and parses. */
export function findCredentialsFromLockfile(): LcuCredentials | null {
  for (const path of candidateLockfilePaths()) {
    if (!existsSync(path)) continue
    try {
      const parsed = parseLockfile(readFileSync(path, 'utf8'))
      if (parsed) return { ...parsed, source: `lockfile (${path})` }
    } catch {
      // The client rewrites this file on every launch, so a read can genuinely
      // catch it mid-write. Try the next candidate.
    }
  }
  return null
}

/** Asks Windows for the client's command line. Slow, so it's the last resort. */
export function findCredentialsFromProcessList(timeoutMs = 5000): Promise<LcuCredentials | null> {
  return new Promise((resolve) => {
    const command =
      'powershell -NoProfile -NonInteractive -Command ' +
      '"Get-CimInstance Win32_Process -Filter \\"Name=\'LeagueClientUx.exe\'\\" ' +
      '| Select-Object -ExpandProperty CommandLine"'

    exec(command, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error || !stdout) {
        resolve(null)
        return
      }
      resolve(extractCredentialsFromCommandLine(stdout))
    })
  })
}

export async function discoverLcuCredentials(): Promise<LcuCredentials | null> {
  return findCredentialsFromLockfile() ?? (await findCredentialsFromProcessList())
}

/** Gameflow phases relevant to recording. Riot's set is larger. */
export type GameflowPhase =
  | 'None'
  | 'Lobby'
  | 'Matchmaking'
  | 'ReadyCheck'
  | 'ChampSelect'
  | 'GameStart'
  | 'InProgress'
  | 'WaitingForStats'
  | 'PreEndOfGame'
  | 'EndOfGame'
  | string

export interface GameflowSession {
  phase: GameflowPhase
  gameId: number | null
  queueId: number | null
}

/** Extracts what's needed from /lol-gameflow/v1/session. */
export function extractGameflowSession(raw: unknown): GameflowSession | null {
  const data = raw as
    | { phase?: string; gameData?: { gameId?: number; queue?: { id?: number } } }
    | null
  if (!data || typeof data.phase !== 'string') return null

  const gameId = data.gameData?.gameId
  return {
    phase: data.phase,
    // The client reports gameId 0 before a game actually exists, which must not
    // be mistaken for a real id.
    gameId: typeof gameId === 'number' && gameId > 0 ? gameId : null,
    queueId: typeof data.gameData?.queue?.id === 'number' ? data.gameData.queue.id : null
  }
}

const LCU_TIMEOUT_MS = 2000

function lcuRequest<T>(
  credentials: LcuCredentials,
  path: string,
  timeoutMs = LCU_TIMEOUT_MS
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const req = request(
      {
        host: '127.0.0.1',
        port: credentials.port,
        path,
        method: 'GET',
        headers: {
          // Username is always 'riot'; the lockfile password is the secret.
          Authorization: `Basic ${Buffer.from(`riot:${credentials.password}`).toString('base64')}`
        },
        // The client's certificate is self-signed and local-only.
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
            finish(null)
            return
          }
          try {
            finish(JSON.parse(body) as T)
          } catch {
            finish(null)
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
    req.on('error', () => finish(null))
    req.end()
  })
}

export async function getGameflowPhase(credentials: LcuCredentials): Promise<GameflowPhase | null> {
  // This endpoint returns a bare JSON string, e.g. "InProgress".
  return lcuRequest<GameflowPhase>(credentials, '/lol-gameflow/v1/gameflow-phase')
}

export async function getGameflowSession(
  credentials: LcuCredentials
): Promise<GameflowSession | null> {
  const raw = await lcuRequest<unknown>(credentials, '/lol-gameflow/v1/session')
  return extractGameflowSession(raw)
}

export interface MatchHint {
  matchId: string | null
  queueId: number | null
  phase: GameflowPhase | null
  /** Why there's no hint, when there isn't one. */
  reason: string | null
}

/**
 * The whole point of this module: an exact match id for the game in progress.
 *
 * Returns a reason rather than throwing, at every step. A missing hint is a
 * normal outcome -- custom games, a client that isn't running, an endpoint that
 * changed -- and linking has a search-based fallback for exactly this.
 */
export async function fetchMatchHint(platform: string): Promise<MatchHint> {
  const credentials = await discoverLcuCredentials()
  if (!credentials) {
    return {
      matchId: null,
      queueId: null,
      phase: null,
      reason: 'The League client could not be found; recording will link by searching instead.'
    }
  }

  const session = await getGameflowSession(credentials)
  if (!session) {
    return {
      matchId: null,
      queueId: null,
      phase: null,
      reason: 'The League client did not report a game session.'
    }
  }

  if (session.gameId == null) {
    return {
      matchId: null,
      queueId: session.queueId,
      phase: session.phase,
      reason: `No game id yet (client phase: ${session.phase}).`
    }
  }

  return {
    matchId: composeMatchId(platform, session.gameId),
    queueId: session.queueId,
    phase: session.phase,
    reason: null
  }
}
