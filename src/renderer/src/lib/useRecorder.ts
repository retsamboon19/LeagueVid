import { useEffect, useState } from 'react'
import type { RecorderProgress, RecorderStateSnapshot } from '../../../shared/types'

// Subscribes to the recorder.
//
// Pulls once on mount, then subscribes. Both halves are necessary: the push
// channels only deliver *changes*, so a component mounting halfway through a
// recording would otherwise show an idle recorder until the next update
// happened to arrive -- which, between progress samples, could be a second, and
// between phase changes could be forty minutes.

export interface RecorderView {
  state: RecorderStateSnapshot | null
  progress: RecorderProgress | null
  /** Latest warning or failure, e.g. dropped frames. Cleared on phase change. */
  warning: string | null
  dismissWarning: () => void
}

export function useRecorder(): RecorderView {
  const [state, setState] = useState<RecorderStateSnapshot | null>(null)
  const [progress, setProgress] = useState<RecorderProgress | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    window.api.recorder.getState().then((initial) => {
      // A push may have landed while the pull was in flight; the push is newer,
      // so it wins.
      if (!cancelled) setState((current) => current ?? initial)
    })
    window.api.recorder.getProgress().then((initial) => {
      if (!cancelled) setProgress((current) => current ?? initial)
    })

    const offState = window.api.recorder.onState((next) => {
      setState(next)
      // A new phase makes an old warning stale -- dropped frames from the last
      // recording shouldn't hang over the next one.
      setWarning(next.error)
      if (next.progress) setProgress(next.progress)
    })
    const offProgress = window.api.recorder.onProgress(setProgress)
    const offError = window.api.recorder.onError(setWarning)

    return () => {
      cancelled = true
      offState()
      offProgress()
      offError()
    }
  }, [])

  return {
    state,
    progress,
    warning,
    dismissWarning: () => setWarning(null)
  }
}
