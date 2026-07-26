import { Check, Clock, Star, X } from 'lucide-react'
import type { MatchRosterData, RosterParticipant, VideoRow } from '../../../shared/types'
import {
  useDDragon,
  championIconUrl,
  itemIconUrl,
  summonerSpellIconUrl,
  runeIconUrl,
  championDisplayName
} from '../lib/useDDragon'

interface MatchTileProps {
  video: VideoRow
  // True when every auto-generated bookmark on this video is clamped to
  // 0:00 -- the signature of a video linked to the wrong match (see
  // findVideosWithSuspiciousBookmarks). Surfaced so a bad link can be
  // spotted at a glance instead of only noticing once you open the player.
  suspiciousLink?: boolean
  // True for the tile matching whichever video was most recently opened in
  // the player -- lets you spot where you left off in a long list.
  lastViewed?: boolean
  // Library-wide multi-select mode: shows a checkbox instead of the normal
  // link/remove actions, and clicking the tile body toggles selection
  // instead of opening the player.
  selectMode?: boolean
  selected?: boolean
  onOpen: () => void
  onLink: () => void
  onRemove: () => void
  onToggleFavorite?: (next: boolean) => void
  onToggleSelect?: () => void
}

// Item slots always rendered, so the grid keeps a stable shape whether or
// not the player filled every slot (6 items + trinket).
const ITEM_SLOT_COUNT = 7

