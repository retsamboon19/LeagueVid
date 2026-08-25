import { useCallback, useEffect, useState } from 'react'
import type {
  GankEvent,
  GankOutcome,
  GankVerdict,
  StatsParticipant
} from '../../../../shared/types'
import { formatGameClock } from './statsFormat'

// The reviewable list behind the gank gauges: every gank LeagueVid thinks it
// found, what came of it, who did it, and a jump to that moment in the VOD.
//
// It exists because gank detection is a heuristic. A count on its own asks the
// user to take the number on faith; a list they can click through lets them
// check it. The accurate/wrong buttons then turn that checking into the only
// ground truth available for retuning the thresholds later -- verdicts land in
// the gank_feedback table (see db/index.ts).

interface GankSourceListProps {
  events: GankEvent[]
  /** For turning participantIds into champion names. */
  participants: StatsParticipant[]
  matchId: string
  /** The player the list is about, so verdicts are stored against the right one. */
  participantId: number
  /** Seeks video playback to a game time. */
  onSeekGameTime?: (gameTimeMs: number) => void
}

const OUTCOME_LABEL: Record<GankOutcome, string> = {
  died: 'Died',
  survived: 'Survived',
  turned_around: 'Turned it around'
}

const OUTCOME_ICON: Record<GankOutcome, string> = {
  died: '\uD83D\uDC80',
  survived: '\uD83D\uDEE1\uFE0F',
  turned_around: '\u2694\uFE0F'
}

const OUTCOME_HINT: Record<GankOutcome, string> = {
  died: 'You died to this gank.',
  survived: 'A ganker reached your lane and you came out of it alive.',
  turned_around: 'The ganker died in your lane and you helped kill them.'
}

/**
 * Sampled ganks are only located to the nearest minute, so playback starts a
 * little earlier to avoid landing after the fight already happened.
 */
const APPROXIMATE_LEAD_IN_MS = 20_000

function GankSourceList({
  events,
  participants,
  matchId,
  participantId,
  onSeekGameTime
}: GankSourceListProps): JSX.Element | null {
  // Keyed by game timestamp, matching how verdicts are keyed in the database.
  const [verdicts, setVerdicts] = useState<Record<number, GankVerdict>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.db
      .listGankFeedback({ matchId, participantId })
      .then((rows) => {
        if (cancelled) return
        const next: Record<number, GankVerdict> = {}
        for (const row of rows) {
          if (row.verdict === 'accurate' || row.verdict === 'wrong') {
            next[row.timestamp_ms] = row.verdict
          }
        }
        setVerdicts(next)
      })
      .catch(() => {
        // A failed read just means no verdicts are shown; the list still works.
        if (!cancelled) setVerdicts({})
      })
    return () => {
      cancelled = true
    }
  }, [matchId, participantId])

  const championFor = useCallback(
    (id: number): string =>
      participants.find((p) => p.participantId === id)?.championName ?? `Player ${id}`,
    [participants]
  )

  const vote = useCallback(
    async (event: GankEvent, verdict: GankVerdict): Promise<void> => {
      const key = Math.round(event.timestampMs)
      const current = verdicts[key]
      // Clicking the verdict you already gave clears it, so a misclick is
      // undoable without leaving a wrong judgment in the training data.
      const next = current === verdict ? undefined : verdict

      // Optimistic: the button should respond immediately, and a failed write
      // is recoverable by clicking again.
      setVerdicts((prev) => {
        const copy = { ...prev }
        if (next === undefined) delete copy[key]
        else copy[key] = next
        return copy
      })
      setSaveError(null)

      try {
        if (next === undefined) {
          await window.api.db.clearGankFeedback({ matchId, participantId, timestampMs: key })
        } else {
          await window.api.db.setGankFeedback({
            matchId,
            participantId,
            timestampMs: key,
            outcome: event.outcome,
            gankerParticipantIds: event.gankerParticipantIds,
            verdict: next
          })
        }
      } catch {
        setSaveError('Could not save that verdict. Try again.')
      }
    },
    [matchId, participantId, verdicts]
  )

  if (events.length === 0) return null

  return (
    <div className="gank-source">
      <h4 className="stats-section-title">Gank source</h4>
      <p className="settings-row-hint">
        Every gank LeagueVid detected on your lane before 15 minutes.
        {onSeekGameTime ? ' Click a time to jump there,' : ''} Tell it whether the call was right
        &mdash; those answers are used to improve the detection.
      </p>

      <ul className="gank-source-list">
        {events.map((event) => {
          const key = Math.round(event.timestampMs)
          const verdict = verdicts[key]
          const gankers = event.gankerParticipantIds.map(championFor)
          const seekTarget = event.approximateTime
            ? Math.max(0, event.timestampMs - APPROXIMATE_LEAD_IN_MS)
            : event.timestampMs

          return (
            <li key={key} className={`gank-row gank-row--${event.outcome}`}>
              <button
                className="gank-row-jump"
                onClick={onSeekGameTime ? () => onSeekGameTime(seekTarget) : undefined}
                disabled={!onSeekGameTime}
                title={`${OUTCOME_HINT[event.outcome]} ${
                  onSeekGameTime ? 'Click to jump to ' : 'Occurred at '
                }${formatGameClock(event.timestampMs)}${
                  event.approximateTime ? ' (approximate)' : ''
                }.`}
              >
                <span aria-hidden="true">{OUTCOME_ICON[event.outcome]}</span>
                <span className="gank-row-time">
                  {event.approximateTime ? '~' : ''}
                  {formatGameClock(event.timestampMs)}
                </span>
              </button>

              <span className="gank-row-detail">
                {/* Outcome in words, not colour alone. */}
                <span className="gank-row-outcome">{OUTCOME_LABEL[event.outcome]}</span>
                <span className="gank-row-gankers">
                  {gankers.length > 0 ? gankers.join(' + ') : 'Unknown'}
                </span>
              </span>

              <span className="gank-row-verdict" role="group" aria-label="Was this gank detected correctly?">
                <button
                  className={`gank-verdict-btn ${
                    verdict === 'accurate' ? 'gank-verdict-btn--on' : ''
                  }`}
                  onClick={() => vote(event, 'accurate')}
                  aria-pressed={verdict === 'accurate'}
                  title="This really was a gank. Click again to undo."
                >
                  Right
                </button>
                <button
                  className={`gank-verdict-btn ${
                    verdict === 'wrong' ? 'gank-verdict-btn--on' : ''
                  }`}
                  onClick={() => vote(event, 'wrong')}
                  aria-pressed={verdict === 'wrong'}
                  title="This was not a gank. Click again to undo."
                >
                  Wrong
                </button>
              </span>
            </li>
          )
        })}
      </ul>

      {saveError && <p className="settings-row-hint">{saveError}</p>}

      {events.some((e) => e.approximateTime) && (
        <p className="settings-row-hint">
          Times marked <strong>~</strong> come from Riot&apos;s once-a-minute position samples, so
          they show roughly when the gank happened. Playback starts{' '}
          {APPROXIMATE_LEAD_IN_MS / 1000} seconds early on those to give you the run-up.
        </p>
      )}
    </div>
  )
}

export default GankSourceList
