import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  FolderOpen,
  Gauge,
  Mic,
  RefreshCw,
  Trash2,
  Volume2
} from 'lucide-react'
import type {
  AudioCaptureDevice,
  CaptureDisplay,
  DiskUsageInfo,
  EncoderCapabilities,
  PreflightResultInfo,
  QualityPresetInfo,
  RecordingFramerate,
  RecordingSettings,
  ResolutionScale,
  RetentionPreviewInfo,
  RetentionSweepInfo
} from '../../../shared/types'
import { BITRATE_OPTIONS, FRAMERATE_OPTIONS, RESOLUTION_OPTIONS } from '../../../shared/types'
import { describeEncoder, findCandidate } from '../../../shared/encoders'
import {
  exceedsRefreshRate,
  outputHeightFor,
  recommendedBitrateKbps
} from '../../../shared/bitrateAdvice'
import {
  MAX_BITRATE_KBPS,
  MAX_MIN_KEEP_MINUTES,
  MIN_BITRATE_KBPS,
  clampBitrateKbps,
  clampMinKeepMinutes,
  describeMinKeep,
  minutesToMs,
  msToMinutes
} from '../../../shared/recordingBounds'

// The recording settings screen.
//
// Laid out to match what people already know from Outplayed: quality presets as
// picker cards, then resolution / bitrate / frame rate, then audio as two
// identical blocks of toggle, device and volume. Anything that would be noise
// for most users -- encoder choice, rate control, keyframe interval, track
// layout -- sits behind an Advanced options disclosure rather than being removed,
// because the people who want it really do want it.

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/** One capture backend and whether it can be used, as reported by the main process. */
interface CaptureBackendInfo {
  id: string
  label: string
  availability: { available: boolean; reason?: string; version?: string }
  active: boolean
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
  const [refreshHz, setRefreshHz] = useState<number | null>(null)
  const [estimate, setEstimate] = useState<{ summary: string } | null>(null)
  const [preflight, setPreflight] = useState<PreflightResultInfo | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [usage, setUsage] = useState<DiskUsageInfo | null>(null)
  const [retentionPreview, setRetentionPreview] = useState<RetentionPreviewInfo | null>(null)
  const [sweepResult, setSweepResult] = useState<RetentionSweepInfo | null>(null)
  const [sweeping, setSweeping] = useState(false)
  const [gpuWarning, setGpuWarning] = useState<string | null>(null)
  const [backends, setBackends] = useState<CaptureBackendInfo[]>([])
  const [installingObs, setInstallingObs] = useState(false)
  const [installProgress, setInstallProgress] = useState<number | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [showVideoAdvanced, setShowVideoAdvanced] = useState(false)
  const [showAudioAdvanced, setShowAudioAdvanced] = useState(false)
  const [outputDir, setOutputDir] = useState<{
    current: string
    default: string
    isCustom: boolean
  } | null>(null)
  const [outputDirError, setOutputDirError] = useState<string | null>(null)
  const [choosingDir, setChoosingDir] = useState(false)

  // Typed fields hold a draft while being edited and commit on blur, so a
  // half-typed number is never saved.
  const [bitrateDraft, setBitrateDraft] = useState('')
  const [bitrateNote, setBitrateNote] = useState<string | null>(null)
  const [minKeepDraft, setMinKeepDraft] = useState('')
  const [minKeepNote, setMinKeepNote] = useState<string | null>(null)

  const loopbackDevices = audioDevices.filter((d) => d.likelyLoopback)

