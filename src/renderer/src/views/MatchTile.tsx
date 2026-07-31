import { memo, useMemo } from 'react'
import { Check, Clock, FolderOpen, Star, X } from 'lucide-react'
import { revealVideoInFolder } from '../lib/revealInFolder'
import type { MatchRosterData, MatchStats, RosterParticipant, VideoRow } from '../../../shared/types'
import type { EarnedAchievement } from '../lib/achievements'
import { parseRoster } from '../lib/libraryAchievements'
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
  /**
   * Achievement chips to show, already evaluated and trimmed.
   *
   * Passed in rather than computed here: the library needs every recording's
   * achievements anyway to back the achievement filter, and running ~75 rules
   * per tile per render made scrolling and typing in the filter box cost a full
   * pass over the rule set for every visible row. One evaluation per recording,
   * shared by the filter and the chips, is the same work done once.
   */
  chips?: EarnedAchievement[]
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
  // Every callback takes the video id rather than closing over it, so the
  // library can hand down one stable function per action instead of a fresh
  // closure per tile per render -- which is what lets memo() below actually
  // skip anything.
  onOpen: (videoId: number) => void
  onLink: (videoId: number) => void
  onRemove: (videoId: number) => void
  onToggleFavorite?: (videoId: number, next: boolean) => void
  onToggleSelect?: (videoId: number) => void
}

// Item slots always rendered, so the grid keeps a stable shape whether or
// not the player filled every slot (6 items + trinket).
const ITEM_SLOT_COUNT = 7

