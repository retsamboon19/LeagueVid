import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckSquare, DatabaseBackup, Link2, Plus, Trash2, Wrench } from 'lucide-react'
import type { AppSettings, LeadSwingResult, MatchStats, VideoRow } from '../../../shared/types'
import BackfillStatusBanner from './BackfillStatusBanner'
import MatchLinker from './MatchLinker'
import VideoPlayer from './VideoPlayer'
import MatchTile from './MatchTile'
import AddMediaPopup from './AddMediaPopup'
import FilterPanel, {
  EMPTY_FILTERS,
  isFilterActive,
  type MatchFilters,
  type ThresholdFilter
} from './FilterPanel'
import {
  findBestMatch,
  linkVideoToMatch as performLink,
  rebuildBookmarks,
  searchMatchesForVideo
} from '../lib/autoLinkVideo'

type SortOrder = 'newest' | 'oldest'

// Which videos a bulk link run should cover. Re-linking an already-linked
// video is a legitimate repair (a wrong match or mistimed bookmarks fix
// themselves on a fresh link), so "all" has to be an explicit option rather
// than the previous unlinked-only behaviour.
type LinkScope = 'unlinked' | 'suspicious' | 'all'

interface LibraryProps {
  settings: AppSettings
  onPlayerActiveChange?: (active: boolean) => void
  /** Bumped when the user clicks the app title; resets to a plain list. */
  homeSignal?: number
}

// Remembers which video was last opened, so its tile can be highlighted
// when you come back to the list -- persisted across app restarts too,
// not just within the current session.
const LAST_VIEWED_KEY = 'leaguevid:lastViewedVideoId'

