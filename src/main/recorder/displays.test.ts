import { describe, expect, it } from 'vitest'
import {
  mapDisplaysToOutputs,
  resolveCaptureDisplay,
  type DisplayInfo
} from './displays'

function display(overrides: Partial<DisplayInfo> & { id: number }): DisplayInfo {
  return {
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    size: { width: 2560, height: 1440 },
    scaleFactor: 1,
    ...overrides
  }
}

describe('mapDisplaysToOutputs', () => {
  it('indexes a single display as output 0', () => {
    const mapped = mapDisplaysToOutputs([display({ id: 11 })], 11)
    expect(mapped).toHaveLength(1)
    expect(mapped[0].outputIdx).toBe(0)
    expect(mapped[0].isPrimary).toBe(true)
    expect(mapped[0].label).toBe('Display 1 (2560x1440, primary)')
  })

  it('orders displays left to right', () => {
    const mapped = mapDisplaysToOutputs(
      [
        display({ id: 2, bounds: { x: 2560, y: 0, width: 1920, height: 1080 } }),
        display({ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } })
      ],
      1
    )
    expect(mapped.map((d) => d.id)).toEqual([1, 2])
    expect(mapped.map((d) => d.outputIdx)).toEqual([0, 1])
  })

  it('orders a stacked pair top to bottom', () => {
    const mapped = mapDisplaysToOutputs(
      [
        display({ id: 2, bounds: { x: 0, y: 1440, width: 2560, height: 1440 } }),
        display({ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } })
      ],
      1
    )
    expect(mapped.map((d) => d.id)).toEqual([1, 2])
  })

  // DXGI order has nothing to do with which display Windows calls primary, so
  // forcing the primary to index 0 would mis-map the common arrangement of a
  // primary monitor sitting to the right of a secondary one.
  it('does not force the primary display to index 0', () => {
    const mapped = mapDisplaysToOutputs(
      [
        display({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
        display({ id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } })
      ],
      2
    )
    const primary = mapped.find((d) => d.isPrimary)
    expect(primary?.id).toBe(2)
    expect(primary?.outputIdx).toBe(1)
  })

  // Electron reports bounds in device-independent pixels; ddagrab captures
  // physical pixels. Trusting the DIP size would record a 150%-scaled 1440p
  // monitor as if it were 1707x960, and every scaling decision downstream
  // would be made against the wrong number.
  it('converts scaled bounds back to physical pixels', () => {
    const mapped = mapDisplaysToOutputs(
      [
        display({
          id: 1,
          bounds: { x: 0, y: 0, width: 1707, height: 960 },
          scaleFactor: 1.5
        })
      ],
      1
    )
    expect(mapped[0].width).toBe(2561)
    expect(mapped[0].height).toBe(1440)
  })

  it('uses the reported label when there is one', () => {
    const mapped = mapDisplaysToOutputs([display({ id: 1, label: 'DELL U2720Q' })], 1)
    expect(mapped[0].label).toBe('DELL U2720Q (2560x1440, primary)')
  })

  it('marks a built-in panel', () => {
    const mapped = mapDisplaysToOutputs(
      [display({ id: 1, internal: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })],
      1
    )
    expect(mapped[0].label).toContain('built-in')
  })

  it('handles no displays at all', () => {
    expect(mapDisplaysToOutputs([], 0)).toEqual([])
  })
})

describe('resolveCaptureDisplay', () => {
  const displays = mapDisplaysToOutputs(
    [
      display({ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }),
      display({ id: 2, bounds: { x: 2560, y: 0, width: 1920, height: 1080 } })
    ],
    1
  )

  it('returns the configured display when it is present', () => {
    const resolved = resolveCaptureDisplay(displays, 2)
    expect(resolved?.display.id).toBe(2)
    expect(resolved?.substitutedFor).toBeNull()
  })

  it('uses the primary display when nothing is configured', () => {
    const resolved = resolveCaptureDisplay(displays, null)
    expect(resolved?.display.id).toBe(1)
    expect(resolved?.substitutedFor).toBeNull()
  })

  // A monitor unplugged since the setting was saved must not stop a recording:
  // the game is already starting, and the primary display is a better answer
  // than no recording at all.
  it('falls back to primary and reports the substitution', () => {
    const resolved = resolveCaptureDisplay(displays, 99)
    expect(resolved?.display.id).toBe(1)
    expect(resolved?.substitutedFor).toBe(99)
  })

  it('returns null when there are no displays', () => {
    expect(resolveCaptureDisplay([], null)).toBeNull()
  })
})
