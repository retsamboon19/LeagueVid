import { memo } from 'react'
import type { DDragonBundle, MatchStats, StatsParticipant } from '../../../../shared/types'
import { MULTIKILL_LABELS } from '../../../../shared/types'
import { championDisplayName, championIconUrl } from '../../lib/useDDragon'
import { formatCompactNumber, kdaRatioText } from './statsFormat'

// Shared with the player's badge styling, keyed by streak length.
const MULTIKILL_TYPE_BY_LENGTH: Record<number, string> = {
  2: 'doublekill',
  3: 'triplekill',
  4: 'quadrakill',
  5: 'pentakill'
}

const MULTIKILL_SHORT: Record<number, string> = { 2: '2x', 3: '3x', 4: '4x', 5: 'PENTA' }

interface ScoreboardTabProps {
  stats: MatchStats
  focusPuuid: string
  onSelectPlayer: (puuid: string) => void
  ddragon: DDragonBundle | null
}

function displayNameFor(p: StatsParticipant, ddragon: DDragonBundle | null): string {
  // Riot omits riotIdGameName on some older matches; the champion name is a
  // more useful fallback than an empty cell.
  if (p.displayName) return p.displayName
  return ddragon ? championDisplayName(ddragon, p.championName) : p.championName
}

function TeamBlock({
  stats,
  teamId,
  focusPuuid,
  onSelectPlayer,
  ddragon
}: {
  stats: MatchStats
  teamId: number
  focusPuuid: string
  onSelectPlayer: (puuid: string) => void
  ddragon: DDragonBundle | null
}): JSX.Element {
  const team = stats.teams.find((t) => t.teamId === teamId)
  const members = stats.participants.filter((p) => p.teamId === teamId)

  return (
    <div className={`scoreboard-team ${team?.win ? 'scoreboard-team--win' : 'scoreboard-team--loss'}`}>
      <div className="scoreboard-team-header">
        <span className={team?.win ? 'result-win' : 'result-loss'}>
          {team?.win ? 'Victory' : 'Defeat'}
        </span>
        <span className="scoreboard-team-totals">
          {team?.kills ?? 0} kills &middot; {formatCompactNumber(team?.goldEarned ?? 0)} gold
        </span>
      </div>

      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">K / D / A</th>
            <th scope="col">KDA</th>
            <th scope="col">CS</th>
            <th scope="col">Gold</th>
            <th scope="col">Damage</th>
            <th scope="col">Vision</th>
          </tr>
        </thead>
        <tbody>
          {members.map((p) => {
            const isOwner = p.puuid === stats.ownerPuuid
            const isFocus = p.puuid === focusPuuid
            return (
              <tr
                key={p.puuid}
                className={`${isOwner ? 'stats-row--owner' : ''} ${
                  isFocus ? 'stats-row--focus' : ''
                }`}
              >
                <th scope="row" className="stats-cell-player">
                  <button
                    className="stats-player-btn"
                    onClick={() => onSelectPlayer(p.puuid)}
                    title={`Show ${displayNameFor(p, ddragon)}'s details in the other tabs`}
                  >
                    {ddragon && championIconUrl(ddragon, p.championName) && (
                      <img
                        className="stats-champ-icon"
                        src={championIconUrl(ddragon, p.championName) ?? undefined}
                        alt={p.championName}
                      />
                    )}
                    <span className="stats-player-name">{displayNameFor(p, ddragon)}</span>
                    {/* Marked in text as well as styling, so the "this is me"
                        and "currently focused" states don't rely on colour. */}
                    {isOwner && <span className="stats-tag">You</span>}
                    {isFocus && !isOwner && <span className="stats-tag">Viewing</span>}
                  </button>
                </th>
                <td>
                  {p.kills} / {p.deaths} / {p.assists}
                  {/* Riot reports the largest streak directly, so this needs
                      no inference from the timeline. */}
                  {p.largestMultiKill >= 2 && (
                    <span
                      className={`multikill-badge multikill-badge--${MULTIKILL_TYPE_BY_LENGTH[Math.min(p.largestMultiKill, 5)]}`}
                      title={`Largest multikill: ${MULTIKILL_LABELS[Math.min(p.largestMultiKill, 5)]}`}
                    >
                      {MULTIKILL_SHORT[Math.min(p.largestMultiKill, 5)]}
                    </span>
                  )}
                </td>
                <td>{kdaRatioText(p)}</td>
                <td>{p.cs}</td>
                <td>{formatCompactNumber(p.goldEarned)}</td>
                <td>{formatCompactNumber(p.damageToChampions)}</td>
                <td>{p.visionScore}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ScoreboardTab({
  stats,
  focusPuuid,
  onSelectPlayer,
  ddragon
}: ScoreboardTabProps): JSX.Element {
  const focus = stats.participants.find((p) => p.puuid === focusPuuid)
  // Focus player's team first, so the side you're reviewing reads top-down.
  const orderedTeamIds = focus
    ? [focus.teamId, ...stats.teams.map((t) => t.teamId).filter((id) => id !== focus.teamId)]
    : stats.teams.map((t) => t.teamId)

  return (
    <div className="stats-tab-body">
      {orderedTeamIds.map((teamId) => (
        <TeamBlock
          key={teamId}
          stats={stats}
          teamId={teamId}
          focusPuuid={focusPuuid}
          onSelectPlayer={onSelectPlayer}
          ddragon={ddragon}
        />
      ))}
    </div>
  )
}

// Memoised: nothing here depends on playback position, so it should not
// re-render as the video plays.
export default memo(ScoreboardTab)
