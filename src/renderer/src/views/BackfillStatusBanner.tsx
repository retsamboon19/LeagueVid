import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import Toast from '../components/Toast'

interface BackfillStatusBannerProps {
  puuids: string[]
  onCachedCountChange?: (count: number) => void
}

// Poll faster while a download is in progress than when idle, so the counts
// visibly move without hammering the DB when there's nothing happening.
const POLL_ACTIVE_MS = 5_000
const POLL_IDLE_MS = 30_000

interface Status {
  totalAccounts: number
  accountsFullyBackfilled: number
  matchesDownloaded: number
  matchesTotal: number | null
  matchesCached: number
}

// Always-visible summary of how much Riot match data is on this PC versus how
// much exists, plus a manual trigger to fetch anything missing.
//
// This stays on screen even when everything is downloaded: "how much do I
// have?" is a question worth being able to answer at a glance, and an
// indicator that only appears mid-download can't answer it. There is
// deliberately no dismiss control -- an earlier version had one, and closing
// it left no way to get the information back.
function BackfillStatusBanner({
  puuids,
  onCachedCountChange
}: BackfillStatusBannerProps): JSX.Element | null {
  const [status, setStatus] = useState<Status | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  // Tracks the previous poll's "in progress" state so a false->true->false
  // transition (a download that was actually running, not just idle from the
  // start) can be told apart from simply already being caught up on first
  // load, which shouldn't pop a toast every time the app opens.
  const wasInProgressRef = useRef<boolean | null>(null)
  const previousCachedCountRef = useRef<number | null>(null)

  useEffect(() => {
    if (puuids.length === 0) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll(): Promise<void> {
      try {
        const next = await window.api.db.getBackfillStatus(puuids)
        if (cancelled) return
        setStatus(next)
        if (
          previousCachedCountRef.current !== null &&
          previousCachedCountRef.current !== next.matchesCached
        ) {
          onCachedCountChange?.(next.matchesCached)
        }
        previousCachedCountRef.current = next.matchesCached
        const active = next.accountsFullyBackfilled < next.totalAccounts

        if (wasInProgressRef.current === true && !active) {
          setToastMessage(
            `Match data download finished -- ${next.matchesCached.toLocaleString()} match${
              next.matchesCached === 1 ? '' : 'es'
            } saved locally.`
          )
        }
        wasInProgressRef.current = active

        timer = setTimeout(poll, active ? POLL_ACTIVE_MS : POLL_IDLE_MS)
      } catch {
        // Status is non-critical -- stop polling quietly rather than showing
        // an error for something the user didn't ask for.
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [puuids.join(','), onCachedCountChange])

  async function handleDownload(): Promise<void> {
    setRequesting(true)
    try {
      await window.api.riot.downloadMatchData()
      // Refresh straight away so the counts reflect the restarted pass, and
      // treat this as "now in progress" so the toast fires once it wraps up
      // even if the very next poll already sees it as complete.
      wasInProgressRef.current = true
      const next = await window.api.db.getBackfillStatus(puuids)
      setStatus(next)
    } finally {
      setRequesting(false)
    }
  }

  if (!status || puuids.length === 0) {
    return toastMessage ? (
      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    ) : null
  }

  const inProgress = status.accountsFullyBackfilled < status.totalAccounts
  const { matchesCached, matchesTotal } = status
  const percent =
    matchesTotal && matchesTotal > 0
      ? Math.min(100, Math.round((matchesCached / matchesTotal) * 100))
      : null

  return (
    <>
      {toastMessage && <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />}
      <div className={`backfill-banner ${inProgress ? '' : 'backfill-banner--idle'}`}>
        <Download size={15} className="backfill-banner-icon" />
        <div className="backfill-banner-body">
          <span className="backfill-banner-text">
            {matchesTotal === null ? (
              <>Checking how many matches your account{status.totalAccounts > 1 ? 's have' : ' has'}...</>
            ) : (
              <>
                <strong>
                  {matchesCached.toLocaleString()} of {matchesTotal.toLocaleString()}
                </strong>{' '}
                matches saved on this PC
                {percent !== null && ` (${percent}%)`}
                {inProgress ? ' \u00b7 downloading in the background' : ' \u00b7 up to date'}
                {status.totalAccounts > 1 &&
                  ` \u00b7 ${status.accountsFullyBackfilled}/${status.totalAccounts} accounts scanned`}
              </>
            )}
          </span>
          {percent !== null && (
            <div
              className="backfill-banner-track"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Match data downloaded"
            >
              <div className="backfill-banner-fill" style={{ width: `${percent}%` }} />
            </div>
          )}
          {matchesTotal !== null && (
            <span className="backfill-banner-note">
              Match data is stored in your LeagueVid app data folder, separately from the app&apos;s
              database. The total is what Riot will return for your account -- roughly the last 2
              years, capped near 1000 games -- not your lifetime game count.
            </span>
          )}
        </div>
        <button
          className="secondary backfill-banner-btn"
          onClick={handleDownload}
          disabled={requesting}
          title="Check Riot for any match data not yet saved here, and download it"
        >
          <RefreshCw size={13} className={requesting ? 'spin' : ''} />{' '}
          {requesting ? 'Starting...' : 'Download match data'}
        </button>
      </div>
    </>
  )
}

export default BackfillStatusBanner
