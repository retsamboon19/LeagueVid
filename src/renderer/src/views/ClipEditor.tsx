import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Scissors, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { TagRow, VideoRow } from '../../../shared/types'
import { buildActionDensity, densityAreaPath, type DensityEvent } from '../lib/actionDensity'

interface ClipEditorProps {
  video: VideoRow
  tags: TagRow[]
  /** Match-wide action events (all 10 players), already shifted into video
   * time so they line up with the bookmark ticks and clip handles below. */
  actionEvents: DensityEvent[]
  /** Full length of the recording. */
  durationMs: number
  /** Where playback currently is, used as the initial clip centre. */
  currentTimeMs: number
  /** Lets the editor scrub the underlying video while dragging handles. */
  onPreviewSeek: (ms: number) => void
  onClose: () => void
}

// 'select' moves BOTH ends together (dragging the highlighted region itself)
// rather than resizing from one end -- this is what makes "grab the whole
// clip and slide it along the timeline" possible, which the two resize
// handles alone don't offer.
// 'new-selection' is a drag started on the empty track OUTSIDE the current
// clip -- clicking before or after the existing selection and dragging
// redefines the clip's range from scratch (anchored at the mousedown point),
// rather than requiring the user to first drag an end handle all the way
// over to where they clicked.
type Handle = 'start' | 'end' | 'select' | 'new-selection' | null

