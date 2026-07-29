import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, Link2, Maximize, Minimize, Scissors } from 'lucide-react'
import { revealVideoInFolder } from '../lib/revealInFolder'
import ClipEditor from './ClipEditor'
import { buildActionDensity, densityAreaPath, fromMatchActionEvents, type DensityEvent } from '../lib/actionDensity'
import type { MatchActionEvent } from '../../../shared/types'
import type { AppSettings, PlayerPreferences, TagRow, VideoRow } from '../../../shared/types'
import { DEFAULT_PLAYER_PREFERENCES } from '../../../shared/types'
import PlayerSettingsPanel from './PlayerSettingsPanel'
import MatchLinker, { type LinkMode } from './MatchLinker'
import MatchStatsPanel from './MatchStatsPanel'

interface VideoPlayerProps {
  video: VideoRow
  settings: AppSettings
  onBack: () => void
  onVideoUpdated?: (video: VideoRow) => void
}

const TAG_ICONS: Record<string, string> = {
  kill: '\u2694\uFE0F',
  doublekill: '\u2694\uFE0F',
  triplekill: '\uD83D\uDD25',
  quadrakill: '\u26A1',
  pentakill: '\uD83D\uDC51',
  multikill: '\uD83D\uDD25',
  death: '\uD83D\uDC80',
  assist: '\uD83E\uDD1D',
  turret: '\uD83C\uDFF0',
  inhibitor: '\uD83D\uDEE1\uFE0F',
  dragon: '\uD83D\uDC09',
  baron: '\uD83D\uDC79',
  herald: '\uD83D\uDC51',
  other_objective: '\u2B50',
  towerdive: '\uD83D\uDDFC',
  outplay: '\u2728'
}

// Multikill tiers, largest first -- used to find a video's best streak for
// the highlight badge.
const MULTIKILL_TIERS: Array<{ type: string; label: string }> = [
  { type: 'pentakill', label: 'Penta kill' },
  { type: 'quadrakill', label: 'Quadra kill' },
  { type: 'triplekill', label: 'Triple kill' },
  { type: 'doublekill', label: 'Double kill' }
]

function tagIcon(type: string): string {
  return TAG_ICONS[type] ?? '\uD83D\uDCCC'
}

// Playback speed range/step for both the dropdown and the up/down arrow key
// shortcuts, so they stay in sync with each other.
const RATE_MIN = 0.25
const RATE_MAX = 2.5
const RATE_STEP = 0.25
const RATE_OPTIONS = Array.from(
  { length: Math.round((RATE_MAX - RATE_MIN) / RATE_STEP) + 1 },
  (_, i) => Math.round((RATE_MIN + i * RATE_STEP) * 100) / 100
)

interface TagColumn {
  key: string
  label: string
  types: string[]
  tags: TagRow[]
}

const COLUMN_DEFS: Array<{ key: string; label: string; types: string[] }> = [
  { key: 'kill', label: 'Kills', types: ['kill'] },
  // Multikills get their own column: they're the moments worth rewatching,
  // so burying them among ordinary kills made them hard to find.
  {
    key: 'multikill',
    label: 'Multikills',
    types: ['doublekill', 'triplekill', 'quadrakill', 'pentakill', 'multikill']
  },
  { key: 'death', label: 'Deaths', types: ['death'] },
  { key: 'assist', label: 'Assists', types: ['assist'] },
  // Also logged as a plain 'kill' event -- this column is the same kill
  // called out a second time for "landed under an enemy turret, solo".
  { key: 'towerdive', label: 'Tower dives', types: ['towerdive'] },
  {
    key: 'objective',
    label: 'Objectives',
    types: ['turret', 'inhibitor', 'dragon', 'baron', 'herald', 'other_objective']
  },
  { key: 'manual', label: 'Marked', types: ['outplay'] }
]

