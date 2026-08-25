import type { ObjectiveEvent } from '../../../../shared/types'
import { formatGameClock } from './statsFormat'

interface ObjectiveTimelineProps {
  objectives: ObjectiveEvent[]
  focusTeamId: number
  /** Seeks video playback to a game time. */
  onSeekGameTime?: (gameTimeMs: number) => void
}

const KIND_ICONS: Record<string, string> = {
  dragon: '\uD83D\uDC09',
  herald: '\uD83D\uDC51',
  baron: '\uD83D\uDC79',
  atakhan: '\u2620\uFE0F',
  turret: '\uD83C\uDFF0',
  inhibitor: '\uD83D\uDEE1\uFE0F'
}

// Objectives worth reviewing. Turret/inhibitor takedowns are numerous and
// clutter the strip, so only epic monsters are shown by default -- those are
// the moments where "was I there?" is the interesting question.
const EPIC_KINDS = new Set(['dragon', 'herald', 'baron', 'atakhan'])

function ObjectiveTimeline({
  objectives,
  focusTeamId,
  onSeekGameTime
}: ObjectiveTimelineProps): JSX.Element | null {
  const epics = objectives.filter((o) => EPIC_KINDS.has(o.kind))
  if (epics.length === 0) return null

  return (
    <div className="objective-timeline">
      <h4 className="stats-section-title">Objectives</h4>
      <div className="objective-list">
        {epics.map((o, i) => {
          const isOurs = o.teamId === focusTeamId
          return (
            <button
              key={i}
              className={`objective-chip ${
                isOurs ? 'objective-chip--ours' : 'objective-chip--theirs'
              } ${o.participated ? 'objective-chip--participated' : ''}`}
              onClick={onSeekGameTime ? () => onSeekGameTime(o.timestampMs) : undefined}
              disabled={!onSeekGameTime}
              title={`${o.label} at ${formatGameClock(o.timestampMs)} \u2014 ${
                isOurs ? 'your team' : 'enemy team'
              }${o.participated ? ', you took part' : ', you were not involved'}.${
                onSeekGameTime ? ' Click to jump here.' : ''
              }`}
            >
              <span aria-hidden="true">{KIND_ICONS[o.kind] ?? '\u2B50'}</span>
              <span className="objective-chip-time">{formatGameClock(o.timestampMs)}</span>
              <span className="objective-chip-label">{o.label}</span>
              {/* Participation stated in text, not only by styling. */}
              <span className="objective-chip-part">{o.participated ? 'in' : 'out'}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default ObjectiveTimeline
