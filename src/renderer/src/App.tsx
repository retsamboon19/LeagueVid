import { useEffect, useState } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import type { AppSettings } from '../../shared/types'
import Settings from './views/Settings'
import Library from './views/Library'
import RecorderIndicator from './components/RecorderIndicator'
import AnimatedBackground from './components/AnimatedBackground'

function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [isPlayerActive, setIsPlayerActive] = useState(false)
  // Incremented when the title is clicked; the library watches it and resets
  // itself back to a plain, unfiltered list.
  const [homeSignal, setHomeSignal] = useState(0)

  useEffect(() => {
    window.api.db.getSettings().then((existing) => {
      setSettings(existing)
      setLoaded(true)
    })
  }, [])

  if (!loaded) {
    return (
      <div className="app-shell">
        <p className="subtitle">Loading...</p>
      </div>
    )
  }

  // Scoped to the Library's plain list view for now (see the visual overhaul
  // notes in global.css): Settings and the video player keep their old look,
  // so the animated backdrop only mounts when neither of those is showing.
  // Otherwise the purple/pink glow would show through the 2rem app-shell
  // padding around a still-unstyled view and read as a mismatch rather than
  // a deliberate choice.
  const showAnimatedBackground = !isPlayerActive && !showSettings && (settings?.accounts.length ?? 0) > 0

  return (
    <>
      {/* Deliberately a SIBLING of .app-shell rather than a child.

          As a child it painted on top of the header and toolbar: it's a
          positioned (fixed) element with z-index 0, and CSS paints those above
          static in-flow content in the same stacking context, so the opaque
          gradient layer buried everything that wasn't itself positioned. The
          match tiles (position: relative) and filter panel (backdrop-filter)
          happened to survive by creating their own stacking contexts; the
          header didn't, and its buttons only reappeared on hover because
          button:hover applies a transform, which lifts them into the same
          paint layer.

          Kept outside so both are positioned and .app-shell's z-index: 1
          reliably wins, instead of the header's visibility depending on
          whether each individual descendant happens to create a stacking
          context. */}
      {showAnimatedBackground && <AnimatedBackground />}
      <div className="app-shell">
        {!isPlayerActive && (
          <header className="app-header">
            {/* The app title doubles as a "home" control. Any view that filters
                or drills down can end up showing nothing, and without this there
                was no guaranteed way back to the library from such a state. */}
            <button
              className="app-home-btn"
              onClick={() => {
                setShowSettings(false)
                setHomeSignal((n) => n + 1)
              }}
              title="Back to your recordings"
            >
              <h1>LeagueVid</h1>
            </button>
            {settings && (
              <div className="app-header-actions">
                <RecorderIndicator />
                {!showSettings && (
                  <span className="app-header-account">
                    {settings.accounts.length === 1
                      ? `${settings.accounts[0].gameName}#${settings.accounts[0].tagLine}`
                      : `${settings.accounts.length} accounts linked`}
                  </span>
                )}
                <button
                  className="player-icon-btn app-settings-icon-btn"
                  onClick={() => setShowSettings((s) => !s)}
                  aria-label={showSettings ? 'Back to library' : 'Settings'}
                  title={showSettings ? 'Back to library' : 'Settings'}
                >
                  <SettingsIcon size={18} />
                </button>
              </div>
            )}
          </header>
        )}

        <div
          className={`app-content ${
            !settings || settings.accounts.length === 0 || showSettings ? '' : 'app-content--wide'
          }`}
        >
          {!settings || settings.accounts.length === 0 || showSettings ? (
            <Settings
              onSaved={(s) => {
                setSettings(s)
                if (s.accounts.length > 0) setShowSettings(false)
              }}
            />
          ) : (
            <Library
              settings={settings}
              onPlayerActiveChange={setIsPlayerActive}
              homeSignal={homeSignal}
            />
          )}
        </div>
      </div>
    </>
  )
}

export default App
