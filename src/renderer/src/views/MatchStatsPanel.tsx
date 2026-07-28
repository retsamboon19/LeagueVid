import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, MatchStats, MatchStatsResult, TagRow, VideoRow } from '../../../shared/types'
import { championDisplayName, championIconUrl, useDDragon } from '../lib/useDDragon'
import AchievementsTab from './stats/AchievementsTab'
import ScoreboardTab from './stats/ScoreboardTab'
import PerformanceTab from './stats/PerformanceTab'
import BuildTab from './stats/BuildTab'
import GraphsTab from './stats/GraphsTab'
import InsightsTab from './stats/InsightsTab'
import ObjectiveTimeline from './stats/ObjectiveTimeline'
import {
  findLaneOpponent,
  formatCompactNumber,
  formatSigned,
  positionLabel
} from './stats/statsFormat'

interface MatchStatsPanelProps {
  video: VideoRow
  /**
   * Every linked account. The main process works out which one played this
   * match -- picking one here would be a guess when several are linked.
   */
  accounts: AppSettings['accounts']
  /** Playback position converted to game time, or null if not known yet. */
  currentGameTimeMs: number | null
  /** Game time of the most recently selected bookmark. */
  markedGameTimeMs: number | null
  onSeekGameTime: (gameTimeMs: number) => void
  /**
   * The video's auto-tags. Only the achievements tab uses these, for facts
   * LeagueVid derives at link time rather than from the match DTO (tower
   * dives). Optional so the panel still renders without them.
   */
  tags?: TagRow[]
}

type TabKey = 'achievements' | 'scoreboard' | 'performance' | 'build' | 'graphs' | 'insights'

// Achievements lead: it's the "what happened in this game" summary, so it
// reads as the landing view when a VOD is opened.
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'achievements', label: 'Achievements' },
  { key: 'scoreboard', label: 'Scoreboard' },
  { key: 'performance', label: 'Performance' },
  { key: 'build', label: 'Build' },
  { key: 'graphs', label: 'Graphs' },
  { key: 'insights', label: 'Insights' }
]

function isUnavailable(result: MatchStatsResult): result is { unavailable: true; reason: 'not-cached' } {
  return (result as { unavailable?: boolean }).unavailable === true
}