function formatCompact(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

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

/** One player line in the tile's scoreboard. */
interface ScoreboardEntry {
  key: string
  championName: string
  /** Summoner name when known, otherwise the champion's display name. */
  label: string
  /** "9/3/2", or null when per-player KDA isn't available. */
  kda: string | null
  isMe: boolean
}

/**
 * Builds both scoreboard columns.
 *
 * Prefers the bulk stats, which carry summoner names and every player's KDA --
 * the roster snapshot stored on the row only has champion names, so before the
 * stats land (or if the match isn't cached) the columns fall back to those.
 * That way the scoreboard is never empty, it just gains detail.
 */
function buildScoreboard(
  stats: MatchStats | undefined,
  roster: MatchRosterData | null,
  ddragon: ReturnType<typeof useDDragon>
): { allies: ScoreboardEntry[]; enemies: ScoreboardEntry[] } | null {
  const named = (championName: string): string =>
    ddragon ? championDisplayName(ddragon, championName) : championName

  if (stats) {
    const me = stats.participants.find((p) => p.puuid === stats.ownerPuuid)
    if (me) {
      const toEntry = (p: (typeof stats.participants)[number]): ScoreboardEntry => ({
        key: p.puuid || String(p.participantId),
        championName: p.championName,
        label: p.displayName ?? named(p.championName),
        kda: `${p.kills}/${p.deaths}/${p.assists}`,
        isMe: p.puuid === stats.ownerPuuid
      })
      return {
        allies: stats.participants.filter((p) => p.teamId === me.teamId).map(toEntry),
        enemies: stats.participants.filter((p) => p.teamId !== me.teamId).map(toEntry)
      }
    }
  }

  if (!roster) return null

  const toEntry = (p: RosterParticipant): ScoreboardEntry => ({
    key: p.puuid,
    championName: p.championName,
    label: named(p.championName),
    kda: `${p.kills}/${p.deaths}/${p.assists}`,
    isMe: p.isMe
  })
  return { allies: roster.allies.map(toEntry), enemies: roster.enemies.map(toEntry) }
}

function ScoreboardColumn({
  players,
  ddragon
}: {
  players: ScoreboardEntry[]
  ddragon: ReturnType<typeof useDDragon>
}): JSX.Element {
  return (
    <div className="match-tile-roster-list">
      {players.map((p) => (
        <div
          key={p.key}
          className={`match-tile-roster-row ${p.isMe ? 'match-tile-roster-row--me' : ''}`}
        >
          {/* Every icon in a tile is CSS-sized, so deferring the load and the
              decode can't shift the layout -- and there are twenty of them per
              tile across a list that can run to hundreds of rows. */}
          <img
            className="match-tile-roster-icon"
            src={(ddragon && championIconUrl(ddragon, p.championName)) || undefined}
            alt={p.championName}
            loading="lazy"
            decoding="async"
          />
          {/* title carries the untruncated label, since it's ellipsised at
              medium widths and hidden entirely at narrow. */}
          <span className="match-tile-roster-name" title={p.label}>
            {p.label}
          </span>
          {p.kda && <span className="match-tile-roster-kda">{p.kda}</span>}
        </div>
      ))}
    </div>
  )
}

function MatchTile({
  video,
  stats,
  chips,
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
  // JSON.parse of the stored roster snapshot, memoised on the raw string. It
  // used to run on every render, and because it produced a fresh object each
  // time it also invalidated every useMemo below that depends on it -- so the
  // one uncached parse quietly un-cached everything else too.
  const roster = useMemo(() => parseRoster(video.match_data), [video.match_data])
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

  const scoreboard = useMemo(
    () => buildScoreboard(stats, roster, ddragon),
    [stats, roster, ddragon]
  )

  // The focus player's full stat line, once the bulk stats have loaded. Backs
  // the damage/vision cells, which the row snapshot alone can't provide.
  const me = useMemo(
    () => stats?.participants.find((p) => p.puuid === stats.ownerPuuid),
    [stats]
  )

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
            onToggleSelect?.(video.id)
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
            onToggleFavorite(video.id, !video.is_favorite)
          }}
          aria-pressed={!!video.is_favorite}
          title={video.is_favorite ? 'Unfavorite' : 'Mark as favorite'}
        >
          <Star size={15} fill={video.is_favorite ? 'currentColor' : 'none'} />
        </button>
      )}

      <button className="match-tile-body" onClick={() => onOpen(video.id)}>
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
                      loading="lazy"
                      decoding="async"
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
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                    {ddragon && video.summoner2_id && (
                      <img
                        className="match-tile-mini-icon"
                        src={summonerSpellIconUrl(ddragon, video.summoner2_id) ?? undefined}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                  </div>
                  <div className="match-tile-loadout-row">
                    {ddragon && video.keystone_id && (
                      <img
                        className="match-tile-mini-icon match-tile-mini-icon--rune"
                        src={runeIconUrl(ddragon, video.keystone_id) ?? undefined}
                        alt=""
                        loading="lazy"
                        decoding="async"
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

                {/* Only rendered once the bulk stats arrive, and hidden by CSS
                    below ~1100px. These exist so a wide row fills with real
                    numbers instead of spreading three cells over whitespace. */}
                {me && (
                  <>
                    <span className="match-tile-stat match-tile-stat--wide">
                      <span className="match-tile-stat-value">
                        {formatCompact(me.damageToChampions)}
                      </span>
                      <span className="match-tile-stat-sub">
                        <span className="match-tile-stat-label">damage</span>
                      </span>
                    </span>
                    <span className="match-tile-stat match-tile-stat--wide">
                      <span className="match-tile-stat-value">{me.visionScore}</span>
                      <span className="match-tile-stat-sub">
                        <span className="match-tile-stat-label">vision</span>
                      </span>
                    </span>
                  </>
                )}
              </div>

              {ddragon && (
                <div className="match-tile-region match-tile-items">
                  {Array.from({ length: ITEM_SLOT_COUNT }, (_, i) => {
                    const itemId = myItems[i]
                    const url = itemId ? itemIconUrl(ddragon, itemId) : null
                    return (
                      <div key={i} className="match-tile-item-slot">
                        {url && <img src={url} alt="" loading="lazy" decoding="async" />}
                      </div>
                    )
                  })}
                </div>
              )}

              {scoreboard && (
                <div className="match-tile-region match-tile-rosters">
                  <ScoreboardColumn players={scoreboard.allies} ddragon={ddragon} />
                  <ScoreboardColumn players={scoreboard.enemies} ddragon={ddragon} />
                </div>
              )}
            </div>

            {chips && chips.length > 0 && (
              <div className="match-tile-chips">
                {chips.map((chip) => (
                  <span
                    key={chip.id}
                    className={`match-chip match-chip--${chip.category} match-chip--tier-${chip.tier.toLowerCase()}`}
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
              onLink(video.id)
            }}
          >
            {isLinked ? 'Re-link' : 'Link match'}
          </button>
          <button
            className="player-icon-btn"
            onClick={(e) => {
              e.stopPropagation()
              void revealVideoInFolder(video.file_path)
            }}
            title={`Show in folder: ${video.file_path}`}
            aria-label="Show this recording in its folder"
          >
            <FolderOpen size={14} />
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
                onRemove(video.id)
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

/**
 * Memoised because the library re-renders on every filter keystroke, favorite
 * toggle and stats arrival, and each tile is expensive: five nested regions,
 * two scoreboard columns, and around twenty icon images. Nothing about a tile
 * depends on library state beyond the props it's given, so a shallow compare is
 * enough -- provided the callbacks stay stable, which is why they take a video
 * id instead of closing over one.
 */
export default memo(MatchTile)
