import { describe, expect, it } from 'vitest'
import { safeCaptureScope } from './captureConflicts'

const GAME = {
  kind: 'game' as const,
  window: 'League of Legends (TM) Client:RiotWindowClass:League of Legends.exe'
}

describe('safeCaptureScope', () => {
  it('keeps game capture when no conflicting hook is running', () => {
    expect(safeCaptureScope(GAME, ['League of Legends.exe', 'LeagueVid.exe'])).toEqual({
      scope: GAME,
      conflicts: []
    })
  })

  it.each(['RTSS.exe', 'RTSSHooksLoader64.exe', 'MSIAfterburner.exe'])(
    'uses display capture when %s is running',
    (processName) => {
      const result = safeCaptureScope(GAME, [processName])

      expect(result.scope).toEqual({ kind: 'display' })
      expect(result.conflicts).toHaveLength(1)
    }
  )

  it('matches process names case-insensitively and de-duplicates product names', () => {
    const result = safeCaptureScope(GAME, ['rtss.EXE', 'RTSSHooksLoader64.exe'])

    expect(result).toEqual({
      scope: { kind: 'display' },
      conflicts: ['RivaTuner Statistics Server']
    })
  })

  it('does not change an explicitly requested display capture', () => {
    const display = { kind: 'display' as const }

    expect(safeCaptureScope(display, ['RTSS.exe'])).toEqual({
      scope: display,
      conflicts: []
    })
  })
})
