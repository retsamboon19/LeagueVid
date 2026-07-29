import type { CaptureDisplay } from '../../shared/types'

export type { CaptureDisplay }

// Maps the monitors Windows reports onto the output index ddagrab captures by.
//
// The mapping is a best guess, and deliberately labelled as one. ddagrab's
// output_idx enumerates the DXGI outputs of one adapter, in the adapter's own
// order; Electron's display list is a different enumeration entirely, and on a
// multi-GPU laptop the two can disagree about which physical screen an index
// refers to. There is no API that joins them reliably.
//
// So: order by physical arrangement (which is what DXGI order usually follows),
// present the guess as a picker with resolutions attached, and let the preflight
// test confirm it. A wrong guess costs the user one click, where an automatic
// choice with no picker would cost them a whole recording of the wrong screen.

/** Plain shape of what's needed from Electron's Display, kept injectable. */
export interface DisplayInfo {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  size: { width: number; height: number }
  scaleFactor: number
  internal?: boolean
  label?: string
  rotation?: number
}

/**
 * Sorted left-to-right, then top-to-bottom, and indexed from there.
 *
 * Windows numbers displays roughly by arrangement and DXGI usually enumerates
 * them the same way, so position is the best available proxy. The primary
 * display is not forced to index 0: DXGI order does not care which display is
 * primary, and pretending otherwise would break the common case of a primary
 * monitor sitting to the right of a secondary one.
 */
export function mapDisplaysToOutputs(
  displays: DisplayInfo[],
  primaryId: number
): CaptureDisplay[] {
  const ordered = [...displays].sort((a, b) => {
    if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x
    return a.bounds.y - b.bounds.y
  })

  return ordered.map((display, index) => {
    // bounds are in DIPs; ddagrab captures physical pixels, so a 150%-scaled
    // 2560x1440 monitor reports bounds of 1707x960 and must still be treated
    // as 2560x1440 for capture and scaling decisions.
    const width = Math.round(display.bounds.width * display.scaleFactor)
    const height = Math.round(display.bounds.height * display.scaleFactor)
    const isPrimary = display.id === primaryId

    return {
      id: display.id,
      outputIdx: index,
      width,
      height,
      scaleFactor: display.scaleFactor,
      isPrimary,
      label: buildLabel(display, index, width, height, isPrimary)
    }
  })
}

function buildLabel(
  display: DisplayInfo,
  index: number,
  width: number,
  height: number,
  isPrimary: boolean
): string {
  const name = display.label?.trim() || `Display ${index + 1}`
  const parts = [`${width}x${height}`]
  if (isPrimary) parts.push('primary')
  if (display.internal) parts.push('built-in')
  return `${name} (${parts.join(', ')})`
}

/**
 * Resolves the configured display to something capturable.
 *
 * A monitor that has been unplugged since the setting was saved must not stop
 * a recording: falling back to the primary display and saying so is better than
 * refusing to record the game that is already starting.
 */
export interface DisplayResolution {
  display: CaptureDisplay
  /** Set when the configured display was unavailable. */
  substitutedFor: number | null
}

export function resolveCaptureDisplay(
  displays: CaptureDisplay[],
  configuredId: number | null
): DisplayResolution | null {
  if (displays.length === 0) return null

  if (configuredId != null) {
    const match = displays.find((d) => d.id === configuredId)
    if (match) return { display: match, substitutedFor: null }
  }

  const primary = displays.find((d) => d.isPrimary) ?? displays[0]
  return {
    display: primary,
    // Only a substitution if something specific was asked for and missed.
    substitutedFor: configuredId != null ? configuredId : null
  }
}
