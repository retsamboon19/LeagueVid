import { Circle, Square } from 'lucide-react'
import type { RecorderPhase, RecorderStateSnapshot } from '../../../shared/types'
import { useRecorder } from '../lib/useRecorder'

// Header status pill for the recorder.
//
// Deliberately quiet when there is nothing to say: a recorder that is off or
// idle shows a small, unobtrusive control, and only a live session gets a red
// dot and a running timer. The one thing it must never do is look idle while
// recording, or look like it is recording when it isn't -- which is why it
// renders the phase it was given rather than tracking a local guess.

const PHASE_LABELS: Record<RecorderPhase, string> = {
  disabled: 'Recording off',
  idle: 'Ready to record',
  arming: 'Game detected',
  starting: 'Starting',
  recording: 'Recording',
  stopping: 'Finishing',
  remuxing: 'Converting',
  finalizing: 'Saving',
  failed: 'Recording failed'
}

/** Phases in which stopping is meaningful. */
const STOPPABLE: RecorderPhase[] = ['starting', 'recording']

/** Phases that shouldn't be interrupted with a new start. */
const BUSY: RecorderPhase[] = [
  'arming',
  'starting',
  'recording',
  'stopping',
  'remuxing',
  'finalizing'
]

function formatElapsed(startedAt: number | null, outTimeMs: number | null): string {
  // Prefer ffmpeg's own output position: it counts recorded footage, which is
  // what the user cares about, and it doesn't drift if the clock changes.
  const ms = outTimeMs ?? (startedAt ? Date.now() - startedAt : 0)
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

function RecorderIndicator(): JSX.Element | null {
  const { state, progress, warning } = useRecorder()

  // Nothing is known yet -- render nothing rather than a misleading "off".
  if (!state) return null

  const phase = state.phase
  const isRecording = phase === 'recording'
  const canStop = STOPPABLE.includes(phase)
  const busy = BUSY.includes(phase)

  async function handleClick(): Promise<void> {
    if (canStop) {
      await window.api.recorder.stopManual()
      return
    }
    if (!busy) await window.api.recorder.startManual()
  }

  return (
    <div
      className={`recorder-indicator recorder-indicator-${phase}`}
      title={describe(state, warning)}
    >
      <span className="recorder-indicator-status">
        <Circle
          size={9}
          className={isRecording ? 'recorder-dot recorder-dot-live' : 'recorder-dot'}
          aria-hidden="true"
        />
        <span>{PHASE_LABELS[phase]}</span>
      </span>

      {isRecording && (
        <span className="recorder-indicator-meta">
          {formatElapsed(state.startedAt, progress?.outTimeMs ?? null)}
          {progress && progress.totalSizeBytes > 0 && ` · ${formatSize(progress.totalSizeBytes)}`}
        </span>
      )}

      {warning && (
        <span className="recorder-indicator-warning" role="status">
          {warning}
        </span>
      )}

      <button
        type="button"
        className="link-button recorder-indicator-action"
        onClick={handleClick}
        disabled={busy && !canStop}
        aria-label={canStop ? 'Stop recording' : 'Start recording now'}
      >
        {canStop ? <Square size={13} /> : <Circle size={13} />}
        {canStop ? 'Stop' : 'Record'}
      </button>
    </div>
  )
}

function describe(state: RecorderStateSnapshot, warning: string | null): string {
  const parts = [PHASE_LABELS[state.phase]]
  if (state.detail) parts.push(state.detail)
  if (warning && warning !== state.detail) parts.push(warning)
  if (state.outputPath) parts.push(state.outputPath)
  return parts.join(' — ')
}

export default RecorderIndicator
