import { useMemo } from 'react'
import { Check, Clock, Star, X } from 'lucide-react'
import type { MatchRosterData, MatchStats, RosterParticipant, VideoRow } from '../../../shared/types'
import { buildLiteMatchFacts, buildMatchFacts, selectAchievements } from '../lib/achievements'
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
  /**
   * Timeline-free stats for this match, when the library has loaded them.
   *
   * Optional on purpose: chips render immediately from the row's own data and
   * then sharpen once this arrives, so opening the library never waits on a
   * bulk cache read. With it, the tile can evaluate the vision, damage and
   * objective rules too, which is the difference between a chip that says
   * something and a generic one.
   */
  stats?: MatchStats
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

// Chips shown on a tile. The full Achievements tab shows up to six; a tile has
// far less room and is meant to be scannable at a glance, so it takes the
// highest-priority few and lets CSS hide any that don't fit the width.
const TILE_CHIP_LIMIT = 5

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
  stats,
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

  // Kill participation, from the roster snapshot's own team kill total. Shown
  // as a third stat column so the region has enough content to spread across a
  // wide tile rather than leaving a gap.
  const killParticipation = (() => {
    if (!roster || video.kills === null || video.assists === null) return null
    const teamKills = roster.allies.reduce((sum, p) => sum + p.kills, 0)
    if (teamKills <= 0) return null
    return Math.round(((video.kills + video.assists) / teamKills) * 100)
  })()

  const myItems = roster?.allies.find((p) => p.isMe)?.items ?? []

  // Achievement chips. Uses the bulk stats when the library has them (full rule
  // coverage bar the timeline ones), and falls back to the row's own data so
  // chips show up instantly rather than after a round trip.
  //
  // Fillers are excluded here: they exist to stop the player page's dedicated
  // panel from looking broken when it's near-empty, but on a tile a chip has to
  // mean something. With them on, over half of all tiles led with "Kept Farming"
  // or "Banked It", which is exactly the noise the panel's real rules avoid. A
  // tile with nothing notable shows no chips at all.
  const chips = useMemo(() => {
    const focus = stats?.participants.find((p) => p.puuid === stats.ownerPuuid)
    const facts =
      stats && focus
        ? buildMatchFacts({ stats, focus })
        : buildLiteMatchFacts({ video, roster })
    if (!facts) return []

    const selection = selectAchievements(facts, undefined, undefined, { includeFillers: false })
    return [...selection.positive, ...selection.negative].slice(0, TILE_CHIP_LIMIT)
  }, [video, roster, stats])

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
              {/* Gold difference lives in the stat columns now, so this is
                  just the matchup. */}
              {video.enemy_champion_name && (
                <span className="match-tile-meta">
                  vs{' '}
                  {ddragon
                    ? championDisplayName(ddragon, video.enemy_champion_name)
                    : video.enemy_champion_name}
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

              {/* Stat columns, mirroring a post-game scoreboard: each is its
                  own cell so this region can spread to absorb the tile's slack
                  width instead of leaving a gap before the rosters. */}
              <div className="match-tile-region match-tile-stats">
                <span className="match-tile-stat">
                  <span className="match-tile-stat-value match-tile-kda">{video.kda}</span>
                  {kdaRatio && (
                    <span className="match-tile-stat-sub">
                      {kdaRatio} <span className="match-tile-stat-label">KDA</span>
                    </span>
                  )}
                </span>

                {video.cs !== null && (
                  <span className="match-tile-stat">
                    <span className="match-tile-stat-value">
                      {video.cs}
                      {csPerMin && <span className="match-tile-stat-rate"> ({csPerMin})</span>}{' '}
                      <span className="match-tile-stat-label">CS</span>
                    </span>
                    {video.gold_diff !== null && (
                      <span className="match-tile-stat-sub">
                        <span
                          className={video.gold_diff >= 0 ? 'gold-positive' : 'gold-negative'}
                        >
                          {video.gold_diff >= 0 ? '+' : ''}
                          {video.gold_diff}g
                        </span>{' '}
                        <span className="match-tile-stat-label">vs lane</span>
                      </span>
                    )}
                  </span>
                )}

                {killParticipation !== null && (
                  <span className="match-tile-stat">
                    <span className="match-tile-stat-value match-tile-kp">
                      {killParticipation}%
                    </span>
                    <span className="match-tile-stat-sub">
                      <span className="match-tile-stat-label">KP</span>
                    </span>
                  </span>
                )}
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

            {chips.length > 0 && (
              <div className="match-tile-chips">
                {chips.map((chip) => (
                  <span
                    key={chip.id}
                    className={`match-chip match-chip--${chip.category}`}
                    title={chip.description}
                  >
                    {chip.title}
                  </span>
                ))}
              </div>
            )}
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
