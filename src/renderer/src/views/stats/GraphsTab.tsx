import { memo, useMemo, useState } from 'react'
import type {
  DDragonBundle,
  MatchStats,
  StatsParticipant,
  TimelineFrameStats
} from '../../../../shared/types'
import { championDisplayName, championIconUrl } from '../../lib/useDDragon'
import { formatCompactNumber, formatGameClock, formatSigned } from './statsFormat'

interface GraphsTabProps {
  stats: MatchStats
  focus: StatsParticipant
  laneOpponent: StatsParticipant | null
  /** Current playback position in game time, or null when unknown. */
  currentGameTimeMs: number | null
  /** Game time of a bookmark the user just selected, for a marker line. */
  markedGameTimeMs: number | null
  ddragon: DDragonBundle | null
}

type MetricKey = 'gold' | 'damage' | 'xp' | 'cs'

const METRICS: Array<{ key: MetricKey; label: string; unit: string }> = [
  { key: 'gold', label: 'Gold', unit: 'gold' },
  { key: 'damage', label: 'Damage', unit: 'damage to champions' },
  { key: 'xp', label: 'Exp', unit: 'experience' },
  { key: 'cs', label: 'CS', unit: 'creep score' }
]

function metricValue(frame: TimelineFrameStats, participantId: number, metric: MetricKey): number {
  const pf = frame.participants.find((p) => p.participantId === participantId)
  if (!pf) return 0
  switch (metric) {
    case 'gold':
      return pf.totalGold
    case 'damage':
      return pf.damageToChampions
    case 'xp':
      return pf.xp
    case 'cs':
      return pf.cs
  }
}

// Plot geometry. Drawn as inline SVG rather than pulling in a charting
// library: four line series over ~30 points is not worth a dependency, and
// hand-rolling keeps the axis labelling honest about game time.
const VIEW_W = 720
const VIEW_H = 260
const PAD_L = 52
const PAD_R = 12
const PAD_T = 12
const PAD_B = 28

const SERIES_COLORS = [
  '#4a90d9',
  '#6fcf9a',
  '#e0bd7f',
  '#c98bdb',
  '#ee8d89',
  '#7fd3d9',
  '#b6c26f',
  '#d98fb0',
  '#8f9ad9',
  '#d9a45a'
]

