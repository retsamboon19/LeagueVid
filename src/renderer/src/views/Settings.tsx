import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import type { AppSettings, PlatformRouting, RiotAccountLink } from '../../../shared/types'
import LinkedFoldersManager from './LinkedFoldersManager'
import RecordingSettingsSection from './RecordingSettings'
import UpdateSettings from './UpdateSettings'
import { PLATFORM_OPTIONS } from '../lib/platformOptions'

interface SettingsProps {
  onSaved: (settings: AppSettings) => void
}

function Settings({ onSaved }: SettingsProps): JSX.Element {
  const [accounts, setAccounts] = useState<RiotAccountLink[]>([])
  const [gameName, setGameName] = useState('')
  const [tagLine, setTagLine] = useState('')
  const [platform, setPlatform] = useState<PlatformRouting>('na1')
  const [status, setStatus] = useState<{ type: 'idle' | 'loading' | 'error' | 'success'; message?: string }>({
    type: 'idle'
  })

  const [apiKeyStatus, setApiKeyStatus] = useState<{
    hasCustomKey: boolean
    hasEnvKey: boolean
    hasBundledKey: boolean
    maskedKey: string | null
  } | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyMessage, setApiKeyMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null
  )
  const [rateLimit, setRateLimit] = useState<{ perSecond: number; per2Minutes: number } | null>(null)
  const [rateLimitDraft, setRateLimitDraft] = useState<{ perSecond: string; per2Minutes: string }>({
    perSecond: '',
    per2Minutes: ''
  })
  const [refreshingPuuid, setRefreshingPuuid] = useState<string | null>(null)
  const [refreshAllBusy, setRefreshAllBusy] = useState(false)
  const [clipsDirInfo, setClipsDirInfo] = useState<{
    current: string
    default: string
    isCustom: boolean
  } | null>(null)
  const [choosingClipsDir, setChoosingClipsDir] = useState(false)
  const [clipsDirMessage, setClipsDirMessage] = useState<{
    type: 'error' | 'success'
    text: string
  } | null>(null)

  useEffect(() => {
    window.api.db.getSettings().then((existing) => {
      if (existing) setAccounts(existing.accounts)
    })
    window.api.db.getRiotApiKeyStatus().then(setApiKeyStatus)
    window.api.video.getClipsDirInfo().then(setClipsDirInfo)
    window.api.db.getRiotRateLimit().then((cfg) => {
      setRateLimit(cfg)
      if (cfg) {
        setRateLimitDraft({ perSecond: String(cfg.perSecond), per2Minutes: String(cfg.per2Minutes) })
      }
    })
  }, [])

  async function handleSaveApiKey(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const trimmed = apiKeyInput.trim()
    if (!trimmed) {
      setApiKeyMessage({ type: 'error', text: 'Enter an API key.' })
      return
    }
    await window.api.db.setRiotApiKey(trimmed)
    const next = await window.api.db.getRiotApiKeyStatus()
    setApiKeyStatus(next)
    setApiKeyInput('')
    setApiKeyMessage({ type: 'success', text: 'API key saved. It will be used for all future requests.' })
  }

  async function handleClearApiKey(): Promise<void> {
    await window.api.db.setRiotApiKey(null)
    const next = await window.api.db.getRiotApiKeyStatus()
    setApiKeyStatus(next)
    setApiKeyMessage({
      type: 'success',
      text: next.hasEnvKey
        ? 'Custom key removed. Falling back to the key in your .env file.'
        : next.hasBundledKey
          ? 'Custom key removed. Falling back to the included private beta key.'
        : 'Custom key removed. No key is currently set.'
    })
  }

  async function handleSaveRateLimit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const perSecond = Number(rateLimitDraft.perSecond)
    const per2Minutes = Number(rateLimitDraft.per2Minutes)
    if (!Number.isFinite(perSecond) || perSecond <= 0 || !Number.isFinite(per2Minutes) || per2Minutes <= 0) {
      setApiKeyMessage({ type: 'error', text: 'Enter valid positive numbers for both rate limits.' })
      return
    }
    const config = { perSecond, per2Minutes }
    await window.api.db.setRiotRateLimit(config)
    setRateLimit(config)
    setApiKeyMessage({ type: 'success', text: 'Rate limit updated.' })
  }

  async function handleResetRateLimit(): Promise<void> {
    await window.api.db.setRiotRateLimit(null)
    setRateLimit(null)
    setRateLimitDraft({ perSecond: '20', per2Minutes: '100' })
    setApiKeyMessage({ type: 'success', text: 'Rate limit reset to Riot\u2019s default (20/1s, 100/2min).' })
  }

  async function handleChooseClipsDir(): Promise<void> {
    setChoosingClipsDir(true)
    setClipsDirMessage(null)
    try {
      const chosen = await window.api.video.chooseClipsDir()
      if (chosen) {
        setClipsDirInfo(await window.api.video.getClipsDirInfo())
        setClipsDirMessage({ type: 'success', text: `Clips will now be saved to ${chosen}` })
      }
    } catch (err) {
      setClipsDirMessage({ type: 'error', text: (err as Error).message })
    } finally {
      setChoosingClipsDir(false)
    }
  }

  async function handleResetClipsDir(): Promise<void> {
    const restored = await window.api.video.resetClipsDir()
    setClipsDirInfo(await window.api.video.getClipsDirInfo())
    setClipsDirMessage({ type: 'success', text: `Back to the default folder: ${restored}` })
  }

  async function persistAccounts(next: RiotAccountLink[]): Promise<void> {
    const settings: AppSettings = { accounts: next }
    await window.api.db.saveSettings(settings)
    setAccounts(next)
    onSaved(settings)
  }

  async function handleAddAccount(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!gameName.trim() || !tagLine.trim()) {
      setStatus({ type: 'error', message: 'Enter both your game name and tag line.' })
      return
    }

    const alreadyLinked = accounts.some(
      (a) =>
        a.gameName.toLowerCase() === gameName.trim().toLowerCase() &&
        a.tagLine.toLowerCase() === tagLine.trim().toLowerCase()
    )
    if (alreadyLinked) {
      setStatus({ type: 'error', message: 'That account is already linked.' })
      return
    }

    setStatus({ type: 'loading' })
    try {
      const account = await window.api.riot.findAccount({
        platform,
        gameName: gameName.trim(),
        tagLine: tagLine.trim()
      })
      const link: RiotAccountLink = {
        gameName: account.gameName,
        tagLine: account.tagLine,
        platform,
        puuid: account.puuid
      }
      await persistAccounts([...accounts, link])
      setStatus({ type: 'success', message: `Connected as ${account.gameName}#${account.tagLine}` })
      setGameName('')
      setTagLine('')
    } catch (err) {
      setStatus({ type: 'error', message: (err as Error).message })
    }
  }

  async function handleRemoveAccount(puuid: string): Promise<void> {
    await persistAccounts(accounts.filter((a) => a.puuid !== puuid))
  }

  // Re-fetches an account's puuid under whichever API key is currently
  // active. Riot's puuid values are encrypted per-key -- a puuid obtained
  // under one key can come back "400 Exception decrypting" when used with
  // requests made under a different key (e.g. after switching from a
  // development key to a personal key). Since account-v1 looks up by Riot
  // ID (gameName#tagLine) rather than puuid, it always works regardless of
  // which key issued the old puuid, making it the way to "re-mint" one.
  async function refreshAccountPuuid(account: RiotAccountLink): Promise<RiotAccountLink> {
    const fresh = await window.api.riot.findAccount({
      platform: account.platform,
      gameName: account.gameName,
      tagLine: account.tagLine
    })
    return { ...account, puuid: fresh.puuid }
  }

  async function handleRefreshAccount(account: RiotAccountLink): Promise<void> {
    setRefreshingPuuid(account.puuid)
    try {
      const refreshed = await refreshAccountPuuid(account)
      await persistAccounts(
        accounts.map((a) => (a.puuid === account.puuid ? refreshed : a))
      )
      setApiKeyMessage({
        type: 'success',
        text: `Refreshed ${account.gameName}#${account.tagLine} for the current API key.`
      })
    } catch (err) {
      setApiKeyMessage({ type: 'error', text: (err as Error).message })
    } finally {
      setRefreshingPuuid(null)
    }
  }

  async function handleRefreshAllAccounts(): Promise<void> {
    setRefreshAllBusy(true)
    try {
      const refreshed = await Promise.all(accounts.map(refreshAccountPuuid))
      await persistAccounts(refreshed)
      setApiKeyMessage({ type: 'success', text: `Refreshed ${refreshed.length} account(s) for the current API key.` })
    } catch (err) {
      setApiKeyMessage({ type: 'error', text: (err as Error).message })
    } finally {
      setRefreshAllBusy(false)
    }
  }

  return (
    <div className="view">
      <UpdateSettings />

      <hr style={{ border: 'none', borderTop: '1px solid #2f333f', margin: '0.5rem 0' }} />

      <h2>Riot API key</h2>
      <p className="subtitle">
        LeagueVid needs a Riot API key to fetch match data. Get one (development or personal) from
        the{' '}
        <a href="https://developer.riotgames.com/" target="_blank" rel="noreferrer">
          Riot Developer Portal
        </a>
        . A personal key doesn&apos;t expire every 24 hours like a basic development key, but
        shares the same default rate limit unless Riot has approved a higher one for it.
      </p>

      {apiKeyStatus && (
        <p className="subtitle">
          Current key:{' '}
          {apiKeyStatus.maskedKey ? (
            <code>{apiKeyStatus.maskedKey}</code>
          ) : (
            <span className="status-error">none set</span>
          )}
          {apiKeyStatus.hasCustomKey
            ? ' (saved in app settings)'
            : apiKeyStatus.hasEnvKey
              ? ' (from .env)'
              : apiKeyStatus.hasBundledKey
                ? ' (included with private beta)'
                : ''}
        </p>
      )}

      <form onSubmit={handleSaveApiKey} className="form">
        <div className="form-row">
          <label htmlFor="apiKey">New API key</label>
          <input
            id="apiKey"
            type="text"
            placeholder="RGAPI-..."
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="settings-panel-footer" style={{ justifyContent: 'flex-start' }}>
          <button type="submit">Save key</button>
          {apiKeyStatus?.hasCustomKey && (
            <button type="button" className="secondary" onClick={handleClearApiKey}>
              Remove custom key
            </button>
          )}
        </div>
      </form>

      {accounts.length > 0 && (
        <p className="settings-row-hint">
          If you just switched API keys and re-linking fails with a &quot;400 Exception
          decrypting&quot; error, your linked accounts need refreshing for the new key --{' '}
          <button
            type="button"
            className="link-button"
            style={{ padding: 0 }}
            onClick={handleRefreshAllAccounts}
            disabled={refreshAllBusy}
          >
            {refreshAllBusy ? 'refreshing...' : 'refresh all accounts now'}
          </button>
          .
        </p>
      )}

      <form onSubmit={handleSaveRateLimit} className="form">
        <div className="form-row">
          <label>Rate limit (advanced)</label>
          <p className="settings-row-hint">
            Only change this if Riot has approved higher limits for your key -- check the
            key&apos;s page on the Developer Portal for its actual approved numbers. Leave at the
            defaults (20/1s, 100/2min) otherwise.
          </p>
        </div>
        <div className="settings-row-input">
          <input
            type="number"
            min={1}
            value={rateLimitDraft.perSecond}
            onChange={(e) => setRateLimitDraft((d) => ({ ...d, perSecond: e.target.value }))}
            placeholder="20"
          />
          <span>requests / second</span>
        </div>
        <div className="settings-row-input">
          <input
            type="number"
            min={1}
            value={rateLimitDraft.per2Minutes}
            onChange={(e) => setRateLimitDraft((d) => ({ ...d, per2Minutes: e.target.value }))}
            placeholder="100"
          />
          <span>requests / 2 minutes</span>
        </div>
        <div className="settings-panel-footer" style={{ justifyContent: 'flex-start' }}>
          <button type="submit">Save rate limit</button>
          {rateLimit && (
            <button type="button" className="secondary" onClick={handleResetRateLimit}>
              Reset to default
            </button>
          )}
        </div>
      </form>

      {apiKeyMessage && (
        <p className={`status ${apiKeyMessage.type === 'error' ? 'status-error' : 'status-success'}`}>
          {apiKeyMessage.text}
        </p>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid #2f333f', margin: '0.5rem 0' }} />

      <h2>Clips</h2>
      <p className="subtitle">
        Where clips you cut from a recording are saved. By default this is a <code>clips</code>{' '}
        folder inside LeagueVid&apos;s own folder, so everything the app produces stays in one
        place.
      </p>

      {clipsDirInfo && (
        <div className="clips-dir-row">
          <div className="clips-dir-path">
            <span className="clip-field-label">
              {clipsDirInfo.isCustom ? 'Custom folder' : 'Default folder'}
            </span>
            <code>{clipsDirInfo.current}</code>
          </div>
          <div className="clips-dir-actions">
            <button onClick={handleChooseClipsDir} disabled={choosingClipsDir}>
              <FolderOpen size={15} /> {choosingClipsDir ? 'Choosing...' : 'Change folder'}
            </button>
            <button
              className="secondary"
              onClick={() => window.api.video.revealClipsFolder()}
              title="Open this folder"
            >
              Open
            </button>
            {clipsDirInfo.isCustom && (
              <button className="secondary" onClick={handleResetClipsDir}>
                Reset to default
              </button>
            )}
          </div>
        </div>
      )}

      {clipsDirMessage && (
        <p
          className={`status ${clipsDirMessage.type === 'error' ? 'status-error' : 'status-success'}`}
        >
          {clipsDirMessage.text}
        </p>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid #2f333f', margin: '0.5rem 0' }} />

      <h2>Recording</h2>
      <p className="subtitle">
        LeagueVid is learning to record your games itself: start when a game does, stop when it
        ends, and hand the file to the library already linked to the right match. Because the
        recorder knows exactly when its first frame landed, bookmarks on those recordings are
        placed from a measured offset instead of a guess at what the file name means.
      </p>
      <RecordingSettingsSection />

      <hr style={{ border: 'none', borderTop: '1px solid #2f333f', margin: '0.5rem 0' }} />

      <h2>Linked folders</h2>
      <p className="subtitle">
        Folders LeagueVid watches for new recordings. Use &quot;Rescan&quot; after adding new
        files to a linked folder to import them without re-adding the folder.
      </p>
      <LinkedFoldersManager refreshSignal={0} onImported={() => {}} />

      <hr style={{ border: 'none', borderTop: '1px solid #2f333f', margin: '0.5rem 0' }} />

      <h2>Riot accounts</h2>
      <p className="subtitle">
        Link one or more Riot IDs so LeagueVid can search match history across all of them when
        auto-tagging your recordings. Useful if you play on more than one account.
      </p>

      {accounts.length > 0 && (
        <ul className="account-list">
          {accounts.map((account) => (
            <li key={account.puuid} className="account-item">
              <span className="account-item-name">
                {account.gameName}#{account.tagLine}
              </span>
              <span className="account-item-platform">
                {PLATFORM_OPTIONS.find((p) => p.value === account.platform)?.label ??
                  account.platform}
              </span>
              <button
                className="link-button account-item-remove"
                onClick={() => handleRefreshAccount(account)}
                disabled={refreshingPuuid === account.puuid}
                aria-label={`Refresh ${account.gameName}#${account.tagLine} for the current API key`}
                title="Re-fetch this account's puuid for the current API key"
              >
                <RefreshCw size={14} className={refreshingPuuid === account.puuid ? 'spin' : ''} />
              </button>
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

      <form onSubmit={handleAddAccount} className="form">
        <div className="form-row">
          <label htmlFor="gameName">Riot ID</label>
          <div className="riot-id-input">
            <input
              id="gameName"
              type="text"
              placeholder="gameName"
              value={gameName}
              onChange={(e) => setGameName(e.target.value)}
            />
            <span>#</span>
            <input
              id="tagLine"
              type="text"
              placeholder="tagLine"
              value={tagLine}
              onChange={(e) => setTagLine(e.target.value)}
            />
          </div>
        </div>

        <div className="form-row">
          <label htmlFor="platform">Server</label>
          <select
            id="platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as PlatformRouting)}
          >
            {PLATFORM_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" disabled={status.type === 'loading'}>
          {status.type === 'loading' ? 'Connecting...' : 'Add account'}
        </button>

        {status.type === 'error' && <p className="status status-error">{status.message}</p>}
        {status.type === 'success' && <p className="status status-success">{status.message}</p>}
      </form>
    </div>
  )
}

export default Settings
