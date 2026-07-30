import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => 'C:\\Users\\Test\\AppData\\Roaming\\leaguevid') }
}))

const { executableFrom } = await import('./obsBackend')

// Attachment is decided by comparing executables out of OBS's window strings, so
// this parse is what stands between "the game is not running" and a false alarm
// during a game.

describe('executableFrom', () => {
  it('takes the executable out of a title:class:executable triple', () => {
    expect(executableFrom('League of Legends (TM) Client:RiotWindowClass:League of Legends.exe')).toBe(
      'League of Legends.exe'
    )
  })

  // The reason this splits from the right. OBS's enumeration on this machine
  // included a window whose *title* was a path -- splitting from the left would
  // have returned 'C' and matched nothing.
  it('survives a window title that contains colons', () => {
    expect(executableFrom('C:\\WINDOWS\\system32\\cmd.exe:CASCADIA_HOSTING_WINDOW_CLASS:WindowsTerminal.exe')).toBe(
      'WindowsTerminal.exe'
    )
  })

  it('handles a bare executable', () => {
    expect(executableFrom('obs64.exe')).toBe('obs64.exe')
  })

  it('does not throw on an empty string', () => {
    expect(executableFrom('')).toBe('')
  })

  // Match is case-insensitive at the call site, but the parse must not mangle
  // case on the way there.
  it('preserves the name as given', () => {
    expect(executableFrom('a:b:League Of Legends.exe')).toBe('League Of Legends.exe')
  })
})