function MatchStatsPanel({
  video,
  accounts,
  currentGameTimeMs,
  markedGameTimeMs,
  onSeekGameTime,
  tags
}: MatchStatsPanelProps): JSX.Element {
  const [result, setResult] = useState<MatchStatsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('achievements')
  const [focusPuuid, setFocusPuuid] = useState<string | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const ddragon = useDDragon()

  useEffect(() => {
    if (!video.match_id || accounts.length === 0) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    window.api.riot
      .getMatchStats({
        matchId: video.match_id,
        accounts: accounts.map((a) => ({ platform: a.platform, puuid: a.puuid }))
      })
      .then((next) => {
        if (cancelled) return
        setResult(next)
        if (!isUnavailable(next)) setFocusPuuid(next.ownerPuuid)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.match_id, accounts.map((a) => a.puuid).join(',')])

  // Arrow-key navigation across the tab strip.
  function handleTabKeyDown(e: React.KeyboardEvent, index: number): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (index + delta + TABS.length) % TABS.length
    setActiveTab(TABS[nextIndex].key)
    tabRefs.current[nextIndex]?.focus()
  }

  if (!video.match_id) {
    return (
      <div className="stats-panel">
        <p className="subtitle">
          Match stats need this recording linked to a game. Use Re-link above to connect it.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="stats-panel">
        <p className="subtitle">Loading match stats...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="stats-panel">
        <p className="status status-error">{error}</p>
      </div>
    )
  }

  if (!result || isUnavailable(result)) {
    return (
      <div className="stats-panel">
        <p className="subtitle">
          This match&apos;s data hasn&apos;t been downloaded to your PC yet. The background download
          will pick it up while the app is open -- check the progress bar on the recordings page.
        </p>
      </div>
    )
  }

  const stats: MatchStats = result
  const focus =
    stats.participants.find((p) => p.puuid === focusPuuid) ??
    stats.participants.find((p) => p.puuid === stats.ownerPuuid) ??
    stats.participants[0]

  if (!focus) {
    return (
      <div className="stats-panel">
        <p className="subtitle">No participant data found in this match.</p>
      </div>
    )
  }

  const laneOpponent = findLaneOpponent(stats.participants, focus)
  const isViewingOther = focus.puuid !== stats.ownerPuuid
  const focusName =
    focus.displayName ?? (ddragon ? championDisplayName(ddragon, focus.championName) : focus.championName)

  return (
    <div className="stats-panel">
      <div className="stats-panel-head">
        <div className="stats-panel-focus">
          {ddragon && championIconUrl(ddragon, focus.championName) && (
            <img
              className="stats-champ-icon"
              src={championIconUrl(ddragon, focus.championName) ?? undefined}
              alt={focus.championName}
            />
          )}
          <div className="stats-panel-focus-text">
            <span className="stats-panel-focus-name">{focusName}</span>
            <span className="stats-panel-focus-meta">
              {ddragon ? championDisplayName(ddragon, focus.championName) : focus.championName}
              {focus.teamPosition && ` \u00b7 ${positionLabel(focus.teamPosition)}`}
            </span>
          </div>
        </div>

        {isViewingOther && (
          <div className="stats-panel-viewing">
            <span>Viewing another player</span>
            <button className="link-button" onClick={() => setFocusPuuid(stats.ownerPuuid)}>
              Back to me
            </button>
          </div>
        )}
      </div>

      <LaneComparisonStrip focus={focus} opponent={laneOpponent} ddragon={ddragon} />

      <div className="stats-tablist" role="tablist" aria-label="Match stats">
        {TABS.map((tab, i) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            role="tab"
            id={`stats-tab-${tab.key}`}
            aria-selected={activeTab === tab.key}
            aria-controls={`stats-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className={`stats-tab ${activeTab === tab.key ? 'stats-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
            onKeyDown={(e) => handleTabKeyDown(e, i)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className="stats-tabpanel"
        role="tabpanel"
        id={`stats-panel-${activeTab}`}
        aria-labelledby={`stats-tab-${activeTab}`}
      >
        {activeTab === 'achievements' && (
          <AchievementsTab stats={stats} focus={focus} tags={tags} />
        )}
        {activeTab === 'scoreboard' && (
          <ScoreboardTab
            stats={stats}
            focusPuuid={focus.puuid}
            onSelectPlayer={setFocusPuuid}
            ddragon={ddragon}
          />
        )}
        {activeTab === 'performance' && (
          <PerformanceTab
            stats={stats}
            focusPuuid={focus.puuid}
            onSelectPlayer={setFocusPuuid}
            ddragon={ddragon}
          />
        )}
        {activeTab === 'build' && (
          <BuildTab participant={focus} hasTimeline={stats.hasTimeline} ddragon={ddragon} />
        )}
        {activeTab === 'graphs' && (
          <GraphsTab
            stats={stats}
            focus={focus}
            laneOpponent={laneOpponent}
            currentGameTimeMs={currentGameTimeMs}
            markedGameTimeMs={markedGameTimeMs}
            ddragon={ddragon}
          />
        )}
        {activeTab === 'insights' && <InsightsTab stats={stats} focus={focus} />}
      </div>

      {stats.hasTimeline && (
        <ObjectiveTimeline
          objectives={stats.objectives}
          focusTeamId={focus.teamId}
          onSeekGameTime={onSeekGameTime}
        />
      )}
    </div>
  )
}

function LaneComparisonStrip({
  focus,
  opponent,
  ddragon
}: {
  focus: Parameters<typeof findLaneOpponent>[1]
  opponent: ReturnType<typeof findLaneOpponent>
  ddragon: ReturnType<typeof useDDragon>
}): JSX.Element {
  const metrics = useMemo(
    () =>
      [
        { label: 'CS', mine: focus.cs, theirs: opponent?.cs ?? null },
        { label: 'Gold', mine: focus.goldEarned, theirs: opponent?.goldEarned ?? null },
        {
          label: 'Damage',
          mine: focus.damageToChampions,
          theirs: opponent?.damageToChampions ?? null
        }
      ] as const,
    [focus, opponent]
  )

  if (!opponent) {
    return (
      <div className="lane-strip lane-strip--solo">
        <span className="settings-row-hint">
          No lane opponent identified for this match, so there&apos;s nothing to compare against.
        </span>
        <div className="lane-strip-metrics">
          {metrics.map((m) => (
            <span key={m.label} className="lane-strip-metric">
              <span className="lane-strip-metric-label">{m.label}</span>
              <span>{formatCompactNumber(m.mine)}</span>
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="lane-strip">
      <div className="lane-strip-champs">
        {ddragon && championIconUrl(ddragon, focus.championName) && (
          <img src={championIconUrl(ddragon, focus.championName) ?? undefined} alt="" />
        )}
        <span className="lane-strip-vs">vs</span>
        {ddragon && championIconUrl(ddragon, opponent.championName) && (
          <img src={championIconUrl(ddragon, opponent.championName) ?? undefined} alt="" />
        )}
      </div>
      <div className="lane-strip-metrics">
        {metrics.map((m) => {
          const diff = m.mine - (m.theirs ?? 0)
          const ahead = diff >= 0
          return (
            <span key={m.label} className="lane-strip-metric">
              <span className="lane-strip-metric-label">{m.label}</span>
              <span className="lane-strip-metric-values">
                {formatCompactNumber(m.mine)} / {formatCompactNumber(m.theirs ?? 0)}
              </span>
              {/* "ahead"/"behind" in text so the sign isn't colour-only. */}
              <span className={ahead ? 'gold-positive' : 'gold-negative'}>
                {formatSigned(diff)} {ahead ? 'ahead' : 'behind'}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

export default MatchStatsPanel
