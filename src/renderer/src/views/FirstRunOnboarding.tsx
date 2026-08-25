import { useEffect, useRef, useState } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import type { PlatformRouting, RiotAccountLink } from '../../../shared/types'
import { PLATFORM_OPTIONS } from '../lib/platformOptions'

interface FirstRunOnboardingProps {
  onAccountsChanged: (accounts: RiotAccountLink[]) => void
  onContinue: () => void
}

function FirstRunOnboarding({
  onAccountsChanged,
  onContinue
}: FirstRunOnboardingProps): JSX.Element {
  const panelRef = useRef<HTMLElement>(null)
  const [accounts, setAccounts] = useState<RiotAccountLink[]>([])
  const [gameName, setGameName] = useState('')
  const [tagLine, setTagLine] = useState('')
  const [platform, setPlatform] = useState<PlatformRouting>('na1')
  const [showForm, setShowForm] = useState(true)
  const [status, setStatus] = useState<{
    type: 'idle' | 'loading' | 'error'
    message?: string
  }>({ type: 'idle' })

  useEffect(() => {
    function keepFocusInDialog(e: KeyboardEvent): void {
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }

    window.addEventListener('keydown', keepFocusInDialog)
    return () => window.removeEventListener('keydown', keepFocusInDialog)
  }, [])

  async function persistAccounts(next: RiotAccountLink[]): Promise<void> {
    await window.api.db.saveSettings({ accounts: next })
    setAccounts(next)
    onAccountsChanged(next)
  }

  async function handleAddAccount(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const trimmedGameName = gameName.trim()
    const trimmedTagLine = tagLine.trim()
    if (!trimmedGameName || !trimmedTagLine) {
      setStatus({ type: 'error', message: 'Enter both your game name and tag line.' })
      return
    }

    if (
      accounts.some(
        (account) =>
          account.gameName.toLowerCase() === trimmedGameName.toLowerCase() &&
          account.tagLine.toLowerCase() === trimmedTagLine.toLowerCase()
      )
    ) {
      setStatus({ type: 'error', message: 'That account is already linked.' })
      return
    }

    setStatus({ type: 'loading' })
    try {
      const account = await window.api.riot.findAccount({
        platform,
        gameName: trimmedGameName,
        tagLine: trimmedTagLine
      })
      const next = [
        ...accounts,
        {
          gameName: account.gameName,
          tagLine: account.tagLine,
          platform,
          puuid: account.puuid
        }
      ]
      await persistAccounts(next)
      setGameName('')
      setTagLine('')
      setStatus({ type: 'idle' })
      setShowForm(false)
    } catch (err) {
      setStatus({ type: 'error', message: (err as Error).message })
    }
  }

  async function handleRemoveAccount(puuid: string): Promise<void> {
    const next = accounts.filter((account) => account.puuid !== puuid)
    await persistAccounts(next)
    if (next.length === 0) setShowForm(true)
  }

  return (
    <div className="settings-panel-overlay first-run-overlay">
      <section
        className="settings-panel first-run-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        aria-describedby="first-run-description"
      >
        <div className="first-run-heading">
          <span className="first-run-eyebrow">Welcome to LeagueVid</span>
          <h1 id="first-run-title">Connect your Riot account</h1>
          <p id="first-run-description">
            LeagueVid uses your Riot ID to find your matches and link them to your recordings.
          </p>
        </div>

        {accounts.length > 0 && (
          <ul className="account-list first-run-account-list">
            {accounts.map((account) => (
              <li key={account.puuid} className="account-item">
                <Check size={17} className="first-run-account-check" />
                <span className="account-item-name">
                  {account.gameName}#{account.tagLine}
                </span>
                <span className="account-item-platform">
                  {PLATFORM_OPTIONS.find((option) => option.value === account.platform)?.label ??
                    account.platform}
                </span>
                <button
                  className="link-button account-item-remove"
                  onClick={() => handleRemoveAccount(account.puuid)}
                  aria-label={`Remove ${account.gameName}#${account.tagLine}`}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {showForm ? (
          <form className="form first-run-form" onSubmit={handleAddAccount}>
            <div className="form-row">
              <label htmlFor="onboarding-game-name">Riot ID</label>
              <div className="riot-id-input">
                <input
                  id="onboarding-game-name"
                  type="text"
                  placeholder="gameName"
                  value={gameName}
                  onChange={(e) => setGameName(e.target.value)}
                  autoFocus
                />
                <span>#</span>
                <input
                  id="onboarding-tag-line"
                  type="text"
                  placeholder="tagLine"
                  value={tagLine}
                  onChange={(e) => setTagLine(e.target.value)}
                />
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="onboarding-platform">Server</label>
              <select
                id="onboarding-platform"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as PlatformRouting)}
              >
                {PLATFORM_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <button type="submit" disabled={status.type === 'loading'}>
              {status.type === 'loading' ? 'Connecting...' : 'Connect account'}
            </button>
            {status.type === 'error' && (
              <p className="status status-error">{status.message}</p>
            )}
          </form>
        ) : (
          <button
            className="secondary first-run-add-another"
            onClick={() => {
              setStatus({ type: 'idle' })
              setShowForm(true)
            }}
          >
            <Plus size={17} />
            Add another account
          </button>
        )}

        <div className="settings-panel-footer first-run-footer">
          <span>
            {accounts.length === 0
              ? 'Connect at least one account to continue.'
              : `${accounts.length} account${accounts.length === 1 ? '' : 's'} connected`}
          </span>
          <button onClick={onContinue} disabled={accounts.length === 0 || status.type === 'loading'}>
            Continue
          </button>
        </div>
      </section>
    </div>
  )
}

export default FirstRunOnboarding
