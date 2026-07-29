import { describe, expect, it } from 'vitest'
import {
  composeMatchId,
  extractCredentialsFromCommandLine,
  extractGameflowSession,
  parseLockfile,
  parseRiotClientInstalls
} from './lcuClient'

describe('parseLockfile', () => {
  it('reads port and password from a real lockfile line', () => {
    const parsed = parseLockfile('LeagueClient:23044:52847:mBnUw0hRtLPX9YrTqZ2Ktg:https')
    expect(parsed).toEqual({ port: 52847, password: 'mBnUw0hRtLPX9YrTqZ2Ktg', source: 'lockfile' })
  })

  it('tolerates a trailing newline', () => {
    expect(parseLockfile('LeagueClient:1:2:pw:https\n')?.port).toBe(2)
  })

  // The client rewrites this file on every launch, so reading it mid-write is a
  // real state rather than a theoretical one. A short read must be rejected,
  // not parsed into a nonsense port.
  it('rejects a half-written lockfile', () => {
    expect(parseLockfile('LeagueClient:23044')).toBeNull()
    expect(parseLockfile('')).toBeNull()
    expect(parseLockfile('LeagueClient:1:2:3')).toBeNull()
  })

  it('rejects a lockfile with no usable port', () => {
    expect(parseLockfile('LeagueClient:23044::password:https')).toBeNull()
    expect(parseLockfile('LeagueClient:23044:abc:password:https')).toBeNull()
  })

  it('rejects a lockfile with no password', () => {
    expect(parseLockfile('LeagueClient:23044:52847::https')).toBeNull()
  })
})

describe('extractCredentialsFromCommandLine', () => {
  const commandLine =
    '"C:\\Riot Games\\League of Legends\\LeagueClientUx.exe" ' +
    '--riotclient-auth-token=abc --riotclient-app-port=51234 ' +
    '--remoting-auth-token=xY9-zAbCdEfGh --app-port=52847 --install-directory=...'

  it('finds the port and token', () => {
    expect(extractCredentialsFromCommandLine(commandLine)).toEqual({
      port: 52847,
      password: 'xY9-zAbCdEfGh',
      source: 'process command line'
    })
  })

  // Riot has shipped both quoted and unquoted forms of these flags.
  it('accepts quoted values', () => {
    const quoted = '--remoting-auth-token="tok-en_1" --app-port="52847"'
    expect(extractCredentialsFromCommandLine(quoted)?.port).toBe(52847)
    expect(extractCredentialsFromCommandLine(quoted)?.password).toBe('tok-en_1')
  })

  // --riotclient-app-port belongs to a different service; picking it up would
  // authenticate against the wrong API and fail confusingly.
  it('does not mistake the riotclient port for the league client port', () => {
    expect(extractCredentialsFromCommandLine(commandLine)?.port).toBe(52847)
  })

  it('returns null when either flag is missing', () => {
    expect(extractCredentialsFromCommandLine('--app-port=52847')).toBeNull()
    expect(extractCredentialsFromCommandLine('--remoting-auth-token=abc')).toBeNull()
    expect(extractCredentialsFromCommandLine('')).toBeNull()
  })
})

describe('composeMatchId', () => {
  // Match-v5 ids are upper-cased platform + underscore + game id, while
  // LeagueVid stores platforms lower-cased for routing. The wrong case gives a
  // 404 that reads exactly like "the match isn't published yet".
  it('upper-cases the platform', () => {
    expect(composeMatchId('euw1', 6543210987)).toBe('EUW1_6543210987')
    expect(composeMatchId('na1', 1234567890)).toBe('NA1_1234567890')
  })

  it('accepts a game id that arrived as a string', () => {
    expect(composeMatchId('kr', '7412345678')).toBe('KR_7412345678')
  })

  // The client reports gameId 0 before a game exists.
  it('refuses a zero or negative game id', () => {
    expect(composeMatchId('euw1', 0)).toBeNull()
    expect(composeMatchId('euw1', -1)).toBeNull()
  })

  it('refuses a missing platform or unparseable id', () => {
    expect(composeMatchId('', 123)).toBeNull()
    expect(composeMatchId('euw1', 'soon')).toBeNull()
  })
})

describe('extractGameflowSession', () => {
  it('reads phase, game id and queue', () => {
    const session = extractGameflowSession({
      phase: 'InProgress',
      gameData: { gameId: 6543210987, queue: { id: 420 } }
    })
    expect(session).toEqual({ phase: 'InProgress', gameId: 6543210987, queueId: 420 })
  })

  // Before a game actually exists the client reports gameId 0, which must not
  // be composed into a match id.
  it('treats gameId 0 as no game id', () => {
    const session = extractGameflowSession({
      phase: 'ChampSelect',
      gameData: { gameId: 0, queue: { id: 420 } }
    })
    expect(session?.gameId).toBeNull()
    expect(session?.phase).toBe('ChampSelect')
  })

  it('survives a session with no gameData at all', () => {
    const session = extractGameflowSession({ phase: 'Lobby' })
    expect(session).toEqual({ phase: 'Lobby', gameId: null, queueId: null })
  })

  it('returns null for a response with no phase', () => {
    expect(extractGameflowSession({})).toBeNull()
    expect(extractGameflowSession(null)).toBeNull()
    expect(extractGameflowSession('nope')).toBeNull()
  })
})

describe('parseRiotClientInstalls', () => {
  it('collects every install path', () => {
    const contents = JSON.stringify({
      rc_default: 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
      rc_live: 'D:\\Games\\Riot Games\\Riot Client\\RiotClientServices.exe',
      associated_client: { 'C:\\Riot Games\\League of Legends\\': 'C:\\Riot Games\\Riot Client\\' }
    })
    const paths = parseRiotClientInstalls(contents)
    expect(paths).toContain('C:\\Riot Games\\Riot Client\\RiotClientServices.exe')
    expect(paths).toContain('D:\\Games\\Riot Games\\Riot Client\\RiotClientServices.exe')
  })

  it('ignores non-string entries rather than choking on them', () => {
    const paths = parseRiotClientInstalls(JSON.stringify({ a: 1, b: null, c: 'C:\\x.exe' }))
    expect(paths).toEqual(['C:\\x.exe'])
  })

  it('returns nothing for unparseable input', () => {
    expect(parseRiotClientInstalls('{ not json')).toEqual([])
    expect(parseRiotClientInstalls('')).toEqual([])
  })
})