function GraphsTab({
  stats,
  focus,
  laneOpponent,
  currentGameTimeMs,
  markedGameTimeMs,
  ddragon
}: GraphsTabProps): JSX.Element {
  const [metric, setMetric] = useState<MetricKey>('gold')
  const [selectedIds, setSelectedIds] = useState<number[]>(() =>
    laneOpponent ? [focus.participantId, laneOpponent.participantId] : [focus.participantId]
  )
  const [hoverFrameIndex, setHoverFrameIndex] = useState<number | null>(null)
  const [tableOpen, setTableOpen] = useState(false)

  const frames = stats.frames
  const lastTimestamp = frames.length > 0 ? frames[frames.length - 1].timestampMs : 0

  const series = useMemo(() => {
    return selectedIds.map((participantId, i) => {
      const participant = stats.participants.find((p) => p.participantId === participantId)
      return {
        participantId,
        participant,
        color: SERIES_COLORS[i % SERIES_COLORS.length],
        points: frames.map((f) => metricValue(f, participantId, metric))
      }
    })
  }, [selectedIds, frames, metric, stats.participants])

  const maxValue = useMemo(() => {
    const all = series.flatMap((s) => s.points)
    return all.length > 0 ? Math.max(...all, 1) : 1
  }, [series])

  function xFor(index: number): number {
    if (frames.length <= 1) return PAD_L
    return PAD_L + (index / (frames.length - 1)) * (VIEW_W - PAD_L - PAD_R)
  }

  function yFor(value: number): number {
    return VIEW_H - PAD_B - (value / maxValue) * (VIEW_H - PAD_T - PAD_B)
  }

  function xForGameTime(ms: number): number | null {
    if (lastTimestamp <= 0) return null
    const ratio = Math.min(1, Math.max(0, ms / lastTimestamp))
    return PAD_L + ratio * (VIEW_W - PAD_L - PAD_R)
  }

  function togglePlayer(participantId: number): void {
    setSelectedIds((prev) =>
      prev.includes(participantId)
        ? prev.filter((id) => id !== participantId)
        : [...prev, participantId]
    )
  }

  if (frames.length === 0) {
    return (
      <div className="stats-tab-body">
        <p className="subtitle">
          Over-time graphs come from the match timeline, which hasn&apos;t been downloaded for this
          game yet. The background download will supply it.
        </p>
      </div>
    )
  }

  const focusSeries = series.find((s) => s.participantId === focus.participantId)
  const opponentSeries = laneOpponent
    ? series.find((s) => s.participantId === laneOpponent.participantId)
    : undefined

  const playbackX = currentGameTimeMs !== null ? xForGameTime(currentGameTimeMs) : null
  const markedX = markedGameTimeMs !== null ? xForGameTime(markedGameTimeMs) : null

  const hovered = hoverFrameIndex !== null ? frames[hoverFrameIndex] : null

  return (
    <div className="stats-tab-body">
      <div className="graph-controls">
        <div className="graph-metric-tabs" role="group" aria-label="Metric">
          {METRICS.map((m) => (
            <button
              key={m.key}
              className={`graph-metric-btn ${metric === m.key ? 'graph-metric-btn--active' : ''}`}
              onClick={() => setMetric(m.key)}
              aria-pressed={metric === m.key}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="graph-player-picker">
          {stats.participants.map((p) => {
            const active = selectedIds.includes(p.participantId)
            const name =
              p.displayName ??
              (ddragon ? championDisplayName(ddragon, p.championName) : p.championName)
            return (
              <button
                key={p.puuid}
                className={`graph-player-btn ${active ? 'graph-player-btn--active' : ''}`}
                onClick={() => togglePlayer(p.participantId)}
                title={`${active ? 'Hide' : 'Show'} ${name}`}
                aria-pressed={active}
              >
                {ddragon && championIconUrl(ddragon, p.championName) && (
                  <img src={championIconUrl(ddragon, p.championName) ?? undefined} alt={name} />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {!laneOpponent && (
        <p className="settings-row-hint">
          No lane opponent could be identified for this player, so only their own line is shown by
          default. Add any player above to compare.
        </p>
      )}

      <svg
        className="graph-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`${METRICS.find((m) => m.key === metric)?.label} over game time`}
        onMouseLeave={() => setHoverFrameIndex(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const ratio = (e.clientX - rect.left) / rect.width
          const svgX = ratio * VIEW_W
          const plotRatio = (svgX - PAD_L) / (VIEW_W - PAD_L - PAD_R)
          const index = Math.round(plotRatio * (frames.length - 1))
          setHoverFrameIndex(Math.min(frames.length - 1, Math.max(0, index)))
        }}
      >
        {/* horizontal gridlines + y axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const value = maxValue * t
          const y = yFor(value)
          return (
            <g key={t}>
              <line x1={PAD_L} x2={VIEW_W - PAD_R} y1={y} y2={y} className="graph-gridline" />
              <text x={PAD_L - 8} y={y + 4} className="graph-axis-label" textAnchor="end">
                {formatCompactNumber(Math.round(value))}
              </text>
            </g>
          )
        })}

        {/* x axis labels every ~5 minutes of game time */}
        {frames.map((frame, i) => {
          const minutes = Math.round(frame.timestampMs / 60000)
          if (minutes % 5 !== 0) return null
          return (
            <text
              key={i}
              x={xFor(i)}
              y={VIEW_H - 8}
              className="graph-axis-label"
              textAnchor="middle"
            >
              {minutes}m
            </text>
          )
        })}

        {markedX !== null && (
          <line
            x1={markedX}
            x2={markedX}
            y1={PAD_T}
            y2={VIEW_H - PAD_B}
            className="graph-marker-line graph-marker-line--bookmark"
          />
        )}
        {playbackX !== null && (
          <line
            x1={playbackX}
            x2={playbackX}
            y1={PAD_T}
            y2={VIEW_H - PAD_B}
            className="graph-marker-line graph-marker-line--playback"
          />
        )}

        {series.map((s) => (
          <polyline
            key={s.participantId}
            className="graph-line"
            stroke={s.color}
            points={s.points.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ')}
          />
        ))}

        {hoverFrameIndex !== null && (
          <line
            x1={xFor(hoverFrameIndex)}
            x2={xFor(hoverFrameIndex)}
            y1={PAD_T}
            y2={VIEW_H - PAD_B}
            className="graph-hover-line"
          />
        )}
      </svg>

      {hovered && (
        <div className="graph-readout">
          <strong>{formatGameClock(hovered.timestampMs)}</strong>
          {series.map((s) => {
            const name =
              s.participant?.displayName ??
              (ddragon && s.participant
                ? championDisplayName(ddragon, s.participant.championName)
                : String(s.participantId))
            return (
              <span key={s.participantId} className="graph-readout-item">
                <span className="graph-readout-swatch" style={{ background: s.color }} />
                {name}: {formatCompactNumber(s.points[hoverFrameIndex as number] ?? 0)}
              </span>
            )
          })}
        </div>
      )}

      {focusSeries && opponentSeries && (
        <p className="settings-row-hint">
          Difference vs lane opponent at{' '}
          {formatGameClock(frames[frames.length - 1].timestampMs)}:{' '}
          <strong>
            {formatSigned(
              (focusSeries.points[focusSeries.points.length - 1] ?? 0) -
                (opponentSeries.points[opponentSeries.points.length - 1] ?? 0)
            )}
          </strong>{' '}
          {METRICS.find((m) => m.key === metric)?.unit}
        </p>
      )}

      {/* Keyboard/screen-reader accessible equivalent of the plot: the same
          numbers as a table, so the graph isn't pointer-only.

          Rendered only while open. A 40-minute game has ~40 frames x up to 10
          columns, and building those rows on every playback tick (even while
          collapsed) was pure wasted work. */}
      <details className="graph-table-details" onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>View graph values as a table</summary>
        {tableOpen && (
        <table className="stats-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              {series.map((s) => (
                <th key={s.participantId} scope="col">
                  {s.participant?.displayName ??
                    (ddragon && s.participant
                      ? championDisplayName(ddragon, s.participant.championName)
                      : String(s.participantId))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {frames.map((frame, i) => (
              <tr key={i}>
                <th scope="row">{formatGameClock(frame.timestampMs)}</th>
                {series.map((s) => (
                  <td key={s.participantId}>{(s.points[i] ?? 0).toLocaleString()}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </details>
    </div>
  )
}

// Memoised so playback ticks only re-render this when something it actually
// displays changed (the marker positions), not on every parent render.
export default memo(GraphsTab)
