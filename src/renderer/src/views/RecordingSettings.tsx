import { useEffect, useState } from 'react'
import type { RecordingSettings } from '../../../shared/types'

// Read-only view of the recorder's stored configuration.
//
// The settings row is persisted and round-tripped through IPC from this
// point on, so everything built on top of it (encoder probing, the argument
// builder, the state machine) has somewhere to read from. The controls
// themselves arrive with the capture pipeline they configure -- offering a
// frame rate picker before anything can record would be a switch wired to
// nothing.

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

function describeQuality(settings: RecordingSettings): string {
  return settings.rateControl === 'quality'
    ? `Constant quality (${settings.quality})`
    : `${(settings.bitrateKbps / 1000).toFixed(0)} Mbps constant bitrate`
}

function describeResolution(settings: RecordingSettings): string {
  return settings.resolutionScale === 'native'
    ? 'Native (no scaling)'
    : `Scaled to ${settings.resolutionScale}`
}

function describeRetention(settings: RecordingSettings): string {
  if (!settings.retentionEnabled) return 'Off -- nothing is deleted automatically'
  const limits: string[] = []
  if (settings.retentionMaxGb != null) limits.push(`over ${settings.retentionMaxGb} GB`)
  if (settings.retentionMaxAgeDays != null)
    limits.push(`older than ${settings.retentionMaxAgeDays} days`)
  return limits.length > 0 ? `Removes recordings ${limits.join(' or ')}` : 'On, but no limit set'
}

function RecordingSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<RecordingSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.recorder
      .getSettings()
      .then(setSettings)
      .catch((err: Error) => setError(err.message))
  }, [])

  if (error) {
    return <p className="status status-error">Could not read the recording settings: {error}</p>
  }

  if (!settings) {
    return <p className="settings-row-hint">Reading recording settings...</p>
  }

  const rows: Array<{ label: string; value: string }> = [
    {
      label: 'Automatic recording',
      value: settings.enabled ? 'On' : 'Off'
    },
    {
      label: 'Save recordings to',
      value: settings.outputDir ?? 'Default folder, alongside the app'
    },
    {
      label: 'Monitor',
      value: settings.displayId == null ? 'Primary monitor' : `Display ${settings.displayId}`
    },
    { label: 'Resolution', value: describeResolution(settings) },
    { label: 'Frame rate', value: `${settings.framerate} fps` },
    {
      label: 'Encoder',
      value: settings.encoder ?? 'Chosen automatically (not detected yet)'
    },
    { label: 'Quality', value: describeQuality(settings) },
    {
      label: 'Keyframe interval',
      value: `${settings.keyframeIntervalSeconds}s -- also the precision of lossless clip cuts`
    },
    { label: 'Microphone', value: settings.micDeviceName ?? 'Not recorded' },
    {
      label: 'System audio',
      value: settings.desktopAudioDeviceName ?? 'Not recorded'
    },
    {
      label: 'Keep recording after the game ends',
      value: formatSeconds(settings.stopDelayMs)
    },
    {
      label: 'Discard recordings shorter than',
      value: `${formatSeconds(settings.minKeepDurationMs)} -- drops remakes`
    },
    {
      label: 'Replay buffer',
      value: settings.replayBufferEnabled
        ? `Last ${formatSeconds(settings.replayBufferSeconds * 1000)}`
        : 'Off'
    },
    { label: 'Storage limit', value: describeRetention(settings) }
  ]

  return (
    <>
      <dl className="recording-summary">
        {rows.map((row) => (
          <div key={row.label} className="recording-summary-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="settings-row-hint">
        These values are stored and will be used once recording is wired up. Editing them here
        comes with the capture pipeline itself, so nothing on this screen pretends to do something
        it can&apos;t do yet.
      </p>
    </>
  )
}

export default RecordingSettingsSection
