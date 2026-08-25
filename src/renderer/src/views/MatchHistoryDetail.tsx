import { ArrowLeft, Film } from 'lucide-react'
import type { AppSettings, MatchHistorySummary } from '../../../shared/types'
import { championDisplayName, useDDragon } from '../lib/useDDragon'
import MatchStatsPanel from './MatchStatsPanel'

interface MatchHistoryDetailProps {
  match: MatchHistorySummary
  settings: AppSettings
  onBack: () => void
}

function friendlyGameMode(gameMode: string): string {
  if (gameMode === 'CLASSIC') return 'Summoner\u2019s Rift'
  if (gameMode === 'ARAM') return 'ARAM'
  if (gameMode === 'URF') return 'URF'
  if (gameMode === 'CHERRY') return 'Arena'
  return gameMode
}

function MatchHistoryDetail({ match, settings, onBack }: MatchHistoryDetailProps): JSX.Element {
  const ddragon = useDDragon()
  // If two linked accounts shared this match, the clicked card's owner must
  // win MatchStatsPanel's "which account is me?" resolution.
  const accounts = [
    ...settings.accounts.filter((account) => account.puuid === match.puuid),
    ...settings.accounts.filter((account) => account.puuid !== match.puuid)
  ]
  const champion = ddragon
    ? championDisplayName(ddragon, match.championName)
    : match.championName

  return (
    <div className="match-history-detail">
      <div className="player-topbar match-history-detail-topbar">
        <button className="secondary" onClick={onBack}>
          <ArrowLeft size={15} /> Back to match history
        </button>
        <div className="player-title">
          <span className="player-filename">
            {champion} · {match.kills}/{match.deaths}/{match.assists}
          </span>
          <span className="player-subtitle">
            {friendlyGameMode(match.gameMode)} · {match.accountLabel} ·{' '}
            {new Date(match.gameStartTimestamp).toLocaleString()}
          </span>
        </div>
        <span className={`match-history-detail-result ${match.win ? 'result-win' : 'result-loss'}`}>
          {match.win ? 'Victory' : 'Defeat'}
        </span>
      </div>

      <div className="match-history-stat-only-note">
        <Film size={15} /> Match stats only · no recording is linked to this game
      </div>

      <MatchStatsPanel matchId={match.matchId} accounts={accounts} standalone />
    </div>
  )
}

export default MatchHistoryDetail