const DEFAULT_CLIP_MS = 20_000
const MIN_CLIP_MS = 1_000
const ZOOM_LEVELS_MS = [10_000, 20_000, 40_000, 90_000, 180_000, 360_000, 900_000]

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function formatDurationLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function ClipEditor({
  video,
  tags,
  actionEvents,
  durationMs,
  currentTimeMs,
  onPreviewSeek,
  onClose
}: ClipEditorProps): JSX.Element {
  // Clip bounds start centred on wherever playback was when the editor opened,
  // clamped into the recording.
  const [startMs, setStartMs] = useState(() =>
    Math.max(0, Math.min(currentTimeMs - DEFAULT_CLIP_MS / 2, Math.max(0, durationMs - DEFAULT_CLIP_MS)))
  )
  const [endMs, setEndMs] = useState(() =>
    Math.min(durationMs, Math.max(currentTimeMs + DEFAULT_CLIP_MS / 2, DEFAULT_CLIP_MS))
  )

  const [zoomIndex, setZoomIndex] = useState(1)
  const [viewCenterMs, setViewCenterMs] = useState(currentTimeMs)
  const [dragging, setDragging] = useState<Handle>(null)
  // Captured at the moment a whole-selection drag starts: the clip's
  // duration (kept fixed while dragging) and the offset between the click
  // point and the clip's start, so the clip doesn't jump to be centred under
  // the cursor the instant the drag begins.
  const dragOffsetRef = useRef<{ clipDurationMs: number; grabOffsetMs: number } | null>(null)
  // Anchor point for a fresh drag-to-select on the empty track: whichever
  // end the mouse is on the opposite side of moves; the anchor side stays put.
  const newSelectionAnchorRef = useRef<number | null>(null)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'fast' | 'exact'>('fast')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ outputPath: string; sizeBytes: number } | null>(null)
  const [clipsDir, setClipsDir] = useState<string | null>(null)

  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.video.getClipsDir().then(setClipsDir)
  }, [])

  // Visible slice of the recording. Zooming keeps the clip in view by centring
  // the window on it, which is what makes fine adjustment practical on a long
  // game -- dragging a handle across a 40-minute track is hopeless otherwise.
  const spanMs = Math.min(ZOOM_LEVELS_MS[zoomIndex], Math.max(durationMs, MIN_CLIP_MS))
  const viewStartMs = Math.max(0, Math.min(viewCenterMs - spanMs / 2, Math.max(0, durationMs - spanMs)))
  const viewEndMs = Math.min(durationMs, viewStartMs + spanMs)
  const viewSpanMs = Math.max(1, viewEndMs - viewStartMs)

  const toRatio = useCallback(
    (ms: number) => (ms - viewStartMs) / viewSpanMs,
    [viewStartMs, viewSpanMs]
  )

  const fromClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return viewStartMs
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return viewStartMs + ratio * viewSpanMs
    },
    [viewStartMs, viewSpanMs]
  )

  // Density over the visible window only, so zooming in reveals detail rather
  // than showing the same whole-game shape squeezed into the same box. Built
  // from match-wide action events (every player), not just this video's own
  // bookmarks -- a teamfight the recording owner wasn't part of should still
  // show up as a spike when picking clip boundaries.
  const density = useMemo(() => {
    const windowEvents = actionEvents.filter(
      (e) => e.timestampMs >= viewStartMs - 10_000 && e.timestampMs <= viewEndMs + 10_000
    )
    const shifted = windowEvents.map((e) => ({ ...e, timestampMs: e.timestampMs - viewStartMs }))
    return buildActionDensity(shifted, viewSpanMs, 200)
  }, [actionEvents, viewStartMs, viewEndMs, viewSpanMs])

  const densityPath = useMemo(() => densityAreaPath(density, 1000, 40), [density])

  // Scroll wheel pans the visible window without touching the zoom level or
  // the clip selection -- the selection's own timestamps don't change, it
  // just scrolls in or out of view along with everything else. Scrolling
  // down (positive deltaY) moves forward in time, matching how scrolling
  // down a page moves further down the page; scrolling up moves backward.
  //
  // Attached as a native listener with passive:false rather than React's
  // onWheel: React attaches wheel/touch handlers as passive by default (a
  // browser performance optimization), which means preventDefault() inside
  // an onWheel prop silently does nothing -- the page/container would still
  // scroll underneath the pan. A manual, non-passive listener is the only
  // way to actually suppress that.
  useEffect(() => {
    const el = trackRef.current
    if (!el) return

    // A fixed fraction of the current span per notch, not a fixed ms amount:
    // panning a 15-minute view by a flat 1-second step would feel glacial,
    // while that same step on a zoomed-in 10-second view would overshoot the
    // whole window in one scroll.
    const PAN_FRACTION_PER_NOTCH = 0.12

    function handleWheel(e: WheelEvent): void {
      e.preventDefault()
      const deltaMs = Math.sign(e.deltaY) * spanMs * PAN_FRACTION_PER_NOTCH
      setViewCenterMs((prev) => Math.max(0, Math.min(prev + deltaMs, durationMs)))
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [spanMs, durationMs])

  // Handle dragging is tracked on the window so the pointer can leave the
  // track mid-drag without the handle sticking.
  useEffect(() => {
    if (!dragging) return

    function onMove(e: MouseEvent): void {
      const ms = fromClientX(e.clientX)

      if (dragging === 'start') {
        const next = Math.min(ms, endMs - MIN_CLIP_MS)
        setStartMs(Math.max(0, next))
        onPreviewSeek(Math.max(0, next))
        return
      }

      if (dragging === 'end') {
        const next = Math.max(ms, startMs + MIN_CLIP_MS)
        setEndMs(Math.min(durationMs, next))
        onPreviewSeek(Math.min(durationMs, next))
        return
      }

      if (dragging === 'select') {
        // Slide the whole clip, keeping its length constant. Clamped so the
        // far edge can't run past 0 or the end of the recording.
        const drag = dragOffsetRef.current
        if (!drag) return
        const rawStart = ms - drag.grabOffsetMs
        const nextStart = Math.max(0, Math.min(rawStart, durationMs - drag.clipDurationMs))
        setStartMs(nextStart)
        setEndMs(nextStart + drag.clipDurationMs)
        onPreviewSeek(nextStart)
        return
      }

      // 'new-selection': the mousedown point is the anchor and stays fixed;
      // the current mouse position becomes the other edge. Dragging left of
      // the anchor puts the anchor on the right instead of collapsing to
      // nothing, so the direction you drag doesn't matter.
      const anchor = newSelectionAnchorRef.current
      if (anchor === null) return
      const lo = Math.max(0, Math.min(anchor, ms))
      const hi = Math.min(durationMs, Math.max(anchor, ms))
      setStartMs(lo)
      setEndMs(Math.max(hi, lo + MIN_CLIP_MS))
      onPreviewSeek(ms < anchor ? lo : hi)
    }

    function onUp(): void {
      setDragging(null)
      dragOffsetRef.current = null
      newSelectionAnchorRef.current = null
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, startMs, endMs, durationMs, fromClientX, onPreviewSeek])

  function handleSelectionMouseDown(e: React.MouseEvent): void {
    // Stops the track's own onMouseDown (drag-to-select) from also firing
    // for a click that landed on the selection itself.
    e.stopPropagation()
    const grabMs = fromClientX(e.clientX)
    dragOffsetRef.current = { clipDurationMs: endMs - startMs, grabOffsetMs: grabMs - startMs }
    setDragging('select')
  }

  // Starting a drag on the track background -- i.e. anywhere that isn't the
  // selection or a handle, since those stop this event via
  // stopPropagation/their own onMouseDown -- begins a brand new selection
  // anchored at the click point. This is what lets clicking before or after
  // the current clip immediately start defining a new range, instead of
  // requiring the handles to be dragged all the way across first.
  function handleTrackMouseDown(e: React.MouseEvent): void {
    const ms = fromClientX(e.clientX)
    newSelectionAnchorRef.current = ms
    setStartMs(ms)
    setEndMs(Math.min(durationMs, ms + MIN_CLIP_MS))
    onPreviewSeek(ms)
    setDragging('new-selection')
  }

  function nudge(which: 'start' | 'end', deltaMs: number): void {
    if (which === 'start') {
      setStartMs((prev) => Math.max(0, Math.min(prev + deltaMs, endMs - MIN_CLIP_MS)))
    } else {
      setEndMs((prev) => Math.min(durationMs, Math.max(prev + deltaMs, startMs + MIN_CLIP_MS)))
    }
  }

  const clipDurationMs = endMs - startMs

  async function handleCreate(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const created = await window.api.video.createClip({
        sourcePath: video.file_path,
        startMs,
        endMs,
        name: name.trim() || defaultName(),
        mode
      })
      setResult({ outputPath: created.outputPath, sizeBytes: created.sizeBytes })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function defaultName(): string {
    const champ = video.champion_name ? `${video.champion_name} ` : ''
    return `${champ}${formatClock(startMs)}-${formatClock(endMs)}`.replace(/:/g, '.')
  }

  return (
    <div className="clip-editor">
      <div className="clip-editor-head">
        <span className="clip-editor-title">
          <Scissors size={15} /> Create a clip
        </span>
        <div className="clip-editor-head-actions">
          <button
            className="link-button"
            onClick={() => window.api.video.revealClipsFolder()}
            title={clipsDir ? `Saving to ${clipsDir} (change in Settings)` : undefined}
          >
            <FolderOpen size={14} /> Open clips folder
          </button>
          <button className="player-icon-btn" onClick={onClose} aria-label="Close clip editor">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="clip-zoom-row">
        <span className="clip-field-label" title="Scroll the mouse wheel over the timeline to pan it">
          Showing {formatClock(viewStartMs)} &ndash; {formatClock(viewEndMs)}{' '}
          <span className="clip-scroll-hint">(scroll to pan)</span>
        </span>
        <div className="clip-zoom-buttons">
          <button
            className="player-icon-btn"
            onClick={() => {
              setViewCenterMs((startMs + endMs) / 2)
              setZoomIndex((i) => Math.max(0, i - 1))
            }}
            disabled={zoomIndex === 0}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
          <button
            className="player-icon-btn"
            onClick={() => {
              setViewCenterMs((startMs + endMs) / 2)
              setZoomIndex((i) => Math.min(ZOOM_LEVELS_MS.length - 1, i + 1))
            }}
            disabled={zoomIndex === ZOOM_LEVELS_MS.length - 1}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          <button
            className="secondary player-sync-btn"
            onClick={() => setViewCenterMs((startMs + endMs) / 2)}
            title="Centre the view on the selected clip"
          >
            Centre
          </button>
        </div>
      </div>

      {/* Zoomed timeline: action curve, bookmark ticks, and the selection with
          draggable ends. Click-drag anywhere on the empty track to start a
          new selection from scratch; drag the blue region to slide the whole
          clip; drag either edge handle to resize. */}
      <div className="clip-track" ref={trackRef} onMouseDown={handleTrackMouseDown}>
        <svg
          className="clip-density"
          viewBox="0 0 1000 40"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={densityPath} className="clip-density-fill" />
        </svg>

        {tags
          .filter((t) => t.timestamp_ms >= viewStartMs && t.timestamp_ms <= viewEndMs)
          .map((tag) => (
            <span
              key={tag.id}
              className={`clip-tick clip-tick--${tag.type}`}
              style={{ left: `${toRatio(tag.timestamp_ms) * 100}%` }}
              title={`${tag.label} \u2014 ${formatClock(tag.timestamp_ms)}`}
            />
          ))}

        {/* Dimmed regions outside the selection make the kept part obvious. */}
        <div
          className="clip-shade"
          style={{ left: 0, width: `${Math.max(0, toRatio(startMs)) * 100}%` }}
        />
        <div
          className="clip-shade"
          style={{
            left: `${Math.min(1, toRatio(endMs)) * 100}%`,
            right: 0
          }}
        />

        <div
          className={`clip-selection ${dragging === 'select' ? 'clip-selection--dragging' : ''}`}
          style={{
            left: `${toRatio(startMs) * 100}%`,
            width: `${(toRatio(endMs) - toRatio(startMs)) * 100}%`
          }}
          onMouseDown={handleSelectionMouseDown}
          title="Drag to move the whole clip without changing its length"
        >
          <span className="clip-selection-duration">{formatDurationLabel(clipDurationMs)}</span>
        </div>

        <div
          role="slider"
          tabIndex={0}
          aria-label="Clip start"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={startMs}
          className={`clip-handle clip-handle--start ${dragging === 'start' ? 'clip-handle--active' : ''}`}
          style={{ left: `${toRatio(startMs) * 100}%` }}
          onMouseDown={(e) => {
            e.stopPropagation()
            setDragging('start')
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') nudge('start', -250)
            if (e.key === 'ArrowRight') nudge('start', 250)
          }}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Clip end"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={endMs}
          className={`clip-handle clip-handle--end ${dragging === 'end' ? 'clip-handle--active' : ''}`}
          style={{ left: `${toRatio(endMs) * 100}%` }}
          onMouseDown={(e) => {
            e.stopPropagation()
            setDragging('end')
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') nudge('end', -250)
            if (e.key === 'ArrowRight') nudge('end', 250)
          }}
        />

        {currentTimeMs >= viewStartMs && currentTimeMs <= viewEndMs && (
          <div className="clip-playhead" style={{ left: `${toRatio(currentTimeMs) * 100}%` }} />
        )}
      </div>

      <div className="clip-bounds-row">
        <div className="clip-bound">
          <span className="clip-field-label">Start</span>
          <div className="clip-bound-controls">
            <button className="player-icon-btn" onClick={() => nudge('start', -1000)} title="Back 1s">
              &minus;1s
            </button>
            <button className="player-icon-btn" onClick={() => nudge('start', -100)} title="Back 0.1s">
              &minus;
            </button>
            <span className="clip-bound-value">{formatClock(startMs)}</span>
            <button className="player-icon-btn" onClick={() => nudge('start', 100)} title="Forward 0.1s">
              +
            </button>
            <button className="player-icon-btn" onClick={() => nudge('start', 1000)} title="Forward 1s">
              +1s
            </button>
            <button
              className="secondary player-sync-btn"
              onClick={() => nudge('start', currentTimeMs - startMs)}
              title="Set the clip start to the current playback position"
            >
              Set to playhead
            </button>
          </div>
        </div>

        <div className="clip-bound">
          <span className="clip-field-label">End</span>
          <div className="clip-bound-controls">
            <button className="player-icon-btn" onClick={() => nudge('end', -1000)} title="Back 1s">
              &minus;1s
            </button>
            <button className="player-icon-btn" onClick={() => nudge('end', -100)} title="Back 0.1s">
              &minus;
            </button>
            <span className="clip-bound-value">{formatClock(endMs)}</span>
            <button className="player-icon-btn" onClick={() => nudge('end', 100)} title="Forward 0.1s">
              +
            </button>
            <button className="player-icon-btn" onClick={() => nudge('end', 1000)} title="Forward 1s">
              +1s
            </button>
            <button
              className="secondary player-sync-btn"
              onClick={() => nudge('end', currentTimeMs - endMs)}
              title="Set the clip end to the current playback position"
            >
              Set to playhead
            </button>
          </div>
        </div>
      </div>

      <div className="clip-output-row">
        <div className="filter-row clip-name-field">
          <label htmlFor="clip-name">Clip name</label>
          <input
            id="clip-name"
            type="text"
            placeholder={defaultName()}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="filter-row">
          <label htmlFor="clip-mode">Quality</label>
          <select
            id="clip-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'fast' | 'exact')}
          >
            <option value="fast">Fast &mdash; no quality loss, snaps to nearest keyframe</option>
            <option value="exact">Exact &mdash; precise cut, re-encodes (slower)</option>
          </select>
        </div>

        <button onClick={handleCreate} disabled={busy || clipDurationMs < MIN_CLIP_MS}>
          <Scissors size={15} /> {busy ? 'Creating...' : `Create clip (${formatDurationLabel(clipDurationMs)})`}
        </button>
      </div>

      <p className="settings-row-hint">
        Fast mode copies the video stream untouched, so it finishes almost instantly and loses no
        quality &mdash; but a cut can only begin on a keyframe, so the clip may start up to a
        second or two earlier than marked. Choose Exact when the precise first frame matters.
      </p>

      {error && <p className="status status-error">{error}</p>}

      {result && (
        <div className="clip-result">
          <span className="status status-success">
            Saved {formatSize(result.sizeBytes)} to {result.outputPath}
          </span>
          <button className="secondary" onClick={() => window.api.video.revealClip(result.outputPath)}>
            <FolderOpen size={14} /> Show in folder
          </button>
        </div>
      )}
    </div>
  )
}

export default ClipEditor