function groupTagsIntoColumns(tags: TagRow[]): TagColumn[] {
  return COLUMN_DEFS.map((def) => ({
    ...def,
    tags: tags.filter((t) => def.types.includes(t.type))
  })).filter((col) => col.tags.length > 0)
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function VideoPlayer({ video, settings, onBack, onVideoUpdated }: VideoPlayerProps): JSX.Element {
  const [relinkMode, setRelinkMode] = useState<LinkMode | null>(null)
  const [showRelinkMenu, setShowRelinkMenu] = useState(false)
  const relinkMenuRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [tags, setTags] = useState<TagRow[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [volume, setVolume] = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [addingTag, setAddingTag] = useState(false)
  const [syncSeconds, setSyncSeconds] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<PlayerPreferences>(DEFAULT_PLAYER_PREFERENCES)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    window.api.video.toFileUrl(video.file_path).then(setSrc)
    window.api.db.listTags(video.id).then(setTags)
    window.api.db.getPlayerPreferences().then(setPreferences)
  }, [video.file_path, video.id])

  // Resumes near where playback last stopped, instead of always restarting
  // from 0:00. Applied once per video, right after the browser reports a
  // duration -- seeking any earlier has nothing to seek within yet. Skipped
  // when the saved position is basically at the end (within 5s), since
  // resuming a finished video right back at its last frame is more
  // annoying than just starting over.
  const resumeAppliedRef = useRef(false)
  useEffect(() => {
    resumeAppliedRef.current = false
  }, [video.id])

  useEffect(() => {
    if (resumeAppliedRef.current) return
    if (durationMs <= 0) return
    const saved = video.last_position_ms
    if (!saved || saved <= 0) {
      resumeAppliedRef.current = true
      return
    }
    if (saved >= durationMs - 5000) {
      resumeAppliedRef.current = true
      return
    }
    resumeAppliedRef.current = true
    seekTo(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, video.id, video.last_position_ms])

  // Persists roughly where playback is, so re-opening this video later can
  // resume near here. Saved on an interval while playing (not on every
  // timeupdate -- that fires ~4x/second, far more than this needs) and once
  // more on unmount/video change, so a pause-and-close still gets recorded.
  useEffect(() => {
    const interval = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) {
        window.api.db.updateLastPosition({
          videoId: video.id,
          positionMs: videoRef.current.currentTime * 1000
        })
      }
    }, 10_000)

    return () => {
      clearInterval(interval)
      if (videoRef.current) {
        window.api.db.updateLastPosition({
          videoId: video.id,
          positionMs: videoRef.current.currentTime * 1000
        })
      }
    }
  }, [video.id])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (relinkMenuRef.current && !relinkMenuRef.current.contains(e.target as Node)) {
        setShowRelinkMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Track fullscreen from the document, so the button's icon stays right even
  // when the user leaves fullscreen with Escape rather than the button.
  useEffect(() => {
    function onChange(): void {
      setIsFullscreen(document.fullscreenElement !== null)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function togglePlay(): void {
    const el = videoRef.current
    if (!el) return
    if (el.paused) el.play()
    else el.pause()
  }

  function seekTo(ms: number): void {
    const el = videoRef.current
    if (!el) return
    el.currentTime = Math.max(0, ms / 1000)
  }

  // Jumps to a bookmark, rewinding by the configured lead-in so you see the
  // moment building up rather than landing right on the result. Also records
  // the bookmark's game time so the stats graphs can mark that moment.
  function seekToBookmark(ms: number): void {
    const leadInMs = preferences.bookmarkLeadInSeconds * 1000
    seekTo(Math.max(0, ms - leadInMs))
    setMarkedGameTimeMs(ms - (video.sync_offset_ms ?? 0))
    if (preferences.autoPlayOnJump) {
      videoRef.current?.play()
    }
  }

  function seekBy(deltaSeconds: number): void {
    const el = videoRef.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + deltaSeconds))
  }

  async function toggleFullscreen(): Promise<void> {
    // Fullscreens the stage rather than the <video> itself, so the active-tag
    // overlay stays visible over the picture.
    const stage = stageRef.current
    if (!stage) return
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await stage.requestFullscreen()
    }
  }

  function changePlaybackRate(delta: number): void {
    const el = videoRef.current
    setPlaybackRate((prev) => {
      const next = Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, prev + delta)) * 100) / 100
      if (el) el.playbackRate = next
      return next
    })
  }

  // Arrow-key shortcuts: left/right skip backward/forward by the configured
  // step (same step as the skip buttons), up/down nudge playback speed.
  // Ignored while typing in an input/textarea (e.g. the sync-seconds field)
  // so arrow keys still work as expected for editing text there.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null
      const isTyping =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (isTyping) return

      // Spacebar (play/pause) and F (fullscreen) are handled before the
      // "don't steal focus from other widgets" guard below, and always take
      // effect regardless of what has focus. Without this, if a button
      // elsewhere on the page (a bookmark chip, a stats tab, a filter
      // button) happened to have focus, the browser's default "space
      // activates the focused button" behavior would fire instead of
      // toggling playback -- which is exactly the "spacebar sometimes
      // doesn't work" symptom this fixes. preventDefault suppresses that
      // default click-on-space behavior in addition to page scroll.
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) togglePlay()
        return
      }
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (!e.repeat) toggleFullscreen()
        return
      }

      // Don't steal arrow keys from widgets that use them for their own
      // navigation. The stats panel's tab strip moves selection with
      // left/right, and previously a single press did both -- moved the tab
      // AND skipped the video. Whatever has focus wins; the player only
      // takes arrows when focus is somewhere neutral.
      if (target?.closest('[role="tablist"], select, [role="slider"], input[type="range"]')) {
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          seekBy(-preferences.seekStepSeconds)
          break
        case 'ArrowRight':
          e.preventDefault()
          seekBy(preferences.seekStepSeconds)
          break
        case 'ArrowUp':
          e.preventDefault()
          changePlaybackRate(RATE_STEP)
          break
        case 'ArrowDown':
          e.preventDefault()
          changePlaybackRate(-RATE_STEP)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.seekStepSeconds])

  function handleTimelineClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    seekTo(ratio * durationMs)
  }

  async function handleAddTag(): Promise<void> {
    setAddingTag(true)
    try {
      const tag = await window.api.db.insertManualTag({
        videoId: video.id,
        timestampMs: Math.round(currentTimeMs),
        type: 'outplay',
        label: 'Marked moment'
      })
      setTags((prev) => [...prev, tag].sort((a, b) => a.timestamp_ms - b.timestamp_ms))
    } finally {
      setAddingTag(false)
    }
  }

  async function handleDeleteTag(tagId: number): Promise<void> {
    await window.api.db.deleteTag(tagId)
    setTags((prev) => prev.filter((t) => t.id !== tagId))
  }

  async function handleSync(): Promise<void> {
    const seconds = Number(syncSeconds)
    if (!Number.isFinite(seconds)) {
      setSyncMessage('Enter a number of seconds.')
      return
    }
    setSyncing(true)
    setSyncMessage(null)
    try {
      await window.api.db.resyncTags({ videoId: video.id, recordingStartSeconds: seconds })
      const refreshed = await window.api.db.listTags(video.id)
      setTags(refreshed)
      setSyncMessage(`Synced: recording now treated as starting ${seconds}s into the match.`)
    } finally {
      setSyncing(false)
    }
  }

  const progressRatio = durationMs > 0 ? currentTimeMs / durationMs : 0

  const sortedTags = useMemo(() => [...tags].sort((a, b) => a.timestamp_ms - b.timestamp_ms), [tags])

  const activeTag = useMemo(() => {
    let candidate: TagRow | null = null
    for (const t of sortedTags) {
      if (t.timestamp_ms <= currentTimeMs) candidate = t
      else break
    }
    return candidate
  }, [sortedTags, currentTimeMs])

  const columns = useMemo(() => groupTagsIntoColumns(sortedTags), [sortedTags])

  // Biggest multikill in this game, for the badge next to the KDA.
  const bestMultikill = useMemo(
    () => MULTIKILL_TIERS.find((tier) => tags.some((t) => t.type === tier.type)) ?? null,
    [tags]
  )

  // Standout moments, surfaced as one-click jumps so the parts of the VOD
  // actually worth rewatching don't have to be hunted for in the bookmark
  // columns. Solo multikills rank above assisted ones of the same size;
  // solo tower dives are their own kind of standout and are ranked below
  // the multikill tiers but still above the (unfiltered) rest.
  const highlights = useMemo(() => {
    const multikillTypes = new Set(MULTIKILL_TIERS.map((t) => t.type))
    return sortedTags
      .filter((t) => multikillTypes.has(t.type) || t.type === 'towerdive')
      .map((tag) => ({ tag, solo: tag.detail === 'solo' }))
      .sort((a, b) => {
        const rank = (type: string): number => {
          if (type === 'towerdive') return 0
          return MULTIKILL_TIERS.length - MULTIKILL_TIERS.findIndex((t) => t.type === type)
        }
        const byTier = rank(b.tag.type) - rank(a.tag.type)
        if (byTier !== 0) return byTier
        if (a.solo !== b.solo) return a.solo ? -1 : 1
        return a.tag.timestamp_ms - b.tag.timestamp_ms
      })
  }, [sortedTags])

  // Video time and game time differ by the stored sync offset (set via the
  // Sync control). The stats panel works in game time, so conversions live
  // here where both are known. A missing offset is treated as 0.
  const syncOffsetMs = video.sync_offset_ms ?? 0
  // Quantised to whole seconds before it reaches the stats panel. The video
  // element fires timeupdate ~4x/second, and passing that straight through
  // re-rendered the entire panel (scoreboard tables, graph SVG, gauges) that
  // often, which is what made playback feel laggy. One update per second is
  // all a playback marker needs.
  const currentGameTimeSec =
    durationMs > 0 ? Math.floor((currentTimeMs - syncOffsetMs) / 1000) : null
  const currentGameTimeMs = useMemo(
    () => (currentGameTimeSec === null ? null : currentGameTimeSec * 1000),
    [currentGameTimeSec]
  )

  function seekToGameTime(gameTimeMs: number): void {
    seekTo(gameTimeMs + syncOffsetMs)
  }

  // Game time of the bookmark the user most recently jumped to, so the
  // graphs can mark the same moment they're now watching.
  const [markedGameTimeMs, setMarkedGameTimeMs] = useState<number | null>(null)
  const [showClipEditor, setShowClipEditor] = useState(false)

  // Collapsible sections. Only the video itself is always shown -- match
  // stats and bookmarks can each be hidden independently, e.g. to give the
  // clip editor more room, or when you just want to watch without either.
  const [statsCollapsed, setStatsCollapsed] = useState(false)
  const [bookmarksCollapsed, setBookmarksCollapsed] = useState(false)

  // Match-wide action events (all 10 players), for the density curve. Loaded
  // once per linked match -- this is NOT the recording owner's bookmark tags,
  // which only cover their own kills/deaths/objectives and would miss a
  // teamfight they weren't part of.
  const [matchActionEvents, setMatchActionEvents] = useState<MatchActionEvent[]>([])

  useEffect(() => {
    if (!video.match_id || settings.accounts.length === 0) {
      setMatchActionEvents([])
      return
    }
    let cancelled = false
    window.api.riot
      .getMatchActionTimeline({
        matchId: video.match_id,
        accounts: settings.accounts.map((a) => ({ platform: a.platform, puuid: a.puuid }))
      })
      .then((result) => {
        if (!cancelled) setMatchActionEvents(result.events)
      })
      .catch(() => {
        if (!cancelled) setMatchActionEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [video.match_id, settings.accounts])

  // Action events are reported in GAME time; the timeline/clip editor work in
  // VIDEO time, which differ by the sync offset. Shifted once here so every
  // consumer (the main timeline and the clip editor) draws from the same,
  // already-correct series instead of each re-deriving the shift.
  const videoTimeActionEvents: DensityEvent[] = useMemo(
    () =>
      fromMatchActionEvents(matchActionEvents).map((e) => ({
        ...e,
        timestampMs: e.timestampMs + syncOffsetMs
      })),
    [matchActionEvents, syncOffsetMs]
  )

  const timelineDensityPath = useMemo(
    () => densityAreaPath(buildActionDensity(videoTimeActionEvents, durationMs, 300), 1000, 34),
    [videoTimeActionEvents, durationMs]
  )

  if (relinkMode) {
    return (
      <MatchLinker
        video={video}
        settings={settings}
        mode={relinkMode}
        onCancel={() => setRelinkMode(null)}
        onDone={async () => {
          setRelinkMode(null)
          const refreshed = await window.api.db.getVideo(video.id)
          if (refreshed) onVideoUpdated?.(refreshed)
          const refreshedTags = await window.api.db.listTags(video.id)
          setTags(refreshedTags)
        }}
      />
    )
  }

  return (
    <div className="player-view">
      <div className="player-topbar">
        <button className="secondary" onClick={onBack}>
          &larr; Back
        </button>
        <div className="player-title">
          <span className="player-filename">{video.file_name}</span>
          {video.champion_name && (
            <span className="player-subtitle">
              {video.champion_name} &middot; {video.kda} &middot; {video.win ? 'Win' : 'Loss'}
              {bestMultikill && (
                <span className={`multikill-badge multikill-badge--${bestMultikill.type}`}>
                  {bestMultikill.label}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="player-sync">
          <label htmlFor="sync-seconds" className="player-sync-label">
            Recording started
          </label>
          <input
            id="sync-seconds"
            type="number"
            className="player-sync-input"
            placeholder="0"
            value={syncSeconds}
            onChange={(e) => setSyncSeconds(e.target.value)}
          />
          <span className="player-sync-label">sec into match</span>
          <button className="secondary player-sync-btn" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
          <button
            className="secondary player-sync-btn"
            onClick={() => void revealVideoInFolder(video.file_path)}
            aria-label="Show this video in its folder"
            title={`Show in folder: ${video.file_path}`}
          >
            <FolderOpen size={14} /> Show in folder
          </button>
          <div className="relink-menu-wrap" ref={relinkMenuRef}>
            <button
              className="secondary player-sync-btn"
              onClick={() => setShowRelinkMenu((v) => !v)}
              aria-label="Re-link this video to a different match"
              title="Re-link this video to a different match"
            >
              <Link2 size={14} /> Re-link
            </button>
            {showRelinkMenu && (
              <div className="relink-menu">
                <button
                  className="relink-menu-item"
                  onClick={() => {
                    setShowRelinkMenu(false)
                    setRelinkMode('auto')
                  }}
                >
                  <span className="relink-menu-item-title">Automatic re-link</span>
                  <span className="relink-menu-item-hint">
                    Search and link the closest match by recording time
                  </span>
                </button>
                <button
                  className="relink-menu-item"
                  onClick={() => {
                    setShowRelinkMenu(false)
                    setRelinkMode('manual')
                  }}
                >
                  <span className="relink-menu-item-title">Manual re-link</span>
                  <span className="relink-menu-item-hint">
                    Filter candidates by kills, deaths, or lane opponent
                  </span>
                </button>
              </div>
            )}
          </div>
          <button
            className="player-icon-btn player-settings-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Player settings"
            title="Player settings"
          >
            &#9881;
          </button>
        </div>
      </div>
      {syncMessage && <p className="status player-sync-status">{syncMessage}</p>}

      {showSettings && (
        <PlayerSettingsPanel
          preferences={preferences}
          onClose={() => setShowSettings(false)}
          onSave={(prefs) => {
            setPreferences(prefs)
            window.api.db.savePlayerPreferences(prefs)
          }}
        />
      )}

      {/* Two-column body: player on the left, match stats on the right.
          Below 1100px these stack (see .player-body in global.css), with the
          stats panel dropping under the video and above the bookmarks. */}
      <div className={`player-body ${statsCollapsed ? 'player-body--stats-collapsed' : ''}`}>
        <div className="player-main">
      <div className="player-stage" ref={stageRef}>
        {src && (
          <video
            ref={videoRef}
            src={src}
            className="player-video"
            onClick={togglePlay}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onLoadedMetadata={(e) => setDurationMs(e.currentTarget.duration * 1000)}
            onTimeUpdate={(e) => setCurrentTimeMs(e.currentTarget.currentTime * 1000)}
          />
        )}

        {activeTag && (
          <div className="player-active-tag">
            <span className="player-active-tag-icon">{tagIcon(activeTag.type)}</span>
            {activeTag.label}
          </div>
        )}
      </div>

      <div className="player-controls">
        <button className="player-icon-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? '\u23F8' : '\u25B6'}
        </button>
        <button
          className="player-icon-btn"
          onClick={() => seekBy(-preferences.seekStepSeconds)}
          aria-label={`Back ${preferences.seekStepSeconds} seconds`}
        >
          &#8634; {preferences.seekStepSeconds}s
        </button>
        <button
          className="player-icon-btn"
          onClick={() => seekBy(preferences.seekStepSeconds)}
          aria-label={`Forward ${preferences.seekStepSeconds} seconds`}
        >
          {preferences.seekStepSeconds}s &#8635;
        </button>

        <span className="player-time">
          {formatTime(currentTimeMs)} / {formatTime(durationMs)}
        </span>

        <select
          className="player-rate-select"
          value={playbackRate}
          onChange={(e) => {
            const rate = Number(e.target.value)
            setPlaybackRate(rate)
            if (videoRef.current) videoRef.current.playbackRate = rate
          }}
        >
          {RATE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}x
            </option>
          ))}
        </select>

        <input
          className="player-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value)
            setVolume(v)
            if (videoRef.current) videoRef.current.volume = v
          }}
        />

        <button
          className="player-icon-btn"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          title={isFullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </button>

        {highlights.length > 0 && (
          <div className="player-highlights" aria-label="Interesting moments">
            <span className="player-highlights-label">Highlights</span>
            {highlights.map(({ tag, solo }) => (
              <button
                key={tag.id}
                className={`highlight-chip highlight-chip--${tag.type}`}
                onClick={() => seekToBookmark(tag.timestamp_ms)}
                title={`${tag.label} at ${formatTime(tag.timestamp_ms)} \u2014 jump here`}
              >
                <span aria-hidden="true">{tagIcon(tag.type)}</span>
                <span className="highlight-chip-name">
                  {tag.type === 'towerdive'
                    ? 'Tower dive'
                    : MULTIKILL_TIERS.find((t) => t.type === tag.type)?.label ?? 'Multikill'}
                </span>
                {solo && <span className="highlight-chip-solo">solo</span>}
                <span className="highlight-chip-time">{formatTime(tag.timestamp_ms)}</span>
              </button>
            ))}
          </div>
        )}

        <button
          className={`secondary player-add-tag ${showClipEditor ? 'filter-toggle--active' : ''}`}
          onClick={() => setShowClipEditor((v) => !v)}
          title="Cut a shareable clip from this recording"
        >
          <Scissors size={14} /> Clip
        </button>

        <button className="secondary" onClick={handleAddTag} disabled={addingTag}>
          + Mark this moment
        </button>
      </div>

      {/* Action curve above the scrub bar: busy stretches of the game stand
          out, so the parts worth watching are findable at a glance. Derived
          from match events rather than input (see actionDensity.ts). */}
      {durationMs > 0 && videoTimeActionEvents.length > 0 && (
        <svg
          className="player-density"
          viewBox="0 0 1000 34"
          preserveAspectRatio="none"
          role="img"
          aria-label="Action intensity across the recording"
        >
          <path d={timelineDensityPath} className="clip-density-fill" />
        </svg>
      )}

      <div className="player-timeline" onClick={handleTimelineClick}>
        <div className="player-timeline-track">
          <div className="player-timeline-progress" style={{ width: `${progressRatio * 100}%` }} />
          <div className="player-timeline-scrubber" style={{ left: `${progressRatio * 100}%` }} />

          {sortedTags.map((tag) => {
            const left = durationMs > 0 ? (tag.timestamp_ms / durationMs) * 100 : 0
            return (
              <div
                key={tag.id}
                className={`player-timeline-marker player-timeline-marker--${tag.type}`}
                style={{ left: `${left}%` }}
                title={`${formatTime(tag.timestamp_ms)} \u2014 ${tag.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  seekToBookmark(tag.timestamp_ms)
                }}
              >
                <span className="player-timeline-marker-icon">{tagIcon(tag.type)}</span>
              </div>
            )
          })}
        </div>
      </div>
        </div>

        <aside className={`player-stats-col ${statsCollapsed ? 'player-stats-col--collapsed' : ''}`}>
          <button
            className="player-section-toggle"
            onClick={() => setStatsCollapsed((v) => !v)}
            aria-expanded={!statsCollapsed}
          >
            <ChevronDown
              size={14}
              className={`player-section-toggle-chevron ${statsCollapsed ? 'player-section-toggle-chevron--collapsed' : ''}`}
            />
            Match stats
          </button>
          {!statsCollapsed && (
            <MatchStatsPanel
              video={video}
              accounts={settings.accounts}
              currentGameTimeMs={currentGameTimeMs}
              markedGameTimeMs={markedGameTimeMs}
              onSeekGameTime={seekToGameTime}
              tags={sortedTags}
            />
          )}
        </aside>
      </div>

      {showClipEditor && durationMs > 0 && (
        <ClipEditor
          video={video}
          tags={sortedTags}
          actionEvents={videoTimeActionEvents}
          durationMs={durationMs}
          currentTimeMs={currentTimeMs}
          onPreviewSeek={seekTo}
          onClose={() => setShowClipEditor(false)}
        />
      )}

      <div className="player-bookmarks-section">
        <button
          className="player-section-toggle"
          onClick={() => setBookmarksCollapsed((v) => !v)}
          aria-expanded={!bookmarksCollapsed}
        >
          <ChevronDown
            size={14}
            className={`player-section-toggle-chevron ${bookmarksCollapsed ? 'player-section-toggle-chevron--collapsed' : ''}`}
          />
          Bookmarks
          {sortedTags.length > 0 && <span className="stats-tag">{sortedTags.length}</span>}
        </button>

        {!bookmarksCollapsed && (
          <div className="player-bookmark-columns">
            {sortedTags.length === 0 ? (
              <p className="subtitle">No bookmarks yet. Play the video and click &quot;Mark this moment&quot; to add one.</p>
            ) : (
              columns.map((col) => (
                <div key={col.key} className={`bookmark-column bookmark-column--${col.key}`}>
                  <div className="bookmark-column-header">
                    <span>{col.label}</span>
                    <span className="bookmark-column-count">{col.tags.length}</span>
                  </div>
                  <div className="bookmark-column-list">
                    {col.tags.map((tag) => (
                      <button
                        key={tag.id}
                        className={`bookmark-chip bookmark-chip--${tag.type}`}
                        onClick={() => seekToBookmark(tag.timestamp_ms)}
                      >
                        <span>{tagIcon(tag.type)}</span>
                        <span className="bookmark-chip-time">{formatTime(tag.timestamp_ms)}</span>
                        <span className="bookmark-chip-label">{tag.label}</span>
                        {tag.source === 'manual' && (
                          <span
                            className="bookmark-chip-delete"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeleteTag(tag.id)
                            }}
                          >
                            &times;
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default VideoPlayer