  useEffect(() => {
    window.api.recorder
      .getSettings()
      .then(setSettings)
      .catch((err: Error) => setError(err.message))

    setDetecting(true)
    window.api.recorder
      .getCapabilities()
      .then(setCapabilities)
      .catch((err: Error) => setCapabilityError(err.message))
      .finally(() => setDetecting(false))

    // Advisory lists: they label what's attached so the pickers can say
    // "not connected" rather than showing a stale name.
    window.api.recorder.listDisplays().then(setDisplays).catch(() => setDisplays([]))
    window.api.recorder.listAudioDevices().then(setAudioDevices).catch(() => setAudioDevices([]))
    window.api.recorder.getDiskUsage().then(setUsage).catch(() => setUsage(null))
    window.api.recorder.getOutputDirInfo().then(setOutputDir).catch(() => setOutputDir(null))

    window.api.recorder
      .getGraphicsScheduling()
      .then((report) => setGpuWarning(report.shouldWarn ? report.message : null))
      .catch(() => setGpuWarning(null))

    refreshBackends()

    // An install started from another window, or before this one mounted, is
    // still running -- so the button has to come back disabled rather than
    // inviting a second 179 MB download.
    window.api.recorder.isInstallingObs().then(setInstallingObs).catch(() => undefined)

    refreshQuality().catch(() => {
      // Presets and the estimate are additive; everything else still renders.
    })
  }, [])

  // Install progress arrives on a push channel; the listener is removed on
  // unmount so a closed Settings screen does not keep receiving it.
  useEffect(() => {
    return window.api.recorder.onObsInstallProgress((progress) => {
      setInstallProgress(progress.fraction)
      if (progress.phase === 'done') {
        setInstallProgress(null)
        setInstallingObs(false)
        refreshBackends()
      }
    })
  }, [])

  function refreshBackends(): void {
    window.api.recorder
      .getCaptureBackends()
      .then((list) => setBackends(list as CaptureBackendInfo[]))
      .catch(() => setBackends([]))
  }

  async function handleInstallObs(): Promise<void> {
    setInstallingObs(true)
    setInstallError(null)
    setInstallProgress(0)
    try {
      await window.api.recorder.installObs()
      refreshBackends()
      // The chosen encoder and the presets both depend on what is available, and
      // game capture changes the answer.
      await refreshQuality().catch(() => undefined)
    } catch (err) {
      setInstallError((err as Error).message)
    } finally {
      setInstallingObs(false)
      setInstallProgress(null)
    }
  }

  // Drafts follow the saved settings, including when a preset changes them.
  useEffect(() => {
    if (!settings) return
    setBitrateDraft(String(settings.bitrateKbps))
    setMinKeepDraft(String(msToMinutes(settings.minKeepDurationMs)))
  }, [settings?.bitrateKbps, settings?.minKeepDurationMs])

  /**
   * Saves a typed bitrate.
   *
   * Setting a bitrate also switches rate control to bitrate mode. The field used
   * to be disabled outside that mode, which meant the default configuration
   * shipped with a greyed-out bitrate box and no obvious way to reach it --
   * asking someone to find a dropdown in Advanced options before the number they
   * came here to change becomes editable. Typing a bitrate is an unambiguous
   * request to use it.
   */
  async function commitBitrate(): Promise<void> {
    if (!settings) return
    const result = clampBitrateKbps(Number(bitrateDraft))
    setBitrateNote(result.note)
    setBitrateDraft(String(result.value))

    const needsMode = settings.rateControl !== 'bitrate'
    if (result.value !== settings.bitrateKbps || needsMode) {
      await update({
        bitrateKbps: result.value,
        ...(needsMode ? { rateControl: 'bitrate' as const } : {})
      })
    }
  }

  async function commitMinKeep(): Promise<void> {
    if (!settings) return
    const result = clampMinKeepMinutes(Number(minKeepDraft))
    setMinKeepNote(result.note)
    setMinKeepDraft(String(result.value))
    const ms = minutesToMs(result.value)
    if (ms !== settings.minKeepDurationMs) await update({ minKeepDurationMs: ms })
  }

  async function handleChooseOutputDir(): Promise<void> {
    setChoosingDir(true)
    setOutputDirError(null)
    try {
      const chosen = await window.api.recorder.chooseOutputDir()
      if (chosen) {
        setOutputDir(await window.api.recorder.getOutputDirInfo())
        setSettings(await window.api.recorder.getSettings())
      }
    } catch (err) {
      setOutputDirError((err as Error).message)
    } finally {
      setChoosingDir(false)
    }
  }

