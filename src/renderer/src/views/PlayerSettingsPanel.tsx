import { useState } from 'react'
import type { PlayerPreferences } from '../../../shared/types'

interface PlayerSettingsPanelProps {
  preferences: PlayerPreferences
  onSave: (prefs: PlayerPreferences) => void
  onClose: () => void
}

function PlayerSettingsPanel({ preferences, onSave, onClose }: PlayerSettingsPanelProps): JSX.Element {
  const [draft, setDraft] = useState<PlayerPreferences>(preferences)

  function handleSave(): void {
    onSave(draft)
    onClose()
  }

  return (
    <div className="settings-panel-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-panel-header">
          <h3>Player settings</h3>
          <button className="link-button" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-panel-body">
          <div className="settings-row">
            <label htmlFor="lead-in">Bookmark lead-in</label>
            <div className="settings-row-input">
              <input
                id="lead-in"
                type="number"
                min={0}
                max={60}
                value={draft.bookmarkLeadInSeconds}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, bookmarkLeadInSeconds: Number(e.target.value) }))
                }
              />
              <span>seconds before the moment</span>
            </div>
            <p className="settings-row-hint">
              Jumping to a kill/death/objective bookmark rewinds this many seconds first, so you
              see the lead-up instead of just the result.
            </p>
          </div>

          <div className="settings-row">
            <label htmlFor="seek-step">Skip step</label>
            <div className="settings-row-input">
              <input
                id="seek-step"
                type="number"
                min={1}
                max={60}
                value={draft.seekStepSeconds}
                onChange={(e) => setDraft((d) => ({ ...d, seekStepSeconds: Number(e.target.value) }))}
              />
              <span>seconds per skip button press</span>
            </div>
          </div>

          <div className="settings-row settings-row-checkbox">
            <label htmlFor="autoplay">
              <input
                id="autoplay"
                type="checkbox"
                checked={draft.autoPlayOnJump}
                onChange={(e) => setDraft((d) => ({ ...d, autoPlayOnJump: e.target.checked }))}
              />
              Auto-play when jumping to a bookmark
            </label>
          </div>
        </div>

        <div className="settings-panel-footer">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}

export default PlayerSettingsPanel
