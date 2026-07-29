import { describe, expect, it } from 'vitest'
import { describeGraphicsScheduling, interpretHwSchMode } from './graphicsScheduling'

/** Verbatim `reg query` output from the development machine, where HAGS is on. */
const ENABLED_OUTPUT = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers
    HwSchMode    REG_DWORD    0x2
`

const DISABLED_OUTPUT = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers
    HwSchMode    REG_DWORD    0x1
`

describe('interpretHwSchMode', () => {
  it('reads 0x2 as enabled', () => {
    expect(interpretHwSchMode(ENABLED_OUTPUT)).toBe('enabled')
  })

  it('reads 0x1 as disabled', () => {
    expect(interpretHwSchMode(DISABLED_OUTPUT)).toBe('disabled')
  })

  // A machine that predates the feature has no value at all, which is not a
  // problem and must not be reported as one.
  it('treats a missing value as unsupported', () => {
    expect(interpretHwSchMode(null)).toBe('unsupported')
  })

  it('treats unparseable output as unknown rather than guessing', () => {
    expect(interpretHwSchMode('ERROR: The system was unable to find...')).toBe('unknown')
    expect(interpretHwSchMode('')).toBe('unknown')
  })

  it('does not read an unexpected value as either state', () => {
    expect(interpretHwSchMode('    HwSchMode    REG_DWORD    0x0')).toBe('unknown')
  })
})

describe('describeGraphicsScheduling', () => {
  it('warns when it is enabled, and says what to do', () => {
    const report = describeGraphicsScheduling('enabled')
    expect(report.shouldWarn).toBe(true)
    expect(report.message).toContain('Windows Settings')
    expect(report.message).toContain('restart')
  })

  // LeagueVid detects this; it does not change it. The setting is machine-wide,
  // under HKLM, needs administrator rights and a reboot -- not something a
  // recording app should flip on someone's behalf.
  it('says it will not change the setting itself', () => {
    expect(describeGraphicsScheduling('enabled').message).toContain("won't change")
  })

  it('stays quiet in every other state', () => {
    for (const state of ['disabled', 'unsupported', 'unknown'] as const) {
      const report = describeGraphicsScheduling(state)
      expect(report.shouldWarn, state).toBe(false)
      expect(report.message, state).toBeNull()
    }
  })
})
