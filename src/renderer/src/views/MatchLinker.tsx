import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, MatchPickerSummary, VideoRow } from '../../../shared/types'
import {
  findBestMatch,
  getClaimedMatchIds,
  linkVideoToMatch,
  loadCachedMatchPool,
  searchMatchesForVideo
} from '../lib/autoLinkVideo'
import Autocomplete from '../components/Autocomplete'
import { useDDragon, championOptions, championDisplayName } from '../lib/useDDragon'

// 'auto': search around the video's file date and immediately link the
// best-fitting match if one genuinely overlaps the recording's timeframe.
// 'manual': never auto-links. Loads every match already downloaded locally
// and lets the user filter it by champion/kills/deaths/lane opponent.
// Manual exists specifically for when the file date is wrong or
// auto-matching picked the wrong game, so it deliberately ignores dates
// entirely rather than anchoring to one.
export type LinkMode = 'auto' | 'manual'

interface MatchLinkerProps {
  video: VideoRow
  settings: AppSettings
  mode: LinkMode
  onDone: () => void
  onCancel: () => void
}

interface ManualFilters {
  kills: string
  deaths: string
  enemyLaner: string
  championPlayed: string
}

const EMPTY_MANUAL_FILTERS: ManualFilters = {
  kills: '',
  deaths: '',
  enemyLaner: '',
  championPlayed: ''
}

function formatGameStart(ts: number): string {
  return new Date(ts).toLocaleString()
}

