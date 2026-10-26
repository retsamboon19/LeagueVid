import { describe, expect, it } from 'vitest'
import { parseOutputDevices } from './outputDevices'

describe('Windows output devices', () => {
  it('keeps endpoint IDs, duplicate labels, Unicode and the Windows default', () => {
    const devices = [
      { id: '{0.0.0.00000000}.{one}', name: 'Speakers (Realtek(R) Audio)', isDefault: true },
      { id: '{0.0.0.00000000}.{two}', name: 'Speakers (Realtek(R) Audio)', isDefault: false },
      { id: '{0.0.0.00000000}.{three}', name: '耳机', isDefault: false }
    ]
    expect(parseOutputDevices('\uFEFF' + JSON.stringify(devices))).toEqual(devices)
  })

  it('excludes capture endpoints and malformed entries', () => {
    expect(parseOutputDevices(JSON.stringify([
      { id: '{0.0.1.00000000}.{mic}', name: 'Microphone', isDefault: true },
      { id: 'default', name: 'Default', isDefault: true },
      null, { name: 'Incomplete' }
    ]))).toEqual([])
  })

  it('distinguishes an empty list from an enumeration failure', () => {
    expect(parseOutputDevices('[]')).toEqual([])
    expect(() => parseOutputDevices('Access denied')).toThrow()
    expect(() => parseOutputDevices('null')).toThrow()
  })
})
