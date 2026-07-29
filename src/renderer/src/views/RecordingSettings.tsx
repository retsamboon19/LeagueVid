import { useEffect, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import type {
  AudioCaptureDevice,
  CaptureDisplay,
  EncoderCapabilities,
  PreflightResultInfo,
  QualityPresetInfo,
  RecordingSettings
} from '../../../shared/types'
import { describeEncoder } from '../../../shared/encoders'

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

function describeDisplay(displayId: number | null, displays: CaptureDisplay[]): string {
  if (displayId == null) {
    const primary = displays.find((d) => d.isPrimary)
    return primary ? `${primary.label}, chosen as the primary` : 'Primary monitor'
  }
  const match = displays.find((d) => d.id === displayId)
  // A display can be unplugged between saving the setting and reading it, in
  // which case recording falls back to primary rather than refusing to start.
  return match ? match.label : `Display ${displayId} (not currently connected)`
}

function describeAudio(
  deviceName: string | null,
  devices: AudioCaptureDevice[],
  fallback: string
): string {
  if (!deviceName) return fallback
  return devices.some((d) => d.name === deviceName)
    ? deviceName
    : `${deviceName} (not currently connected)`
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
  const [capabilities, setCapabilities] = useState<EncoderCapabilities | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [capabilityError, setCapabilityError] = useState<string | null>(null)
  const [displays, setDisplays] = useState<CaptureDisplay[]>([])
  const [audioDevices, setAudioDevices] = useState<AudioCaptureDevice[]>([])
  const [presets, setPresets] = useState<QualityPresetInfo[]>([])
  const [activePreset, setActivePreset] = useState<string>('custom')
  const [estimate, setEstimate] = useState<{ summary: string } | null>(null)
  const [preflight, setPreflight] = useState<PreflightResultInfo | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const loopbackDevices = audioDevices.filter((d) => d.likelyLoopback)

  async function refreshQuality(): Promise<void> {
    const [presetInfo, estimateInfo] = await Promise.all([
      window.api.recorder.getPresets(),
      window.api.recorder.estimateBitrate()
    ])
    setPresets(presetInfo.presets)
    setActivePreset(presetInfo.active)
    setEstimate(estimateInfo)
  }

  async function handlePreset(preset: string): Promise<void> {
    setSettings(await window.api.recorder.applyPreset(preset))
    // A different preset means a different expected cost, and any earlier test
    // result no longer describes what would be recorded.
    setPreflight(null)
    await refreshQuality()
  }

  async function handlePreflight(): Promise<void> {
    setTesting(true)
    setPreflightError(null)
    setPreflight(null)
    try {
      setPreflight(await window.api.recorder.runPreflightTest())
    } catch (err) {
      setPreflightError((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  useEffect(() => {
    window.api.recorder
      .getSettings()
      .then(setSettings)
      .catch((err: Error) => setError(err.message))

    // Both lists are advisory: they label what's currently attached so the
    // summary can say "not connected" instead of showing a stale id.
    window.api.recorder.listDisplays().then(setDisplays).catch(() => setDisplays([]))
    window.api.recorder.listAudioDevices().then(setAudioDevices).catch(() => setAudioDevices([]))

    refreshQuality().catch(() => {
      // Presets and the estimate are additive; the summary below still renders.
    })

    // The first call after install probes the machine (one child process per
    // candidate), so this can take a few seconds. Every later launch reads
    // the cached result.
    setDetecting(true)
    window.api.recorder
      .getCapabilities()
      .then(setCapabilities)
      .catch((err: Error) => setCapabilityError(err.message))
      .finally(() => setDetecting(false))
  }, [])

  async function handleRedetect(): Promise<void> {
    setDetecting(true)
    setCapabilityError(null)
    try {
      setCapabilities(await window.api.recorder.refreshCapabilities())
    } catch (err) {
      setCapabilityError((err as Error).message)
    } finally {
      setDetecting(false)
    }
  }

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
      value: describeDisplay(settings.displayId, displays)
    },
    { label: 'Resolution', value: describeResolution(settings) },
    { label: 'Frame rate', value: `${settings.framerate} fps` },
    {
      label: 'Encoder',
      value: settings.encoder
        ? describeEncoder(settings.encoder)
        : capabilities
          ? `${describeEncoder(capabilities.chosen)}, chosen automatically`
          : 'Chosen automatically'
    },
    { label: 'Quality', value: describeQuality(settings) },
    {
      label: 'Keyframe interval',
      value: `${settings.keyframeIntervalSeconds}s -- also the precision of lossless clip cuts`
    },
    {
      label: 'Microphone',
      value: describeAudio(settings.micDeviceName, audioDevices, 'Not recorded')
    },
    {
      label: 'System audio',
      value: settings.desktopAudioDeviceName
        ? describeAudio(settings.desktopAudioDeviceName, audioDevices, 'Not recorded')
        : settings.useLoopbackBridge
          ? 'Captured from Windows directly'
          : loopbackDevices.length > 0
            ? `Not recorded (${loopbackDevices[0].name} is available)`
            : 'Not recorded'
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
      label: 'Start with Windows',
      value: settings.launchAtLogin ? 'Yes, hidden in the tray' : 'No'
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
      <div className="clips-dir-row">
        <div className="clips-dir-path">
          <span className="clip-field-label">Video encoder</span>
          {detecting && !capabilities ? (
            <code>Checking what this machine can do...</code>
          ) : capabilityError ? (
            <code className="status-error">{capabilityError}</code>
          ) : capabilities ? (
            <>
              <code>Detected: {describeEncoder(capabilities.chosen)}</code>
              {!capabilities.chosen && (
                <span className="settings-row-hint status-error">
                  No usable encoder was found, so recording won&apos;t be possible on this machine.
                </span>
              )}
              {capabilities.chosen === 'libx264' && (
                <span className="settings-row-hint">
                  Software encoding only -- no hardware encoder on this machine passed its test.
                  Recording will use CPU the game is also using, so lower settings are advisable.
                </span>
              )}
              {!capabilities.hasDdagrab && (
                <span className="settings-row-hint status-error">
                  This ffmpeg build has no <code>ddagrab</code> filter, which is how screens are
                  captured. Recording won&apos;t work without it.
                </span>
              )}
            </>
          ) : (
            <code>Not detected yet</code>
          )}
        </div>
        <div className="clips-dir-actions">
          <button onClick={handleRedetect} disabled={detecting}>
            <RefreshCw size={15} className={detecting ? 'spin' : ''} />{' '}
            {detecting ? 'Testing...' : 'Re-detect'}
          </button>
        </div>
      </div>

      {capabilities && (
        <details className="recording-probe-details">
          <summary>
            Encoder test results ({capabilities.outcomes.filter((o) => o.passed).length} of{' '}
            {capabilities.outcomes.length} working)
          </summary>
          <ul>
            {capabilities.outcomes.map((outcome) => (
              <li key={outcome.name}>
                <code>{outcome.name}</code>{' '}
                <span className={outcome.passed ? 'status-success' : 'status-error'}>
                  {!outcome.available ? 'not in this build' : outcome.passed ? 'works' : 'failed'}
                </span>
                {outcome.error && <span className="settings-row-hint">{outcome.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="recording-presets">
        <span className="clip-field-label">Quality</span>
        <div className="recording-preset-buttons">
          {presets.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className={activePreset === preset.name ? '' : 'secondary'}
              onClick={() => handlePreset(preset.name)}
              title={preset.description}
            >
              {preset.label}
            </button>
          ))}
          {activePreset === 'custom' && <span className="recording-preset-custom">Custom</span>}
        </div>
        {estimate && <p className="settings-row-hint">{estimate.summary} at these settings.</p>}
      </div>

      <div className="clips-dir-row">
        <div className="clips-dir-path">
          <span className="clip-field-label">Test these settings</span>
          {preflight ? (
            <>
              <code className={preflight.verdict.ok ? 'status-success' : 'status-error'}>
                {preflight.verdict.headline}
              </code>
              {preflight.verdict.details.map((detail) => (
                <span key={detail} className="settings-row-hint">
                  {detail}
                </span>
              ))}
              {preflight.verdict.recommendation && (
                <span className="settings-row-hint status-error">
                  {preflight.verdict.recommendation}
                </span>
              )}
            </>
          ) : (
            <span className="settings-row-hint">
              Records your screen for ten seconds using exactly these settings, then reports the
              framerate it actually managed, how many frames it dropped, and how big the file
              was. An estimate can tell you what a setting should cost; only a real capture can
              tell you whether this machine keeps up with it.
            </span>
          )}
          {preflightError && <span className="status status-error">{preflightError}</span>}
        </div>
        <div className="clips-dir-actions">
          <button onClick={handlePreflight} disabled={testing}>
            <Gauge size={15} /> {testing ? 'Recording 10s...' : 'Test for 10 seconds'}
          </button>
        </div>
      </div>

      {displays.length > 1 && (
        <p className="settings-row-hint">
          {displays.length} monitors detected. Which one a capture index points at is a guess:
          Windows and the graphics driver enumerate displays separately, and on a laptop with two
          GPUs an index can address the wrong adapter entirely. That&apos;s why the monitor is a
          setting rather than something LeagueVid decides for you.
        </p>
      )}

      {audioDevices.length > 0 &&
        loopbackDevices.length === 0 &&
        !settings.desktopAudioDeviceName && (
          <p className="settings-row-hint">
            None of your {audioDevices.length} audio devices carries desktop sound -- the bundled
            encoder can only read microphone-style inputs on Windows, and you have no Stereo Mix or
            virtual cable installed.{' '}
            {settings.useLoopbackBridge
              ? 'LeagueVid captures game audio from Windows directly instead, so no extra driver is needed.'
              : 'LeagueVid can capture it from Windows directly instead, without any extra driver. Until that is switched on, recordings will have no game sound rather than a silent track you discover later.'}
          </p>
        )}

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
