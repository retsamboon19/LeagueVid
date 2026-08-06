import { useEffect, useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import type { UpdateCheckResult, UpdateProgress } from '../../../shared/updater'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return ''
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

function progressLabel(progress: UpdateProgress | null): string {
  if (!progress) return 'Preparing update...'
  if (progress.phase === 'verifying') return 'Verifying download...'
  if (progress.phase === 'launching') return 'Restarting to finish the update...'
  if (progress.fraction === null) return 'Downloading update...'
  return `Downloading update... ${Math.round(progress.fraction * 100)}%`
}

function UpdateSettings(): JSX.Element {
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [available, setAvailable] = useState<UpdateCheckResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)

  useEffect(() => window.api.updater.onProgress(setProgress), [])

  useEffect(() => {
    if (!available || installing) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAvailable(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [available, installing])

  async function check(): Promise<void> {
    setChecking(true)
    setMessage(null)
    setError(null)
    try {
      const result = await window.api.updater.check()
      if (result.updateAvailable) {
        setAvailable(result)
      } else {
        setMessage(`LeagueVid ${result.currentVersion} is up to date.`)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  async function install(): Promise<void> {
    setInstalling(true)
    setError(null)
    setProgress(null)
    try {
      await window.api.updater.install()
      setMessage('The update is ready. LeagueVid will restart automatically.')
    } catch (err) {
      setError((err as Error).message)
      setInstalling(false)
    }
  }

  return (
    <>
      <h2>Updates</h2>
      <div className="update-card">
        <div className="update-card-copy">
          <strong>Keep LeagueVid up to date</strong>
          <p className="subtitle">
            Check GitHub for a newer build. LeagueVid will show what changed and ask before it
            downloads or installs anything.
          </p>
          {message && <p className="status status-success update-status">{message}</p>}
          {error && <p className="status status-error update-status">{error}</p>}
        </div>
        <button onClick={check} disabled={checking || installing}>
          <RefreshCw size={15} className={checking ? 'spin' : ''} />
          {checking ? 'Checking...' : 'Check for updates'}
        </button>
      </div>

      {available && (
        <div className="settings-panel-overlay" onClick={installing ? undefined : () => setAvailable(null)}>
          <div
            className="settings-panel update-confirm-panel"
            role="dialog"
            aria-labelledby="update-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-panel-header">
              <h3 id="update-confirm-title">
                {available.sameVersionRefresh
                  ? `A newer ${available.latestVersion} build is available`
                  : `LeagueVid ${available.latestVersion} is available`}
              </h3>
              <button
                className="link-button"
                aria-label="Close update confirmation"
                onClick={() => setAvailable(null)}
                disabled={installing}
              >
                <X size={18} />
              </button>
            </div>

            <div className="settings-panel-body">
              <p className="update-version-line">
                Installed: <strong>{available.currentVersion}</strong>
                <span aria-hidden="true">→</span>
                Available: <strong>{available.latestVersion}</strong>
              </p>
              <div>
                <strong>Changes in this update</strong>
                <pre className="update-release-notes">{available.releaseNotes}</pre>
              </div>
              <p className="settings-row-hint">
                The {formatBytes(available.installerSize)} installer will be downloaded from the
                official LeagueVid GitHub release, verified, installed silently, and LeagueVid will
                restart automatically.
              </p>
              {installing && (
                <div className="update-progress" aria-live="polite">
                  <div className="update-progress-track">
                    <div
                      className="update-progress-fill"
                      style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }}
                    />
                  </div>
                  <span>{progressLabel(progress)}</span>
                </div>
              )}
              {error && <p className="status status-error">{error}</p>}
            </div>

            <div className="settings-panel-footer">
              <button className="secondary" onClick={() => setAvailable(null)} disabled={installing}>
                Not now
              </button>
              <button onClick={install} disabled={installing}>
                <Download size={15} /> {installing ? 'Installing...' : 'Download and install'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default UpdateSettings