function loadLastViewedVideoId(): number | null {
  const raw = window.localStorage.getItem(LAST_VIEWED_KEY)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function parsedMinute(minute: string): number {
  const parsed = Number(minute)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15
}

// Behind (or ahead) by at least `threshold` gold vs the lane opponent at
// `minute`, flipped to the opposite sign by game end. Finds the timeline
// frame closest to the requested minute rather than requiring an exact
// match, since frames land roughly once a minute but not always on :00.
function evaluateLeadSwing(
  data: LeadSwingResult,
  minute: number,
  threshold: number,
  direction: 'comeback' | 'throw'
): boolean {
  if (!data.hasTimeline || !data.hasLaneOpponent || data.finalGoldDiff === null) return false
  if (data.series.length === 0) return false

  const targetMs = minute * 60_000
  let closest = data.series[0]
  for (const point of data.series) {
    if (Math.abs(point.timestampMs - targetMs) < Math.abs(closest.timestampMs - targetMs)) {
      closest = point
    }
  }

  return direction === 'comeback'
    ? closest.goldDiff <= -threshold && data.finalGoldDiff > 0
    : closest.goldDiff >= threshold && data.finalGoldDiff < 0
}

function passesThreshold(actual: number | null, filter: ThresholdFilter): boolean {
  if (!filter.value) return true
  if (actual === null) return false
  const target = Number(filter.value)
  if (!Number.isFinite(target)) return true
  return filter.comparison === 'gte' ? actual >= target : actual <= target
}

function Library({ settings, onPlayerActiveChange, homeSignal }: LibraryProps): JSX.Element {
  const [videos, setVideos] = useState<VideoRow[]>([])
  const [loading, setLoading] = useState(true)
  const [linkingVideoId, setLinkingVideoId] = useState<number | null>(null)
  const [playingVideoId, setPlayingVideoId] = useState<number | null>(null)
  const [showAddPopup, setShowAddPopup] = useState(false)
  const [filters, setFilters] = useState<MatchFilters>(EMPTY_FILTERS)
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [bulkLinking, setBulkLinking] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<string | null>(null)
  const [suspiciousVideoIds, setSuspiciousVideoIds] = useState<Set<number>>(new Set())
  // videoId -> set of ('tier' | 'tier:solo') keys present for that video, for
  // the multikill filters. Loaded once alongside the suspicious-bookmark
  // flags, since both are "extra facts about a video beyond its own row".
  const [multikillByVideo, setMultikillByVideo] = useState<Map<number, Set<string>>>(new Map())
  // Loaded lazily (only once the lead-swing filter has an actual threshold
  // typed in), since it costs reading+parsing cached match+timeline files
  // per video -- unlike the DB-backed suspicious/multikill facts above,
  // that's too heavy to do unconditionally on every refresh().
  const [leadSwingByVideo, setLeadSwingByVideo] = useState<Map<number, LeadSwingResult>>(new Map())
  const [leadSwingLoading, setLeadSwingLoading] = useState(false)
  // Timeline-free match stats per videoId, feeding the tiles' achievement
  // chips. Cached here rather than per tile so the whole list costs one call.
  const [statsByVideo, setStatsByVideo] = useState<Map<number, MatchStats>>(new Map())
  const [lastViewedVideoId, setLastViewedVideoId] = useState<number | null>(loadLastViewedVideoId)
  const [showRemoveAllConfirm, setShowRemoveAllConfirm] = useState(false)
  const [removingAll, setRemovingAll] = useState(false)
  const [showOnlySuspicious, setShowOnlySuspicious] = useState(false)
  const [showLinkScope, setShowLinkScope] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [showClearCacheConfirm, setShowClearCacheConfirm] = useState(false)
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheCount, setCacheCount] = useState<number | null>(null)
  // Multi-select removal: the middle ground between removing one tile at a
  // time and "Remove all". Selection mode is a toggle so the checkboxes
  // don't clutter every tile when you're just browsing.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  // Scroll position of the tile list is kept in a ref (not state) since it
  // changes on every scroll tick and shouldn't trigger a re-render -- it's
  // only read back when the list remounts after returning from the player.
  const tilesScrollRef = useRef<HTMLDivElement>(null)
  const savedScrollTop = useRef(0)

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const rows = await window.api.db.listVideos()
      setVideos(rows)
      const suspicious = await window.api.db.findVideosWithSuspiciousBookmarks()
      setSuspiciousVideoIds(new Set(suspicious))

      const multikills = await window.api.db.listMultikillTags()
      const byVideo = new Map<number, Set<string>>()
      for (const m of multikills) {
        const set = byVideo.get(m.videoId) ?? new Set<string>()
        set.add(m.type)
        if (m.solo) set.add(`${m.type}:solo`)
        byVideo.set(m.videoId, set)
      }
      setMultikillByVideo(byVideo)
    } finally {
      setLoading(false)
    }
  }

  async function handleRemove(videoId: number): Promise<void> {
    await window.api.db.deleteVideo(videoId)
    setVideos((prev) => prev.filter((v) => v.id !== videoId))
    setSelectedIds((prev) => {
      if (!prev.has(videoId)) return prev
      const next = new Set(prev)
      next.delete(videoId)
      return next
    })
  }

  async function handleToggleFavorite(videoId: number, next: boolean): Promise<void> {
    // Optimistic update: the star should feel instant, and this is a purely
    // local marker with no risk of drifting from a computed value.
    setVideos((prev) =>
      prev.map((v) => (v.id === videoId ? { ...v, is_favorite: next ? 1 : 0 } : v))
    )
    await window.api.db.setFavorite({ videoId, isFavorite: next })
  }

  function videosForScope(scope: LinkScope): VideoRow[] {
    if (scope === 'unlinked') return videos.filter((v) => v.match_id === null)
    if (scope === 'suspicious') return videos.filter((v) => suspiciousVideoIds.has(v.id))
    return videos // 'all' -- re-link everything, linked or not
  }

  /**
   * Bulk match linking over a chosen set of videos.
   *
   * The important subtlety is which matches count as already taken. A match
   * may only belong to one video, but a video being re-linked must be allowed
   * to reclaim the match it already has -- so only links held by videos
   * OUTSIDE the target set block a candidate. Getting this wrong is what
   * would make a re-link of everything fail to find anything, since every
   * match would already look claimed.
   */
  async function runLinking(scope: LinkScope): Promise<void> {
    const targets = videosForScope(scope)
    setShowLinkScope(false)
    if (targets.length === 0) return

    setBulkLinking(true)

    const targetIds = new Set(targets.map((v) => v.id))
    const claimed = new Set(
      videos
        .filter((v) => v.match_id !== null && !targetIds.has(v.id))
        .map((v) => v.match_id as string)
    )

    let linked = 0
    let skipped = 0

    // See handleRebuildBookmarks: one disk save at the end, not per video.
    await window.api.db.beginBulkWrites()
    try {
      for (let i = 0; i < targets.length; i++) {
        const video = targets[i]
        setBulkProgress(`Linking ${i + 1} of ${targets.length}: ${video.file_name}`)
        try {
          const matches = await searchMatchesForVideo(video, settings)
          const best = findBestMatch(matches, video, claimed)
          if (best) {
            await performLink(video, best)
            claimed.add(best.matchId)
            linked++
          } else {
            skipped++
          }
        } catch {
          skipped++
        }
      }
    } finally {
      setBulkProgress('Saving...')
      await window.api.db.endBulkWrites()
    }

    setBulkProgress(`Done: linked ${linked}, skipped ${skipped} (no confident match found).`)
    setBulkLinking(false)
    await refresh()
  }

  // Regenerates bookmarks for every already-linked video from cached data.
  // Used after bookmark generation itself improves (e.g. multikill detection,
  // clearer objective names) -- the links are fine, the tags are just stale.
  async function handleRebuildBookmarks(): Promise<void> {
    const linked = videos.filter((v) => v.match_id !== null)
    if (linked.length === 0) return

    setRebuilding(true)
    let done = 0
    let skipped = 0

    // Defer disk writes until the end: saving rewrites the entire database
    // file, so persisting per video made this take seconds each.
    await window.api.db.beginBulkWrites()
    try {
      for (let i = 0; i < linked.length; i++) {
        const video = linked[i]
        setBulkProgress(`Rebuilding bookmarks ${i + 1} of ${linked.length}: ${video.file_name}`)
        const ok = await rebuildBookmarks(video, settings)
        if (ok) done++
        else skipped++
      }
    } finally {
      setBulkProgress('Saving...')
      await window.api.db.endBulkWrites()
    }

    setBulkProgress(
      `Done: rebuilt ${done}, skipped ${skipped} (match data not downloaded yet). Multikills and objective names are now up to date.`
    )
    setRebuilding(false)
    await refresh()
  }

  async function openClearCacheConfirm(): Promise<void> {
    setShowClearCacheConfirm(true)
    const stats = await window.api.db.getApiCacheStats()
    setCacheCount(stats.count)
  }

  async function handleClearCache(): Promise<void> {
    setClearingCache(true)
    try {
      await window.api.db.clearMatchCache()
      setCacheCount(0)
    } finally {
      setClearingCache(false)
      setShowClearCacheConfirm(false)
    }
  }

  function toggleSelected(videoId: number): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(videoId)) next.delete(videoId)
      else next.add(videoId)
      return next
    })
  }

  function exitSelectMode(): void {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  async function handleBulkDelete(): Promise<void> {
    setBulkDeleting(true)
    try {
      const ids = [...selectedIds]
      await window.api.db.deleteVideos(ids)
      setVideos((prev) => prev.filter((v) => !selectedIds.has(v.id)))
      exitSelectMode()
    } finally {
      setBulkDeleting(false)
      setShowBulkDeleteConfirm(false)
    }
  }

  async function handleRemoveAll(): Promise<void> {
    setRemovingAll(true)
    try {
      await window.api.db.deleteAllVideos()
      setVideos([])
      setLastViewedVideoId(null)
      window.localStorage.removeItem(LAST_VIEWED_KEY)
    } finally {
      setRemovingAll(false)
      setShowRemoveAllConfirm(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  // Fetches lead-swing series for every linked video the first time the
  // filter is actually given a gold threshold, and again whenever new
  // videos get linked afterward (so a freshly-linked video isn't silently
  // excluded from the filter just because it arrived after the initial
  // load). Videos already covered are skipped -- only genuinely new ones are
  // fetched, so re-typing the threshold doesn't re-hit disk for everything.
  useEffect(() => {
    if (!filters.leadSwingGoldThreshold) return
    const linkedVideos = videos.filter((v) => v.match_id !== null)
    const uncovered = linkedVideos.filter((v) => !leadSwingByVideo.has(v.id))
    if (uncovered.length === 0) return

    let cancelled = false
    setLeadSwingLoading(true)
    window.api.riot
      .getLeadSwingBulk({
        matches: uncovered.map((v) => ({ videoId: v.id, matchId: v.match_id as string })),
        accounts: settings.accounts.map((a) => ({ platform: a.platform, puuid: a.puuid }))
      })
      .then((result) => {
        if (cancelled) return
        setLeadSwingByVideo((prev) => {
          const next = new Map(prev)
          for (const [videoId, data] of Object.entries(result)) {
            next.set(Number(videoId), data)
          }
          return next
        })
      })
      .finally(() => {
        if (!cancelled) setLeadSwingLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.leadSwingGoldThreshold, videos])

  // Loads timeline-free stats for every linked video, so the tiles can show
  // achievement chips backed by the real rule engine.
  //
  // Deliberately fire-and-forget with no loading state: the tiles render chips
  // from their own row data first and sharpen once this lands, so the list is
  // never blocked on it. Videos already covered are skipped, so linking a new
  // video only fetches that one.
  useEffect(() => {
    if (settings.accounts.length === 0) return
    const uncovered = videos.filter(
      (v) => v.match_id !== null && !statsByVideo.has(v.id)
    )
    if (uncovered.length === 0) return

    let cancelled = false
    window.api.riot
      .getMatchStatsBulkLite({
        matches: uncovered.map((v) => ({ videoId: v.id, matchId: v.match_id as string })),
        accounts: settings.accounts.map((a) => ({ platform: a.platform, puuid: a.puuid }))
      })
      .then((result) => {
        if (cancelled) return
        setStatsByVideo((prev) => {
          const next = new Map(prev)
          for (const [videoId, data] of Object.entries(result)) {
            next.set(Number(videoId), data)
          }
          return next
        })
      })
      .catch(() => {
        // Chips are a nice-to-have; a failure here just means the tiles keep
        // using their own row data.
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos, settings.accounts.length])

  // "Go home": clear anything that could be hiding the list, and leave any
  // drilled-into view. Skipped on first mount (nothing to reset yet).
  useEffect(() => {
    if (!homeSignal) return
    setFilters(EMPTY_FILTERS)
    setShowOnlySuspicious(false)
    setPlayingVideoId(null)
    setLinkingVideoId(null)
    setBulkProgress(null)
    setShowLinkScope(false)
    exitSelectMode()
  }, [homeSignal])

  const linkingVideo = videos.find((v) => v.id === linkingVideoId) ?? null
  const playingVideo = videos.find((v) => v.id === playingVideoId) ?? null

  useEffect(() => {
    onPlayerActiveChange?.(playingVideo !== null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingVideo])

  // Restores the tile list's scroll position once it's back on screen --
  // the scroll container unmounts while the player/linker view is shown, so
  // scrollTop would otherwise reset to 0 every time you back out of a video.
  useEffect(() => {
    if (!linkingVideo && !playingVideo && tilesScrollRef.current) {
      tilesScrollRef.current.scrollTop = savedScrollTop.current
    }
  }, [linkingVideo, playingVideo])

  function handleTilesScroll(): void {
    if (tilesScrollRef.current) savedScrollTop.current = tilesScrollRef.current.scrollTop
  }

  function openVideo(videoId: number): void {
    setLastViewedVideoId(videoId)
    window.localStorage.setItem(LAST_VIEWED_KEY, String(videoId))
    setPlayingVideoId(videoId)
  }

  const unlinkedCount = useMemo(
    () => videos.filter((v) => v.match_id === null).length,
    [videos]
  )

  const hasAnyFilter = useMemo(() => isFilterActive(filters), [filters])

  const filteredVideos = useMemo(() => {
    const filtered = videos.filter((video) => {
      // championsPlayed/enemyLaner are resolved champion ids from the
      // autocomplete (e.g. "MonkeyKing"), matching the exact form Riot
      // stores in championName -- no fuzzy matching needed at this point.
      // championsPlayed is OR'd: a video matches if it's ANY of the picked
      // champions.
      if (
        filters.championsPlayed.length > 0 &&
        (!video.champion_name || !filters.championsPlayed.includes(video.champion_name))
      ) {
        return false
      }
      if (filters.enemyLaner && video.enemy_champion_name !== filters.enemyLaner) return false

      if (filters.winLoss !== 'any') {
        const wantWin = filters.winLoss === 'win'
        if (video.win === null || (video.win === 1) !== wantWin) return false
      }

      if (filters.role && video.team_position !== filters.role) return false
      if (filters.queueId && String(video.queue_id ?? '') !== filters.queueId) return false
      if (filters.favoritesOnly && video.is_favorite !== 1) return false

      if (!passesThreshold(video.kills, filters.kills)) return false
      if (!passesThreshold(video.deaths, filters.deaths)) return false
      // CS per minute, derived from the recording's duration -- comparable
      // across games of different lengths in a way raw CS isn't.
      const csPerMin =
        video.cs !== null && video.duration_ms
          ? video.cs / (video.duration_ms / 60000)
          : null
      if (!passesThreshold(csPerMin, filters.csPerMin)) return false
      if (!passesThreshold(video.gold_diff, filters.goldDiff)) return false

      if (showOnlySuspicious && !suspiciousVideoIds.has(video.id)) return false

      if (filters.multikillTiers.length > 0) {
        const videoTags = multikillByVideo.get(video.id)
        if (!videoTags) return false
        // OR across selected tiers: a video matching ANY selected tier
        // counts. "Solo" narrows within that -- of the selected tiers, at
        // least one occurrence must have been unassisted.
        const matches = filters.multikillTiers.some((tier) =>
          filters.multikillSolo ? videoTags.has(`${tier}:solo`) : videoTags.has(tier)
        )
        if (!matches) return false
      }

      if (filters.summonerSpell) {
        const spellId = Number(filters.summonerSpell)
        if (video.summoner1_id !== spellId && video.summoner2_id !== spellId) return false
      }

      if (filters.keystone) {
        const keystoneId = Number(filters.keystone)
        if (video.keystone_id !== keystoneId) return false
      }

      if (filters.leadSwingGoldThreshold) {
        const threshold = Number(filters.leadSwingGoldThreshold)
        if (!Number.isFinite(threshold) || threshold < 0) return false
        const data = leadSwingByVideo.get(video.id)
        if (!data) return false // not loaded yet, or unlinked -- can't evaluate
        if (
          !evaluateLeadSwing(
            data,
            parsedMinute(filters.leadSwingMinute),
            threshold,
            filters.leadSwingDirection
          )
        ) {
          return false
        }
      }

      return true
    })

    return [...filtered].sort((a, b) => {
      const aTime = a.recorded_at ?? 0
      const bTime = b.recorded_at ?? 0
      return sortOrder === 'newest' ? bTime - aTime : aTime - bTime
    })
  }, [
    videos,
    filters,
    sortOrder,
    showOnlySuspicious,
    suspiciousVideoIds,
    multikillByVideo,
    leadSwingByVideo
  ])

  if (linkingVideo) {
    return (
      <MatchLinker
        video={linkingVideo}
        settings={settings}
        mode="auto"
        onDone={async () => {
          setLinkingVideoId(null)
          await refresh()
        }}
        onCancel={() => setLinkingVideoId(null)}
      />
    )
  }

  if (playingVideo) {
    return (
      <VideoPlayer
        video={playingVideo}
        settings={settings}
        onBack={() => setPlayingVideoId(null)}
        onVideoUpdated={(updated) => {
          setVideos((prev) => prev.map((v) => (v.id === updated.id ? updated : v)))
        }}
      />
    )
  }

  return (
    <div className="library-view">
      <div className="library-column library-column--tiles" ref={tilesScrollRef} onScroll={handleTilesScroll}>
        <div className="view-header">
          <h2>Your recordings</h2>
          <div className="view-header-actions">
            <select
              className="sort-select"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              aria-label="Sort recordings"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
            <button
              className="secondary"
              onClick={() => setShowLinkScope(true)}
              disabled={bulkLinking || videos.length === 0}
              title="Link or re-link recordings to matches"
            >
              <Link2 size={16} /> {bulkLinking ? 'Linking...' : 'Link matches'}
            </button>
            {suspiciousVideoIds.size > 0 && (
              <button
                className={`secondary ${showOnlySuspicious ? 'filter-toggle--active' : ''}`}
                onClick={() => setShowOnlySuspicious((v) => !v)}
                title="Show only recordings whose bookmarks look wrong"
              >
                <AlertTriangle size={15} />{' '}
                {showOnlySuspicious ? 'Showing' : 'Show'} bad bookmarks ({suspiciousVideoIds.size})
              </button>
            )}
            <button
              className="secondary"
              onClick={handleRebuildBookmarks}
              disabled={rebuilding || bulkLinking || videos.every((v) => v.match_id === null)}
              title="Regenerate bookmarks for all linked recordings from already-downloaded match data (no API use)"
            >
              <Wrench size={15} /> {rebuilding ? 'Rebuilding...' : 'Rebuild bookmarks'}
            </button>
            <button
              className="secondary"
              onClick={openClearCacheConfirm}
              title="Delete downloaded Riot match data so it re-downloads fresh (recordings and bookmarks are kept)"
            >
              <DatabaseBackup size={16} /> Clear match data
            </button>
            <button
              className="secondary danger-button"
              onClick={() => setShowRemoveAllConfirm(true)}
              disabled={videos.length === 0}
              title="Remove all recordings from LeagueVid (files on disk are kept)"
            >
              <Trash2 size={16} /> Remove all
            </button>
            {selectMode ? (
              <>
                <button
                  className="secondary danger-button"
                  onClick={() => setShowBulkDeleteConfirm(true)}
                  disabled={selectedIds.size === 0}
                >
                  <Trash2 size={16} /> Remove selected ({selectedIds.size})
                </button>
                <button className="secondary" onClick={exitSelectMode}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="secondary"
                onClick={() => setSelectMode(true)}
                disabled={videos.length === 0}
                title="Select multiple recordings to remove at once"
              >
                <CheckSquare size={16} /> Select
              </button>
            )}
            <button onClick={() => setShowAddPopup(true)}>
              <Plus size={16} /> Add
            </button>
          </div>
        </div>

        <BackfillStatusBanner puuids={settings.accounts.map((a) => a.puuid)} />

        {bulkProgress && <p className="status add-media-progress">{bulkProgress}</p>}

        {loading ? (
          <p className="subtitle">Loading...</p>
        ) : videos.length === 0 ? (
          <p className="subtitle">
            No recordings yet. Click &quot;Add&quot; to import a video or link a folder.
          </p>
        ) : filteredVideos.length === 0 ? (
          // An empty filtered list must always offer its own way out --
          // otherwise fixing every flagged video leaves you staring at
          // nothing with no obvious escape.
          <div className="empty-state">
            <p className="subtitle">
              {showOnlySuspicious
                ? 'No recordings have bad bookmarks anymore. Nicely done.'
                : 'No recordings match the current filters.'}
            </p>
            <div className="empty-state-actions">
              {showOnlySuspicious && (
                <button onClick={() => setShowOnlySuspicious(false)}>
                  Show all recordings
                </button>
              )}
              {hasAnyFilter && (
                <button className="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="match-tile-list">
            {filteredVideos.map((video) => (
              <MatchTile
                key={video.id}
                video={video}
                stats={statsByVideo.get(video.id)}
                suspiciousLink={suspiciousVideoIds.has(video.id)}
                lastViewed={video.id === lastViewedVideoId}
                selectMode={selectMode}
                selected={selectedIds.has(video.id)}
                onOpen={() => (selectMode ? toggleSelected(video.id) : openVideo(video.id))}
                onLink={() => setLinkingVideoId(video.id)}
                onRemove={() => handleRemove(video.id)}
                onToggleFavorite={(next) => handleToggleFavorite(video.id, next)}
                onToggleSelect={() => toggleSelected(video.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="library-column library-column--side">
        <FilterPanel filters={filters} onChange={setFilters} />
        {leadSwingLoading && (
          <p className="subtitle filter-leadswing-loading">Checking lead swing data...</p>
        )}
      </div>

      {showAddPopup && (
        <AddMediaPopup onClose={() => setShowAddPopup(false)} onImported={refresh} />
      )}

      {showLinkScope && (
        <div className="settings-panel-overlay" onClick={() => setShowLinkScope(false)}>
          <div className="add-media-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-panel-header">
              <h3>Which recordings should be linked?</h3>
            </div>
            <p className="subtitle">
              Linking searches your match history for the game each recording belongs to. Re-linking
              an already-linked recording is safe -- it re-checks the match and regenerates the
              bookmarks, which is how a wrong match or mistimed bookmarks get fixed.
            </p>

            <div className="link-scope-options">
              <button
                className="add-media-option"
                onClick={() => runLinking('unlinked')}
                disabled={unlinkedCount === 0}
              >
                <Link2 size={24} />
                <span className="add-media-option-title">Only unlinked ({unlinkedCount})</span>
                <span className="add-media-option-hint">
                  Recordings with no match attached yet. Leaves existing links untouched.
                </span>
              </button>

              <button
                className="add-media-option"
                onClick={() => runLinking('suspicious')}
                disabled={suspiciousVideoIds.size === 0}
              >
                <AlertTriangle size={24} />
                <span className="add-media-option-title">
                  Only bad bookmarks ({suspiciousVideoIds.size})
                </span>
                <span className="add-media-option-hint">
                  Recordings flagged because every bookmark landed at 0:00 -- usually a wrong match.
                </span>
              </button>

              <button className="add-media-option" onClick={() => runLinking('all')}>
                <Wrench size={24} />
                <span className="add-media-option-title">
                  Everything ({videos.length})
                </span>
                <span className="add-media-option-hint">
                  Re-check every recording, including ones already linked. Slowest, but catches
                  matches that were attributed to the wrong game.
                </span>
              </button>
            </div>

            <div className="settings-panel-footer">
              <button className="secondary" onClick={() => setShowLinkScope(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearCacheConfirm && (
        <div
          className="settings-panel-overlay"
          onClick={clearingCache ? undefined : () => setShowClearCacheConfirm(false)}
        >
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-panel-header">
              <h3>Clear downloaded match data?</h3>
            </div>
            <p className="subtitle">
              This deletes LeagueVid&apos;s local copy of your Riot match data
              {cacheCount !== null && ` (${cacheCount} file${cacheCount === 1 ? '' : 's'})`} and
              restarts the background download from scratch. Use this if match info looks wrong or
              out of date.
            </p>
            <p className="subtitle">
              Your recordings, bookmarks, and existing match links are kept. Re-downloading takes a
              while and is subject to Riot&apos;s rate limits, so only do this if you need to.
            </p>
            <div className="settings-panel-footer">
              <button
                className="secondary"
                onClick={() => setShowClearCacheConfirm(false)}
                disabled={clearingCache}
              >
                Cancel
              </button>
              <button className="danger-button" onClick={handleClearCache} disabled={clearingCache}>
                {clearingCache ? 'Clearing...' : 'Clear match data'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkDeleteConfirm && (
        <div
          className="settings-panel-overlay"
          onClick={bulkDeleting ? undefined : () => setShowBulkDeleteConfirm(false)}
        >
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-panel-header">
              <h3>Remove {selectedIds.size} selected recording{selectedIds.size === 1 ? '' : 's'}?</h3>
            </div>
            <p className="subtitle">
              This removes the selected recordings from LeagueVid, along with their bookmarks and
              match links. Video files on disk won&apos;t be touched.
            </p>
            <div className="settings-panel-footer">
              <button
                className="secondary"
                onClick={() => setShowBulkDeleteConfirm(false)}
                disabled={bulkDeleting}
              >
                Cancel
              </button>
              <button className="danger-button" onClick={handleBulkDelete} disabled={bulkDeleting}>
                {bulkDeleting ? 'Removing...' : 'Remove selected'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showRemoveAllConfirm && (
        <div
          className="settings-panel-overlay"
          onClick={removingAll ? undefined : () => setShowRemoveAllConfirm(false)}
        >
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-panel-header">
              <h3>Remove all recordings?</h3>
            </div>
            <p className="subtitle">
              This removes all {videos.length} recording{videos.length === 1 ? '' : 's'} from
              LeagueVid, along with their bookmarks and match links. Your video files on disk
              won&apos;t be touched -- you can re-import them (e.g. by re-linking their folder)
              afterward.
            </p>
            <div className="settings-panel-footer">
              <button className="secondary" onClick={() => setShowRemoveAllConfirm(false)} disabled={removingAll}>
                Cancel
              </button>
              <button className="danger-button" onClick={handleRemoveAll} disabled={removingAll}>
                {removingAll ? 'Removing...' : 'Remove all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Library
