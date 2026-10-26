import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => 'C:\\Users\\Test\\AppData\\Roaming\\leaguevid') }
}))

const { executableFrom, applyDesktopAudioChoice } = await import('./obsBackend')

describe('desktop audio device selection', () => {
  const endpoint = '{0.0.0.00000000}.{realtek}'
  const desktop = { kind: 'wasapi-output' as const, source: endpoint, role: 'desktop' as const }
  function client() {
    return {
      audioDeviceOptions: vi.fn().mockResolvedValue([
        { name: 'Default', value: 'default' },
        { name: 'Speakers', value: '{0.0.0.00000000}.{other}' },
        { name: 'Speakers', value: endpoint }
      ]),
      setInputSettings: vi.fn().mockResolvedValue(undefined)
    }
  }

  it('uses the selected endpoint even when labels are identical', async () => {
    const obs = client()
    await applyDesktopAudioChoice(obs, desktop, 'Speakers')
    expect(obs.setInputSettings).toHaveBeenCalledWith('Desktop Audio', { device_id: endpoint })
  })

  it('warns and falls back when the selected output is unplugged', async () => {
    const obs = client()
    const warn = vi.fn()
    await applyDesktopAudioChoice(obs, { ...desktop, source: 'unplugged' }, 'Headphones', warn)
    expect(obs.setInputSettings).toHaveBeenCalledWith('Desktop Audio', { device_id: 'default' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Headphones'))
  })

  it('resets a stale endpoint and warns when enumeration fails', async () => {
    const obs = client()
    obs.audioDeviceOptions.mockRejectedValue(new Error('disconnected'))
    const warn = vi.fn()
    await applyDesktopAudioChoice(obs, desktop, 'Speakers', warn)
    expect(obs.setInputSettings).toHaveBeenCalledWith('Desktop Audio', { device_id: 'default' })
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the default dynamic rather than pinning today’s default endpoint', async () => {
    const obs = client()
    await applyDesktopAudioChoice(obs, { ...desktop, source: 'default' }, null)
    expect(obs.setInputSettings).not.toHaveBeenCalled()
  })

  it('resolves legacy Stereo Mix through the capture device list', async () => {
    const obs = client()
    obs.audioDeviceOptions.mockResolvedValue([{ name: 'Stereo Mix', value: 'capture-id' }])
    await applyDesktopAudioChoice(obs, { ...desktop, kind: 'dshow', source: 'Stereo Mix' }, null)
    expect(obs.setInputSettings).toHaveBeenCalledWith('Desktop Audio', { device_id: 'capture-id' })
  })
})

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