  async function handleResetOutputDir(): Promise<void> {
    await window.api.recorder.resetOutputDir()
    setOutputDir(await window.api.recorder.getOutputDirInfo())
    setSettings(await window.api.recorder.getSettings())
  }

  async function refreshQuality(): Promise<void> {
    const [presetInfo, estimateInfo] = await Promise.all([
      window.api.recorder.getPresets(),
      window.api.recorder.estimateBitrate()
    ])
    setPresets(presetInfo.presets)
    setActivePreset(presetInfo.active)
    setRefreshHz(presetInfo.refreshHz ?? null)
    setEstimate(estimateInfo)
  }

  /**
   * Saves a change and adopts whatever comes back.
   *
   * The response is the stored configuration with defaults merged in, so the
   * screen shows what will actually be recorded rather than what was typed.
   */
  async function update(patch: Partial<RecordingSettings>): Promise<void> {
    if (!settings) return
    const saved = await window.api.recorder.saveSettings({ ...settings, ...patch })
    setSettings(saved)
    // Any earlier test result described different settings, so it no longer
    // applies -- leaving it on screen would be a stale reassurance.
    setPreflight(null)
    await refreshQuality()
  }

  async function handlePreset(preset: string): Promise<void> {
    setSettings(await window.api.recorder.applyPreset(preset))
    setPreflight(null)
    await refreshQuality()
  }

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

  async function handlePreviewSweep(): Promise<void> {
    setSweepResult(null)
    setRetentionPreview(await window.api.recorder.previewRetentionSweep())
  }

  /**
   * Deletes exactly what the preview listed.
   *
   * Only reachable once a preview exists, which is the point: this is the one
   * destructive action here, and it never runs without the list having been
   * shown first.
   */
  async function handleRunSweep(): Promise<void> {
    setSweeping(true)
    try {
      setSweepResult(await window.api.recorder.runRetentionSweep())
      setRetentionPreview(null)
      setUsage(await window.api.recorder.getDiskUsage())
    } finally {
      setSweeping(false)
    }
  }

  if (error) {
    return <p className="status status-error">Could not read the recording settings: {error}</p>
  }

  if (!settings) {
    return <p className="settings-row-hint">Reading recording settings...</p>
  }

  const microphones = audioDevices.filter((d) => !d.likelyLoopback)

  // What the current resolution choice actually produces, for the bitrate
  // suggestion. Falls back to 1080p when no display has been read yet.
  const captureDisplay = displays.find((d) => d.id === settings.displayId) ??
    displays.find((d) => d.isPrimary) ?? { width: 1920, height: 1080 }
  const activeOutputHeight = outputHeightFor(settings.resolutionScale, captureDisplay.height)
  const activeOutputWidth = Math.round(
    (activeOutputHeight * (captureDisplay.width / captureDisplay.height)) / 2
  ) * 2
  const suggestedBitrate = recommendedBitrateKbps(
    activeOutputWidth,
    activeOutputHeight,
    settings.framerate
  )

  // Scaling is only the wrong choice when there is a hardware encoder to keep
  // frames on the GPU for. Software encoding genuinely benefits from fewer
  // pixels, so it should not be told off for asking.
  const chosenEncoder = settings.encoder ?? capabilities?.chosen ?? null
  const scalingIsCostly =
    settings.resolutionScale !== 'native' &&
    (findCandidate(chosenEncoder ?? '')?.hardware ?? false)

  const activeBackend = backends.find((backend) => backend.active)
  const obsBackend = backends.find((backend) => backend.id === 'obs')

