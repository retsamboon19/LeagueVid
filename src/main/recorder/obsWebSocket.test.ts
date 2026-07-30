import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { ObsRequestError, REQUEST_STATUS_NOT_READY, authenticationString } from './obsWebSocket'

// The auth string has its own test because getting it wrong produces a socket
// that opens and is then closed by the server -- which reads as "OBS is not
// running" and sends you looking in entirely the wrong place.

describe('authenticationString', () => {
  it('is base64(sha256(base64(sha256(password + salt)) + challenge))', () => {
    const password = 'hunter2'
    const salt = 'saltysalt'
    const challenge = 'chall'

    const secret = createHash('sha256').update(password + salt).digest('base64')
    const expected = createHash('sha256').update(secret + challenge).digest('base64')

    expect(authenticationString(password, salt, challenge)).toBe(expected)
  })

  it('changes with the challenge, so a captured string cannot be replayed', () => {
    const first = authenticationString('pw', 'salt', 'challenge-one')
    const second = authenticationString('pw', 'salt', 'challenge-two')
    expect(first).not.toBe(second)
  })

  it('changes with the password', () => {
    expect(authenticationString('a', 'salt', 'c')).not.toBe(
      authenticationString('b', 'salt', 'c')
    )
  })

  it('is deterministic for the same inputs', () => {
    expect(authenticationString('pw', 'salt', 'c')).toBe(authenticationString('pw', 'salt', 'c'))
  })

  it('produces base64, which is what obs-websocket expects', () => {
    expect(authenticationString('pw', 'salt', 'c')).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})

describe('ObsRequestError', () => {
  // NotReady is distinguished by code rather than message text because it is the
  // one failure that resolves itself with time. Retrying anything else -- a bad
  // password, an unknown request -- would turn an actionable error into a hang.
  it('carries the status code so NotReady can be told apart', () => {
    const error = new ObsRequestError('not ready', REQUEST_STATUS_NOT_READY)
    expect(error.code).toBe(REQUEST_STATUS_NOT_READY)
    expect(error).toBeInstanceOf(Error)
  })

  it('is identifiable by instanceof after being thrown', () => {
    try {
      throw new ObsRequestError('boom', 204)
    } catch (err) {
      expect(err instanceof ObsRequestError).toBe(true)
      expect((err as ObsRequestError).code).toBe(204)
    }
  })
})