function formatDuration(ms: number | null): string {
  if (!ms) return '--:--'
  const totalSeconds = Math.round(ms / 1000)
  const mm = Math.floor(totalSeconds / 60)
  const ss = totalSeconds % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

function timeAgo(ms: number | null): string {
  if (!ms) return 'Unknown date'
  const diffMs = Date.now() - ms
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 60) return `${Math.max(diffMins, 0)}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30) return `${diffDays}d ago`
  return new Date(ms).toLocaleDateString()
}

function friendlyGameMode(gameMode: string | null): string {
  if (!gameMode) return 'Match'
  if (gameMode === 'CLASSIC') return 'Summoner\u2019s Rift'
  if (gameMode === 'ARAM') return 'ARAM'
  if (gameMode === 'URF') return 'URF'
  if (gameMode === 'CHERRY') return 'Arena'
  return gameMode
}

function parseRoster(matchData: string | null): MatchRosterData | null {
  if (!matchData) return null
  try {
    return JSON.parse(matchData) as MatchRosterData
  } catch {
    return null
  }
}

function RosterColumn({
  players,
  ddragon
}: {
  players: RosterParticipant[]
  ddragon: ReturnType<typeof useDDragon>
}): JSX.Element {
  return (
    <div className="match-tile-roster-list">
      {players.map((p) => {
        const name = ddragon ? championDisplayName(ddragon, p.championName) : p.championName
        return (
          <div
            key={p.puuid}
            className={`match-tile-roster-row ${p.isMe ? 'match-tile-roster-row--me' : ''}`}
          >
            <img
              className="match-tile-roster-icon"
              src={(ddragon && championIconUrl(ddragon, p.championName)) || undefined}
              alt={name}
            />
            {/* title carries the untruncated name, since the label is
                ellipsised at medium widths and hidden entirely at narrow. */}
            <span className="match-tile-roster-name" title={name}>
              {name}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function MatchTile({
  video,
  suspiciousLink,
  lastViewed,
  selectMode,
  selected,
  onOpen,
  onLink,
  onRemove,
  onToggleFavorite,
  onToggleSelect
}: MatchTileProps): JSX.Element {
  const ddragon = useDDragon()
  const roster = parseRoster(video.match_data)
  const isWin = video.win === 1
  const isLinked = video.match_id !== null

  const durationSeconds = video.duration_ms ? video.duration_ms / 1000 : null
  const csPerMin =
    video.cs !== null && durationSeconds ? (video.cs / (durationSeconds / 60)).toFixed(1) : null
  const kdaRatio =
    video.kills !== null && video.deaths !== null && video.assists !== null
      ? video.deaths === 0
        ? 'Perfect'
        : ((video.kills + video.assists) / video.deaths).toFixed(2)
      : null

  const myItems = roster?.allies.find((p) => p.isMe)?.items ?? []

  return (
    <div
      className={`match-tile ${isWin ? 'match-tile--win' : video.match_id ? 'match-tile--loss' : ''} ${
        lastViewed ? 'match-tile--last-viewed' : ''
      } ${selected ? 'match-tile--selected' : ''}`}
    >
      <div className="match-tile-stripe" />

      {selectMode && (
        <button
          className={`match-tile-select-checkbox ${selected ? 'match-tile-select-checkbox--checked' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect?.()
          }}
          aria-pressed={selected}
          aria-label={selected ? 'Deselect recording' : 'Select recording'}
        >
          {selected && <Check size={13} />}
        </button>
      )}

      {/* Pinned to a fixed corner (not inline with the other toprow badges)
          so it's always in the same, predictable spot regardless of what
          else that row is showing -- and shown for unlinked videos too,
          since there's no reason favoriting should require a match link. */}
      {!selectMode && onToggleFavorite && (
        <button
          type="button"
          className={`match-tile-favorite-btn ${video.is_favorite ? 'match-tile-favorite-btn--active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(!video.is_favorite)
          }}
          aria-pressed={!!video.is_favorite}
          title={video.is_favorite ? 'Unfavorite' : 'Mark as favorite'}
        >
          <Star size={15} fill={video.is_favorite ? 'currentColor' : 'none'} />
        </button>
      )}

      <button className="match-tile-body" onClick={onOpen}>
        {isLinked ? (
          <>
            <div className="match-tile-toprow">
              <span className="match-tile-mode">{friendlyGameMode(video.game_mode)}</span>
              {video.gold_diff !== null && video.enemy_champion_name && (
                <span className="match-tile-meta">
                  vs{' '}
                  {ddragon
                    ? championDisplayName(ddragon, video.enemy_champion_name)
                    : video.enemy_champion_name}{' '}
                  <span className={video.gold_diff >= 0 ? 'gold-positive' : 'gold-negative'}>
                    ({video.gold_diff >= 0 ? '+' : ''}
                    {video.gold_diff}g)
                  </span>
                </span>
              )}
              <span className="match-tile-meta match-tile-toprow-time">
                <Clock size={12} /> {timeAgo(video.recorded_at)}
              </span>
              {suspiciousLink && (
                <span
                  className="auto-match-badge auto-match-badge--warning"
                  title="All bookmarks landed at 0:00 -- this usually means the video got linked to the wrong match. Try Re-link."
                >
                  Bookmarks look wrong
                </span>
              )}
            </div>

            {/* Region order is fixed (U.GG-style) so every tile's columns
                line up down the list: result, champion+loadout, KDA, items,
                rosters, with the roster region absorbing slack. */}
            <div className="match-tile-main">
              <div className="match-tile-region match-tile-summary">
                <span className={`match-tile-result ${isWin ? 'result-win' : 'result-loss'}`}>
                  {isWin ? 'WIN' : 'LOSS'}
                </span>
                <span className="match-tile-duration">{formatDuration(video.duration_ms)}</span>
              </div>

              <div className="match-tile-region match-tile-champ-block">
                <div className="match-tile-champ-icon-wrap">
                  {ddragon && video.champion_name && championIconUrl(ddragon, video.champion_name) && (
                    <img
                      className="match-tile-champ-icon"
                      src={championIconUrl(ddragon, video.champion_name) ?? undefined}
                      alt={championDisplayName(ddragon, video.champion_name)}
                    />
                  )}
                </div>
                <div className="match-tile-loadout">
                  <div className="match-tile-loadout-row">
                    {ddragon && video.summoner1_id && (
                      <img
                        className="match-tile-mini-icon"
                        src={summonerSpellIconUrl(ddragon, video.summoner1_id) ?? undefined}
                        alt=""
                      />
                    )}
                    {ddragon && video.summoner2_id && (
                      <img
                        className="match-tile-mini-icon"
                        src={summonerSpellIconUrl(ddragon, video.summoner2_id) ?? undefined}
                        alt=""
                      />
                    )}
                  </div>
                  <div className="match-tile-loadout-row">
                    {ddragon && video.keystone_id && (
                      <img
                        className="match-tile-mini-icon match-tile-mini-icon--rune"
                        src={runeIconUrl(ddragon, video.keystone_id) ?? undefined}
                        alt=""
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="match-tile-region match-tile-stats">
                <span className="match-tile-kda">{video.kda}</span>
                <span className="match-tile-stats-secondary">
                  {kdaRatio && <span>{kdaRatio} KDA</span>}
                  {csPerMin && (
                    <span>
                      {video.cs} CS ({csPerMin}/min)
                    </span>
                  )}
                </span>
              </div>

              {ddragon && (
                <div className="match-tile-region match-tile-items">
                  {Array.from({ length: ITEM_SLOT_COUNT }, (_, i) => {
                    const itemId = myItems[i]
                    const url = itemId ? itemIconUrl(ddragon, itemId) : null
                    return (
                      <div key={i} className="match-tile-item-slot">
                        {url && <img src={url} alt="" />}
                      </div>
                    )
                  })}
                </div>
              )}

              {roster && (
                <div className="match-tile-region match-tile-rosters">
                  <RosterColumn players={roster.allies} ddragon={ddragon} />
                  <RosterColumn players={roster.enemies} ddragon={ddragon} />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="match-tile-unlinked">
            <span className="video-name" title={video.file_name}>
              {video.file_name}
            </span>
            <span className="match-tile-meta">{timeAgo(video.recorded_at)}</span>
            <span className="video-tags-unlinked">Not linked to a match</span>
          </div>
        )}
      </button>

      {!selectMode && (
        <div className="match-tile-actions">
          <button
            className="secondary match-tile-link-btn"
            onClick={(e) => {
              e.stopPropagation()
              onLink()
            }}
          >
            {isLinked ? 'Re-link' : 'Link match'}
          </button>
          <button
            className="player-icon-btn match-tile-remove-btn"
            onClick={(e) => {
              e.stopPropagation()
              if (
                window.confirm(
                  `Remove "${video.file_name}" from LeagueVid? This won't delete the file.`
                )
              ) {
                onRemove()
              }
            }}
            title="Remove from library"
            aria-label="Remove from library"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

export default MatchTile