  return (
    <>
      <div className="recorder-master-row">
        <Toggle
          label="Record my games automatically"
          checked={settings.enabled}
          onChange={(checked) => update({ enabled: checked })}
        />
        <p className="settings-row-hint">
          Starts when a game does and stops when it ends. LeagueVid keeps running in the tray with
          the window closed, so nothing is missed.
        </p>
      </div>

      <h3 className="recorder-subheading">Capture method</h3>
      <p className="subtitle">
        How LeagueVid gets the picture. Game capture reads the frames the game itself draws; screen
        capture copies the desktop, which cannot see a game running in exclusive fullscreen and
        competes with it for the graphics card.
      </p>

      <div className="recorder-field">
        <label htmlFor="rec-backend">Method</label>
        <select
          id="rec-backend"
          value={settings.captureBackend ?? 'auto'}
          onChange={(e) =>
            update({
              captureBackend:
                e.target.value === 'auto'
                  ? null
                  : (e.target.value as NonNullable<RecordingSettings['captureBackend']>)
            })
          }
        >
          <option value="auto">Automatic (recommended)</option>
          {backends.map((backend) => (
            <option key={backend.id} value={backend.id}>
              {backend.label}
              {backend.availability.available ? '' : ' — not available'}
            </option>
          ))}
        </select>
        <p className="settings-row-hint">
          {activeBackend
            ? `Recording with ${activeBackend.label}.`
            : 'Automatic picks game capture when it is available.'}
        </p>
      </div>

      {obsBackend && !obsBackend.availability.available && (
        <div className="recorder-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {obsBackend.availability.reason}
            {installError ? ` ${installError}` : ''}
          </span>
        </div>
      )}

      {obsBackend && !obsBackend.availability.available && (
        <div className="recorder-field">
          <button type="button" onClick={handleInstallObs} disabled={installingObs}>
            {installingObs
              ? installProgress != null
                ? `Downloading OBS… ${Math.round(installProgress * 100)}%`
                : 'Installing OBS…'
              : 'Download OBS for LeagueVid'}
          </button>
          <p className="settings-row-hint">
            About 180 MB to download and 470 MB on disk. It is kept separate from any OBS you
            already use, so your own scenes and settings are left alone.
          </p>
        </div>
      )}

      <h3 className="recorder-subheading">Video</h3>
      <p className="subtitle">Control your video resolution and frame rate.</p>

      {gpuWarning && (
        <div className="recorder-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{gpuWarning}</span>
        </div>
      )}

      <div className="recorder-preset-grid">
        {presets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            className={`recorder-preset-card${
              activePreset === preset.name ? ' recorder-preset-card--active' : ''
            }`}
            onClick={() => handlePreset(preset.name)}
            aria-pressed={activePreset === preset.name}
            title={preset.description}
          >
            <span className="recorder-preset-radio" aria-hidden="true" />
            <span className="recorder-preset-body">
              <span className="recorder-preset-name">{preset.label}</span>
              <span className="recorder-preset-summary">{preset.summary}</span>
            </span>
          </button>
        ))}
        <div
          className={`recorder-preset-card${
            activePreset === 'custom' ? ' recorder-preset-card--active' : ''
          }`}
          aria-current={activePreset === 'custom'}
        >
          <span className="recorder-preset-radio" aria-hidden="true" />
          <span className="recorder-preset-body">
            <span className="recorder-preset-name">Custom</span>
            <span className="recorder-preset-summary">Use your own settings</span>
          </span>
        </div>
      </div>

      <div className="recorder-field">
        <label htmlFor="rec-resolution">Resolution</label>
        <select
          id="rec-resolution"
          value={settings.resolutionScale}
          onChange={(e) => update({ resolutionScale: e.target.value as ResolutionScale })}
        >
          {RESOLUTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Counter-intuitive enough to be worth saying out loud, because picking a
          smaller resolution to "go easy on the machine" does the opposite here:
          the bundled ffmpeg has no GPU scaler, so anything but Native copies
          every frame out of the GPU into system memory before encoding. */}
      {scalingIsCostly && (
        <p className="settings-row-hint">
          Native is the cheapest option, not the most expensive. Scaling to{' '}
          {activeOutputHeight}p copies every frame out of your GPU and back, which drops more
          frames than the extra pixels ever would.{' '}
          <button
            type="button"
            className="link-button"
            style={{ padding: 0 }}
            onClick={() => update({ resolutionScale: 'native' })}
          >
            use Native
          </button>
        </p>
      )}

      <div className="recorder-field">
        <label htmlFor="rec-bitrate">Bitrate (kbps)</label>
        <div className="recorder-bitrate">
          {/* A number field with suggestions rather than a fixed dropdown: the
              common values are one click away, and anyone who knows they want
              7350 can just type it. */}
          <input
            id="rec-bitrate"
            type="number"
            list="rec-bitrate-options"
            min={MIN_BITRATE_KBPS}
            max={MAX_BITRATE_KBPS}
            step={500}
            value={bitrateDraft}
            onChange={(e) => setBitrateDraft(e.target.value)}
            // Committed on blur rather than per keystroke, so typing "12000"
            // doesn't briefly save 1, then 12, then 120.
            onBlur={() => commitBitrate()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitBitrate()
            }}
          />
          <datalist id="rec-bitrate-options">
            {BITRATE_OPTIONS.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <span className="recorder-inline-hint">kbps</span>
        </div>
      </div>

      {bitrateNote && <p className="settings-row-hint status-error">{bitrateNote}</p>}

      {settings.rateControl !== 'bitrate' && (
        <p className="settings-row-hint">
          Constant quality is in use, so the encoder spends whatever each scene needs and this
          number isn&apos;t applied yet. Changing it switches to fixed bitrate.
        </p>
      )}

      {suggestedBitrate !== null && suggestedBitrate !== settings.bitrateKbps && (
        <p className="settings-row-hint">
          For {activeOutputHeight}p at {settings.framerate} fps, around{' '}
          {Math.round(suggestedBitrate / 1000)} Mbps suits game footage.{' '}
          <button
            type="button"
            className="link-button"
            style={{ padding: 0 }}
            onClick={() => update({ bitrateKbps: suggestedBitrate, rateControl: 'bitrate' })}
          >
            use {suggestedBitrate} kbps
          </button>
        </p>
      )}

      <div className="recorder-field">
        <label>Frame rate (FPS)</label>
        <div className="recorder-segmented" role="group" aria-label="Frame rate">
          {FRAMERATE_OPTIONS.map((fps) => {
            const beyondRefresh = exceedsRefreshRate(fps, refreshHz)
            return (
              <button
                key={fps}
                type="button"
                className={[
                  settings.framerate === fps ? 'recorder-segment--active' : '',
                  beyondRefresh ? 'recorder-segment--beyond' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => update({ framerate: fps as RecordingFramerate })}
                aria-pressed={settings.framerate === fps}
                title={
                  beyondRefresh
                    ? `Above your display's ${refreshHz} Hz — the extra frames would be duplicates`
                    : undefined
                }
              >
                {fps}
              </button>
            )
          })}
        </div>
      </div>

      {estimate && <p className="settings-row-hint">{estimate.summary} at these settings.</p>}

      <Disclosure
        open={showVideoAdvanced}
        onToggle={() => setShowVideoAdvanced((open) => !open)}
        label="Advanced options"
      >
        <div className="clips-dir-row">
          <div className="clips-dir-path">
            <span className="clip-field-label">Video encoder</span>
            {detecting && !capabilities ? (
              <code>Checking what this machine can do...</code>
            ) : capabilityError ? (
              <code className="status-error">{capabilityError}</code>
            ) : capabilities ? (
              <>
                <code>
                  Detected: {describeEncoder(settings.encoder ?? capabilities.chosen)}
                  {!settings.encoder && ', chosen automatically'}
                </code>
                {!capabilities.chosen && (
                  <span className="settings-row-hint status-error">
                    No usable encoder was found, so recording won&apos;t be possible here.
                  </span>
                )}
                {capabilities.chosen === 'libx264' && (
                  <span className="settings-row-hint">
                    Software encoding only — no hardware encoder passed its test. Recording will
                    use CPU the game also wants, so lower settings are advisable.
                  </span>
                )}
                {!capabilities.hasDdagrab && (
                  <span className="settings-row-hint status-error">
                    This build has no <code>ddagrab</code> filter, which is how screens are
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
                    {!outcome.available
                      ? 'not in this build'
                      : outcome.passed
                        ? 'works'
                        : 'failed'}
                  </span>
                  {outcome.error && <span className="settings-row-hint">{outcome.error}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="recorder-field">
          <label htmlFor="rec-ratecontrol">Rate control</label>
          <select
            id="rec-ratecontrol"
            value={settings.rateControl}
            onChange={(e) =>
              update({ rateControl: e.target.value as RecordingSettings['rateControl'] })
            }
          >
            <option value="bitrate">Fixed bitrate — predictable file size</option>
            <option value="quality">Constant quality — better picture per byte</option>
          </select>
        </div>

        {settings.rateControl === 'quality' && (
          <div className="recorder-field">
            <label htmlFor="rec-quality">Quality ({settings.quality})</label>
            <input
              id="rec-quality"
              type="range"
              min={14}
              max={34}
              value={settings.quality}
              onChange={(e) => update({ quality: Number(e.target.value) })}
            />
            <span className="settings-row-hint">Lower is better quality and a bigger file.</span>
          </div>
        )}

        <div className="recorder-field">
          <label htmlFor="rec-monitor">Monitor</label>
          <select
            id="rec-monitor"
            value={settings.displayId ?? ''}
            onChange={(e) =>
              update({ displayId: e.target.value === '' ? null : Number(e.target.value) })
            }
          >
            <option value="">Primary monitor</option>
            {displays.map((display) => (
              <option key={display.id} value={display.id}>
                {display.label}
              </option>
            ))}
          </select>
        </div>

        {displays.length > 1 && (
          <p className="settings-row-hint">
            Which monitor a capture index points at is a guess: Windows and the graphics driver
            enumerate displays separately, and on a laptop with two GPUs an index can address the
            wrong adapter. Run the ten-second test after changing this to confirm you got the
            screen you meant.
          </p>
        )}

        <div className="recorder-field">
          <label htmlFor="rec-keyframe">Keyframe interval</label>
          <select
            id="rec-keyframe"
            value={settings.keyframeIntervalSeconds}
            onChange={(e) => update({ keyframeIntervalSeconds: Number(e.target.value) })}
          >
            <option value={1}>Every second — most precise clip cuts</option>
            <option value={2}>Every 2 seconds</option>
            <option value={5}>Every 5 seconds — smallest files</option>
          </select>
        </div>
        <p className="settings-row-hint">
          This also sets how precisely the clip editor&apos;s lossless cut can start, since that
          mode can only begin on a keyframe.
        </p>

        <Toggle
          label="Show the mouse cursor in recordings"
          checked={settings.drawMouse}
          onChange={(checked) => update({ drawMouse: checked })}
        />
      </Disclosure>

      <h3 className="recorder-subheading">Audio</h3>

      <div className="recorder-audio-block">
        <Toggle
          label="Capture system sound"
          checked={settings.captureSystemAudio}
          onChange={(checked) => update({ captureSystemAudio: checked })}
        />

        {settings.captureSystemAudio && (
          <>
            <div className="recorder-field">
              <label htmlFor="rec-sysaudio">
                <Volume2 size={14} aria-hidden="true" /> Device
              </label>
              <select
                id="rec-sysaudio"
                value={settings.desktopAudioDeviceName ?? ''}
                onChange={(e) =>
                  update({ desktopAudioDeviceName: e.target.value === '' ? null : e.target.value })
                }
              >
                <option value="">Windows (captured directly, no extra driver)</option>
                {loopbackDevices.map((device) => (
                  <option key={device.name} value={device.name}>
                    {device.name}
                  </option>
                ))}
              </select>
            </div>

            <VolumeSlider
              id="rec-sysvolume"
              value={settings.systemAudioVolume}
              onChange={(value) => update({ systemAudioVolume: value })}
            />

            {loopbackDevices.length === 0 && !settings.desktopAudioDeviceName && (
              <p className="settings-row-hint">
                You have no Stereo Mix or virtual audio cable installed, so game sound is captured
                from Windows directly. Nothing to install.
              </p>
            )}
          </>
        )}
      </div>

      <div className="recorder-audio-block">
        <Toggle
          label="Capture microphone"
          checked={settings.captureMicrophone}
          onChange={(checked) => update({ captureMicrophone: checked })}
        />

        {settings.captureMicrophone && (
          <>
            <div className="recorder-field">
              <label htmlFor="rec-mic">
                <Mic size={14} aria-hidden="true" /> Device
              </label>
              <select
                id="rec-mic"
                value={settings.micDeviceName ?? ''}
                onChange={(e) =>
                  update({ micDeviceName: e.target.value === '' ? null : e.target.value })
                }
              >
                <option value="">Choose a microphone...</option>
                {microphones.map((device) => (
                  <option key={device.name} value={device.name}>
                    {device.name}
                  </option>
                ))}
              </select>
            </div>

            <VolumeSlider
              id="rec-micvolume"
              value={settings.micVolume}
              onChange={(value) => update({ micVolume: value })}
            />

            {!settings.micDeviceName && (
              <p className="settings-row-hint status-error">
                Pick a microphone, or recordings will have no voice track.
              </p>
            )}
          </>
        )}
      </div>

      <Disclosure
        open={showAudioAdvanced}
        onToggle={() => setShowAudioAdvanced((open) => !open)}
        label="Advanced options"
      >
        <div className="recorder-field">
          <label htmlFor="rec-tracks">Track layout</label>
          <select
            id="rec-tracks"
            value={settings.audioTrackMode}
            onChange={(e) =>
              update({ audioTrackMode: e.target.value as RecordingSettings['audioTrackMode'] })
            }
          >
            <option value="mixed">One mixed track — plays anywhere</option>
            <option value="separate">Separate tracks — editable later</option>
          </select>
        </div>
        <p className="settings-row-hint">
          Separate tracks keep your voice and the game on their own channels, which is what you
          want if you plan to edit. Some players only read the first track.
        </p>
      </Disclosure>

      <h3 className="recorder-subheading">Test and storage</h3>

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
              frame rate it actually managed, how many frames it dropped, and how big the file was.
              An estimate can say what a setting should cost; only a real capture can say whether
              this machine keeps up.
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

      <div className="clips-dir-row">
        <div className="clips-dir-path">
          <span className="clip-field-label">Disk space</span>
          <code>{usage ? usage.summary : 'Checking...'}</code>
          {retentionPreview && (
            <>
              <span
                className={
                  retentionPreview.files.length > 0
                    ? 'settings-row-hint status-error'
                    : 'settings-row-hint'
                }
              >
                {retentionPreview.summary}
              </span>
              {retentionPreview.files.map((file) => (
                <span key={file.videoId} className="settings-row-hint">
                  {file.fileName} — {(file.sizeBytes / 1024 ** 3).toFixed(2)} GB — {file.reason}
                </span>
              ))}
            </>
          )}
          {sweepResult && (
            <span className="settings-row-hint status-success">
              Deleted {sweepResult.deletedCount} recording(s), freeing{' '}
              {(sweepResult.freedBytes / 1024 ** 3).toFixed(2)} GB.
              {sweepResult.failures.length > 0 &&
                ` ${sweepResult.failures.length} couldn't be removed.`}
            </span>
          )}
          {!settings.retentionEnabled && (
            <span className="settings-row-hint">
              Automatic deletion is off. Nothing is ever removed unless you turn it on, and even
              then only recordings LeagueVid made itself — never files you imported, and never
              anything marked as a favourite.
            </span>
          )}
        </div>
        <div className="clips-dir-actions">
          <button className="secondary" onClick={handlePreviewSweep} disabled={sweeping}>
            <Trash2 size={15} /> Preview cleanup
          </button>
          {retentionPreview && retentionPreview.files.length > 0 && (
            <button onClick={handleRunSweep} disabled={sweeping}>
              {sweeping ? 'Deleting...' : `Delete these ${retentionPreview.files.length}`}
            </button>
          )}
        </div>
      </div>

      <h3 className="recorder-subheading">Where recordings go</h3>

      {outputDir && (
        <div className="clips-dir-row">
          <div className="clips-dir-path">
            <span className="clip-field-label">
              {outputDir.isCustom ? 'Custom folder' : 'Default folder'}
            </span>
            <code>{outputDir.current}</code>
            {!outputDir.isCustom && (
              <span className="settings-row-hint">
                Inside LeagueVid&apos;s own folder, so everything the app produces stays in one
                place you already know about.
              </span>
            )}
            {outputDirError && <span className="status status-error">{outputDirError}</span>}
          </div>
          <div className="clips-dir-actions">
            <button onClick={handleChooseOutputDir} disabled={choosingDir}>
              <FolderOpen size={15} /> {choosingDir ? 'Choosing...' : 'Change folder'}
            </button>
            <button
              className="secondary"
              onClick={() => window.api.recorder.revealOutputFolder()}
              title="Open this folder"
            >
              Open
            </button>
            {outputDir.isCustom && (
              <button className="secondary" onClick={handleResetOutputDir}>
                Reset to default
              </button>
            )}
          </div>
        </div>
      )}

      <div className="recorder-field">
        <label htmlFor="rec-minkeep">Delete recordings under</label>
        <div className="recorder-bitrate">
          <input
            id="rec-minkeep"
            type="number"
            min={0}
            max={MAX_MIN_KEEP_MINUTES}
            step={0.25}
            value={minKeepDraft}
            onChange={(e) => setMinKeepDraft(e.target.value)}
            onBlur={() => commitMinKeep()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitMinKeep()
            }}
          />
          <span className="recorder-inline-hint">minutes (0 keeps everything)</span>
        </div>
      </div>
      <p className="settings-row-hint">{describeMinKeep(settings.minKeepDurationMs)}</p>
      {minKeepNote && <p className="settings-row-hint status-error">{minKeepNote}</p>}

      <div className="recorder-field">
        <label htmlFor="rec-stopdelay">Keep recording after the game</label>
        <select
          id="rec-stopdelay"
          value={settings.stopDelayMs}
          onChange={(e) => update({ stopDelayMs: Number(e.target.value) })}
        >
          <option value={0}>Stop immediately</option>
          <option value={10000}>10 seconds</option>
          <option value={20000}>20 seconds</option>
          <option value={45000}>45 seconds</option>
          <option value={90000}>90 seconds</option>
        </select>
      </div>
      <p className="settings-row-hint">
        Captures the post-game screen — final scoreboard and damage graphs — instead of cutting the
        moment the game stops responding. Currently {formatSeconds(settings.stopDelayMs)}.
      </p>

      <div className="recorder-audio-block">
        <Toggle
          label="Start LeagueVid with Windows, hidden in the tray"
          checked={settings.launchAtLogin}
          onChange={(checked) => update({ launchAtLogin: checked })}
        />
      </div>
    </>
  )
}

/** Switch styled like the pink toggles in the reference layout. */
function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="recorder-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label || undefined}
      />
      <span className="recorder-toggle-track" aria-hidden="true">
        <span className="recorder-toggle-knob" />
      </span>
      {label && <span className="recorder-toggle-label">{label}</span>}
    </label>
  )
}

function VolumeSlider({
  id,
  value,
  onChange
}: {
  id: string
  value: number
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="recorder-field">
      <label htmlFor={id}>Volume</label>
      <div className="recorder-volume">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="recorder-volume-value">{value}</span>
      </div>
    </div>
  )
}

function Disclosure({
  open,
  onToggle,
  label,
  children
}: {
  open: boolean
  onToggle: () => void
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="recorder-disclosure">
      <button
        type="button"
        className="recorder-disclosure-trigger"
        onClick={onToggle}
        aria-expanded={open}
      >
        <ChevronRight
          size={15}
          className={open ? 'recorder-disclosure-chevron--open' : ''}
          aria-hidden="true"
        />
        {label}
      </button>
      {open && <div className="recorder-disclosure-body">{children}</div>}
    </div>
  )
}

export default RecordingSettingsSection