function formatDuration(seconds: number): string {
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

function MatchLinker({ video, settings, mode, onDone, onCancel }: MatchLinkerProps): JSX.Element {
  const [matches, setMatches] = useState<MatchPickerSummary[]>([])
  const [claimedMatchIds, setClaimedMatchIds] = useState<Set<string>>(new Set())
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchStatus, setSearchStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const [autoMatchId, setAutoMatchId] = useState<string | null>(null)
  const [autoLinkAttempted, setAutoLinkAttempted] = useState(false)
  const [manualFilters, setManualFilters] = useState<ManualFilters>(EMPTY_MANUAL_FILTERS)

  const ddragon = useDDragon()
  const champOptions = useMemo(() => (ddragon ? championOptions(ddragon) : []), [ddragon])

  // Claimed match ids are needed in both modes (to warn about / avoid
  // double-linking), and are cheap to load, so fetch them regardless.
  useEffect(() => {
    let cancelled = false
    getClaimedMatchIds(video.id).then((claimed) => {
      if (!cancelled) setClaimedMatchIds(claimed)
    })
    return () => {
      cancelled = true
    }
  }, [video.id])

  // MANUAL mode: load the locally-downloaded match pool up front. This is a
  // local DB read, not a Riot search -- it can't rate-limit or fail the way
  // the old date-windowed search could, so there's no reason to make the
  // user click a button before seeing anything to filter.
  useEffect(() => {
    if (mode !== 'manual') return
    loadManualPool()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settings])

  // AUTO mode only: search Riot around the video's file date on mount.
  useEffect(() => {
    if (mode !== 'auto') return

    let cancelled = false

    async function runAutoSearch(): Promise<void> {
      setSearching(true)
      setError(null)
      try {
        const claimed = await getClaimedMatchIds(video.id)
        if (cancelled) return

        const fetched = await searchMatchesForVideo(video, settings, (msg) => {
          if (!cancelled) setSearchStatus(msg)
        })
        if (cancelled) return

        setMatches(fetched)
        const best = findBestMatch(fetched, video, claimed)
        if (best) setAutoMatchId(best.matchId)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) {
          setSearching(false)
          setHasSearched(true)
          setSearchStatus(null)
        }
      }
    }

    runAutoSearch()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settings, video.recorded_at])

  useEffect(() => {
    if (mode === 'auto' && autoMatchId && !autoLinkAttempted) {
      setAutoLinkAttempted(true)
      setSelectedMatchId(autoMatchId)
      handleLink(autoMatchId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, autoMatchId])

  async function loadManualPool(): Promise<void> {
    setSearching(true)
    setError(null)
    setSearchStatus('Loading your downloaded match history...')
    try {
      const pool = await loadCachedMatchPool(settings)
      setMatches(pool)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSearching(false)
      setHasSearched(true)
      setSearchStatus(null)
    }
  }

  async function handleLink(matchId: string): Promise<void> {
    const match = matches.find((m) => m.matchId === matchId)
    if (!match) {
      setError('Could not find that match anymore. Try searching again.')
      return
    }

    setLinking(true)
    setError(null)
    try {
      await linkVideoToMatch(video, match)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLinking(false)
    }
  }

  const manualFiltersActive =
    !!manualFilters.kills ||
    !!manualFilters.deaths ||
    !!manualFilters.enemyLaner ||
    !!manualFilters.championPlayed

  // Filters apply client-side over whatever the search returned, so they can
  // be adjusted freely without re-hitting the API.
  const visibleMatches = useMemo(() => {
    if (mode !== 'manual') return matches
    return matches.filter((m) => {
      if (manualFilters.kills && String(m.kills) !== manualFilters.kills.trim()) return false
      if (manualFilters.deaths && String(m.deaths) !== manualFilters.deaths.trim()) return false
      if (manualFilters.enemyLaner && m.enemyChampionName !== manualFilters.enemyLaner) return false
      if (manualFilters.championPlayed && m.championName !== manualFilters.championPlayed) {
        return false
      }
      return true
    })
  }, [mode, matches, manualFilters])

  const filteredOutCount = matches.length - visibleMatches.length

  return (
    <div className="view">
      <div className="view-header">
        <h2>Link &quot;{video.file_name}&quot; to a match</h2>
        <button className="secondary" onClick={onCancel} disabled={linking}>
          Back
        </button>
      </div>

      <p className="subtitle">
        {mode === 'manual'
          ? 'Filter your downloaded match history by champion, kills, deaths, or lane opponent to find the right game. Nothing is linked until you pick one.'
          : autoMatchId
            ? 'LeagueVid matched this recording to a game automatically based on when the file was created. If it picked the wrong one, choose the correct match below.'
            : 'Pick the match that corresponds to this recording. LeagueVid will pull kills, deaths, assists, and objectives from Riot and generate timestamped bookmarks automatically.'}
      </p>

      {mode === 'manual' && (
        <>
          <div className="manual-relink-filters">
            <div className="filter-row">
              <label htmlFor="manual-relink-champ">Champion I played</label>
              <Autocomplete
                id="manual-relink-champ"
                placeholder="any"
                value={manualFilters.championPlayed}
                displayValue={
                  ddragon && manualFilters.championPlayed
                    ? championDisplayName(ddragon, manualFilters.championPlayed)
                    : undefined
                }
                options={champOptions}
                onChange={(value) => setManualFilters((f) => ({ ...f, championPlayed: value }))}
              />
            </div>
            <div className="filter-row">
              <label htmlFor="manual-relink-laner">My lane opponent</label>
              <Autocomplete
                id="manual-relink-laner"
                placeholder="any"
                value={manualFilters.enemyLaner}
                displayValue={
                  ddragon && manualFilters.enemyLaner
                    ? championDisplayName(ddragon, manualFilters.enemyLaner)
                    : undefined
                }
                options={champOptions}
                onChange={(value) => setManualFilters((f) => ({ ...f, enemyLaner: value }))}
              />
            </div>
            <div className="filter-row">
              <label htmlFor="manual-relink-kills">My kills</label>
              <input
                id="manual-relink-kills"
                type="number"
                min={0}
                placeholder="any"
                value={manualFilters.kills}
                onChange={(e) => setManualFilters((f) => ({ ...f, kills: e.target.value }))}
              />
            </div>
            <div className="filter-row">
              <label htmlFor="manual-relink-deaths">My deaths</label>
              <input
                id="manual-relink-deaths"
                type="number"
                min={0}
                placeholder="any"
                value={manualFilters.deaths}
                onChange={(e) => setManualFilters((f) => ({ ...f, deaths: e.target.value }))}
              />
            </div>
            <div className="manual-relink-actions">
              {manualFiltersActive && (
                <button
                  className="link-button"
                  onClick={() => setManualFilters(EMPTY_MANUAL_FILTERS)}
                >
                  Clear filters
                </button>
              )}
              <button
                className="link-button"
                onClick={loadManualPool}
                disabled={searching || linking}
                title="Re-read the locally downloaded match history"
              >
                {searching ? 'Reloading...' : 'Reload match list'}
              </button>
            </div>
          </div>
        </>
      )}

      {error && <p className="status status-error">{error}</p>}

      {searching ? (
        <p className="subtitle">{searchStatus ?? 'Searching your match history...'}</p>
      ) : matches.length === 0 && hasSearched ? (
        <div className="match-linker-empty">
          <p className="subtitle">
            {mode === 'manual'
              ? 'No match history has been downloaded locally yet for your linked account(s). It downloads in the background while the app is open (see the banner on the recordings page) -- give it a few minutes, then hit "Reload match list". If it stays empty, check that the right accounts are linked in Settings.'
              : 'No matches found within 2 years of this recording\u2019s file date. If the file date doesn\u2019t reflect when the game was actually played, use Re-link \u2192 Manual re-link to filter your history directly.'}
          </p>
        </div>
      ) : visibleMatches.length === 0 ? (
        <p className="subtitle">
          All {matches.length} match{matches.length === 1 ? '' : 'es'} found were excluded by your
          filters. Loosen or clear them to see the full list.
        </p>
      ) : (
        <>
          <p className="subtitle">
            Showing {visibleMatches.length} of {matches.length} match
            {matches.length === 1 ? '' : 'es'}
            {filteredOutCount > 0 && ` (${filteredOutCount} hidden by filters)`}.
          </p>
          <ul className="match-list">
            {visibleMatches.map((m) => {
              const isClaimedByOther = claimedMatchIds.has(m.matchId)
              return (
                <li key={m.matchId} className="match-item">
                  <div className="match-item-info">
                    <span className="match-champion">
                      {ddragon ? championDisplayName(ddragon, m.championName) : m.championName}
                      {m.matchId === autoMatchId && (
                        <span className="auto-match-badge">Auto-matched</span>
                      )}
                      {isClaimedByOther && (
                        <span className="auto-match-badge auto-match-badge--warning">
                          Already linked elsewhere
                        </span>
                      )}
                    </span>
                    <span className="match-meta">
                      {m.kills}/{m.deaths}/{m.assists} &middot; {m.win ? 'Win' : 'Loss'} &middot;{' '}
                      {formatDuration(m.gameDuration)}
                      {m.enemyChampionName &&
                        ` \u00b7 vs ${
                          ddragon
                            ? championDisplayName(ddragon, m.enemyChampionName)
                            : m.enemyChampionName
                        }`}
                    </span>
                    <span className="match-meta">
                      {formatGameStart(m.gameStartTimestamp)}
                      {settings.accounts.length > 1 && ` \u00b7 ${m.accountLabel}`}
                    </span>
                  </div>
                  <button
                    disabled={linking}
                    onClick={() => {
                      setSelectedMatchId(m.matchId)
                      handleLink(m.matchId)
                    }}
                  >
                    {linking && selectedMatchId === m.matchId ? 'Linking...' : 'Link this match'}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

export default MatchLinker
