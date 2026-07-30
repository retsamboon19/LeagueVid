import { memo, useState } from 'react'
import type { HeuristicStats, MatchStats, StatsParticipant } from '../../../../shared/types'
import { challenge, csPerMinute, formatCompactNumber, formatPercent } from './statsFormat'

interface InsightsTabProps {
  stats: MatchStats
  focus: StatsParticipant
}

type GroupKey = 'fighting' | 'ganks' | 'farming' | 'objectives' | 'vision'

interface Gauge {
  name: string
  /** null renders as "unavailable" -- never as 0. */
  value: number | null
  /** Text shown inside the ring. */
  display: string
  /** 0..1 fill fraction. */
  fill: number
  /** True for stats LeagueVid computes itself rather than reading from Riot. */
  isEstimate?: boolean
  tone?: 'good' | 'bad' | 'neutral'
}

const EXPLANATION =
  'LeagueVid works this out itself by grouping timeline kill events that happened close together in time and place. Riot does not provide this number, so treat it as an estimate.'

function ratioGauge(
  name: string,
  ratio: number | null,
  opts: { isEstimate?: boolean; tone?: Gauge['tone'] } = {}
): Gauge {
  return {
    name,
    value: ratio,
    display: ratio === null ? '--' : formatPercent(ratio * 1, 0),
    fill: ratio === null ? 0 : Math.min(1, Math.max(0, ratio)),
    ...opts
  }
}

function countGauge(
  name: string,
  value: number | null,
  /** Value that represents a "full" ring, purely for visual scale. */
  fullAt: number,
  opts: { isEstimate?: boolean; tone?: Gauge['tone']; display?: string } = {}
): Gauge {
  return {
    name,
    value,
    display: opts.display ?? (value === null ? '--' : formatCompactNumber(value)),
    fill: value === null ? 0 : Math.min(1, Math.max(0, value / fullAt)),
    isEstimate: opts.isEstimate,
    tone: opts.tone
  }
}

function buildGauges(
  group: GroupKey,
  focus: StatsParticipant,
  stats: MatchStats,
  heuristics: HeuristicStats | undefined
): Gauge[] {
  const durationSeconds = stats.gameDurationSeconds

  if (group === 'fighting') {
    return [
      ratioGauge('Kill participation', challenge(focus, 'killParticipation')),
      ratioGauge('Team damage share', challenge(focus, 'teamDamagePercentage')),
      countGauge('Solo kills', challenge(focus, 'soloKills'), 5),
      countGauge('Damage / min', challenge(focus, 'damagePerMinute'), 1200),
      // Heuristics: rings look identical, but each carries the estimate mark.
      ratioGauge('Teamfight winrate', heuristics?.teamfightWinRate ?? null, { isEstimate: true }),
      ratioGauge('Teamfight participation', heuristics?.teamfightParticipation ?? null, {
        isEstimate: true
      }),
      ratioGauge('Duel winrate', heuristics?.duelWinRate ?? null, { isEstimate: true }),
      countGauge('Solo deaths', heuristics?.soloDeaths ?? null, 6, {
        isEstimate: true,
        tone: 'bad'
      })
    ]
  }

  if (group === 'ganks') {
    // Absent for junglers (no lane of their own) and for non-Summoner's-Rift
    // modes, in both cases leaving every ring as "Not reported" rather than
    // implying a clean laning phase.
    const gank = stats.gankByParticipant[focus.participantId]
    return [
      countGauge('Gank attempts', gank?.gankAttempts ?? null, 3, {
        isEstimate: true,
        tone: 'neutral'
      }),
      countGauge('Ganks survived', gank?.ganksSurvived ?? null, 3, {
        isEstimate: true,
        tone: 'good'
      }),
      countGauge('Deaths to ganks', gank?.gankDeaths ?? null, 4, {
        isEstimate: true,
        tone: 'bad'
      }),
      countGauge('Ganks turned around', gank?.ganksTurnedAround ?? null, 3, {
        isEstimate: true,
        tone: 'good'
      })
    ]
  }

  if (group === 'farming') {
    const cspm = csPerMinute(focus, durationSeconds)
    return [
      countGauge('CS', focus.cs, 400),
      countGauge('CS / min', cspm === null ? null : Number(cspm.toFixed(1)), 10, {
        display: cspm === null ? '--' : cspm.toFixed(1)
      }),
      countGauge('CS at 10 min', challenge(focus, 'laneMinionsFirst10Minutes'), 90),
      countGauge('Max CS lead', challenge(focus, 'maxCsAdvantageOnLaneOpponent'), 50),
      countGauge('Gold / min', challenge(focus, 'goldPerMinute'), 500)
    ]
  }

  if (group === 'objectives') {
    return [
      countGauge('Dragon takedowns', challenge(focus, 'dragonTakedowns'), 4),
      countGauge('Herald takedowns', challenge(focus, 'riftHeraldTakedowns'), 2),
      countGauge('Baron takedowns', challenge(focus, 'baronTakedowns'), 2),
      countGauge('Turret plates', challenge(focus, 'turretPlatesTaken'), 5),
      countGauge('Turret kills', focus.turretKills, 4),
      countGauge('Objective damage', focus.damageToObjectives, 20000)
    ]
  }

  return [
    countGauge('Vision score', focus.visionScore, 60),
    countGauge('Vision / min', challenge(focus, 'visionScorePerMinute'), 2),
    countGauge('Control wards', focus.controlWardsPlaced, 6),
    countGauge('Wards placed', focus.wardsPlaced, 25),
    countGauge('Wards cleared', focus.wardsKilled, 10)
  ]
}

