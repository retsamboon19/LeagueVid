import { memo, useMemo, useState } from 'react'
import type { DDragonBundle, MatchStats, StatsParticipant } from '../../../../shared/types'
import { championDisplayName, championIconUrl } from '../../lib/useDDragon'
import { formatCompactNumber, kdaRatioText, kdaRatioValue } from './statsFormat'

interface PerformanceTabProps {
  stats: MatchStats
  focusPuuid: string
  onSelectPlayer: (puuid: string) => void
  ddragon: DDragonBundle | null
}

type SortKey = 'kills' | 'kda' | 'damage' | 'gold' | 'wards' | 'cs'

interface ColumnDef {
  key: SortKey
  label: string
  value: (p: StatsParticipant) => number
  text: (p: StatsParticipant) => string
}

const COLUMNS: ColumnDef[] = [
  { key: 'kills', label: 'Kills', value: (p) => p.kills, text: (p) => String(p.kills) },
  { key: 'kda', label: 'KDA', value: kdaRatioValue, text: kdaRatioText },
  {
    key: 'damage',
    label: 'Damage',
    value: (p) => p.damageToChampions,
    text: (p) => formatCompactNumber(p.damageToChampions)
  },
  {
    key: 'gold',
    label: 'Gold',
    value: (p) => p.goldEarned,
    text: (p) => formatCompactNumber(p.goldEarned)
  },
  { key: 'wards', label: 'Wards', value: (p) => p.wardsPlaced, text: (p) => String(p.wardsPlaced) },
  { key: 'cs', label: 'CS', value: (p) => p.cs, text: (p) => String(p.cs) }
]

function PerformanceTab({
  stats,
  focusPuuid,
  onSelectPlayer,
  ddragon
}: PerformanceTabProps): JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('damage')
  const [descending, setDescending] = useState(true)

  // Bars are scaled against the highest value in the same column, so each
  // column reads as "share of the best performance in this game".
  const columnMaxima = useMemo(() => {
    const maxima: Partial<Record<SortKey, number>> = {}
    for (const col of COLUMNS) {
      const values = stats.participants
        .map(col.value)
        .filter((v) => Number.isFinite(v)) as number[]
      maxima[col.key] = values.length > 0 ? Math.max(...values) : 0
    }
    return maxima
  }, [stats.participants])

  const rows = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sortKey) ?? COLUMNS[0]
    return [...stats.participants].sort((a, b) => {
      const diff = col.value(a) - col.value(b)
      // Infinity - Infinity is NaN (two deathless players), so fall back to
      // kills to keep the comparator total.
      const safeDiff = Number.isNaN(diff) ? a.kills - b.kills : diff
      return descending ? -safeDiff : safeDiff
    })
  }, [stats.participants, sortKey, descending])

  function handleSort(key: SortKey): void {
    if (key === sortKey) {
      setDescending((d) => !d)
    } else {
      setSortKey(key)
      setDescending(true) // a new column starts on "best first"
    }
  }

  return (
    <div className="stats-tab-body">
      <table className="stats-table stats-table--performance">
        <thead>
          <tr>
            <th scope="col">Player</th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={
                  sortKey === col.key ? (descending ? 'descending' : 'ascending') : 'none'
                }
              >
                <button
                  className={`stats-sort-btn ${sortKey === col.key ? 'stats-sort-btn--active' : ''}`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && <span aria-hidden="true">{descending ? ' \u2193' : ' \u2191'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const isOwner = p.puuid === stats.ownerPuuid
            const isFocus = p.puuid === focusPuuid
            const name =
              p.displayName ?? (ddragon ? championDisplayName(ddragon, p.championName) : p.championName)
            return (
              <tr
                key={p.puuid}
                className={`${isOwner ? 'stats-row--owner' : ''} ${
                  isFocus ? 'stats-row--focus' : ''
                }`}
              >
                <th scope="row" className="stats-cell-player">
                  <button className="stats-player-btn" onClick={() => onSelectPlayer(p.puuid)}>
                    {ddragon && championIconUrl(ddragon, p.championName) && (
                      <img
                        className="stats-champ-icon"
                        src={championIconUrl(ddragon, p.championName) ?? undefined}
                        alt={p.championName}
                      />
                    )}
                    <span className="stats-player-name">{name}</span>
                    {isOwner && <span className="stats-tag">You</span>}
                  </button>
                </th>
                {COLUMNS.map((col) => {
                  const max = columnMaxima[col.key] ?? 0
                  const raw = col.value(p)
                  // A deathless KDA has no finite share of the maximum, so
                  // show it as a full bar rather than an invalid width.
                  const ratio =
                    max > 0 && Number.isFinite(raw) ? Math.min(1, raw / max) : raw === max ? 1 : 0
                  return (
                    <td key={col.key} className="stats-bar-cell">
                      <span className="stats-bar-value">{col.text(p)}</span>
                      {/* Bar sits inside its own inset track so adjacent
                          columns read as separate meters instead of merging
                          into one continuous line across the row. */}
                      <span className="stats-bar-track">
                        <span
                          className={`stats-bar ${
                            p.teamId === 100 ? 'stats-bar--blue' : 'stats-bar--red'
                          }`}
                          style={{ width: `${ratio * 100}%` }}
                        />
                      </span>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default memo(PerformanceTab)