function GaugeRing({ gauge }: { gauge: Gauge }): JSX.Element {
  const radius = 26
  const circumference = 2 * Math.PI * radius
  const dash = circumference * gauge.fill
  const unavailable = gauge.value === null

  return (
    <div className={`gauge ${unavailable ? 'gauge--unavailable' : ''}`}>
      <div className="gauge-ring-wrap">
        <svg
          viewBox="0 0 64 64"
          className="gauge-ring"
          role="progressbar"
          aria-valuenow={unavailable ? undefined : Math.round(gauge.fill * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={gauge.name}
        >
          <circle cx="32" cy="32" r={radius} className="gauge-track" />
          {!unavailable && (
            <circle
              cx="32"
              cy="32"
              r={radius}
              className={`gauge-fill gauge-fill--${gauge.tone ?? 'good'}`}
              strokeDasharray={`${dash} ${circumference}`}
              transform="rotate(-90 32 32)"
            />
          )}
        </svg>
        <span className="gauge-value">{gauge.display}</span>
      </div>
      <span className="gauge-name">
        {gauge.name}
        {gauge.isEstimate && (
          <span className="gauge-estimate" title={EXPLANATION}>
            est.
          </span>
        )}
      </span>
      {unavailable && <span className="gauge-unavailable-note">Not reported</span>}
    </div>
  )
}

const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: 'fighting', label: 'Fighting' },
  { key: 'ganks', label: 'Ganks' },
  { key: 'farming', label: 'Farming' },
  { key: 'objectives', label: 'Objectives' },
  { key: 'vision', label: 'Vision' }
]

function InsightsTab({ stats, focus }: InsightsTabProps): JSX.Element {
  const [group, setGroup] = useState<GroupKey>('fighting')
  const heuristics = stats.heuristicsByParticipant[focus.participantId]
  const gank = stats.gankByParticipant[focus.participantId]
  const gauges = buildGauges(group, focus, stats, heuristics)
  const showsEstimates = gauges.some((g) => g.isEstimate)

  return (
    <div className="stats-tab-body">
      <div className="insight-group-tabs" role="group" aria-label="Insight group">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            className={`graph-metric-btn ${group === g.key ? 'graph-metric-btn--active' : ''}`}
            onClick={() => setGroup(g.key)}
            aria-pressed={group === g.key}
          >
            {g.label}
          </button>
        ))}
      </div>

      {!stats.hasTimeline && (group === 'fighting' || group === 'ganks') && (
        <p className="settings-row-hint">
          These estimates need the match timeline, which hasn&apos;t been downloaded for this game
          yet.
        </p>
      )}

      {stats.hasTimeline && group === 'ganks' && !gank && (
        <p className="settings-row-hint">
          {focus.teamPosition === 'JUNGLE'
            ? 'Gank stats are measured relative to a player\u2019s own lane, so they don\u2019t apply to junglers.'
            : 'Gank stats need Summoner\u2019s Rift lanes, so they aren\u2019t measured for this game mode.'}
        </p>
      )}

      <div className="gauge-grid">
        {gauges.map((gauge) => (
          <GaugeRing key={gauge.name} gauge={gauge} />
        ))}
      </div>

      {showsEstimates && group === 'ganks' && (
        <p className="settings-row-hint">
          Values marked <span className="gauge-estimate">est.</span> are computed by LeagueVid, not
          supplied by Riot. A gank is counted when someone outside your normal lane matchup comes
          into your lane before 15 minutes. Riot only reports player positions once a minute, so
          attempts are sampled rather than fully counted &mdash; treat the attempt figures as a
          floor, not an exact tally.
        </p>
      )}

      {showsEstimates && group !== 'ganks' && (
        <p className="settings-row-hint">
          Values marked <span className="gauge-estimate">est.</span> are computed by LeagueVid from
          timeline kill events, not supplied by Riot. Teamfights are inferred from kills that
          happened within about 10 seconds and a short distance of each other, so treat them as
          approximate.
        </p>
      )}
    </div>
  )
}

export default memo(InsightsTab)
