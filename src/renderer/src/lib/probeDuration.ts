// Probes a local video file's duration by loading it into a hidden, detached
// <video> element and reading .duration once metadata loads. Used to filter
// out short clips (e.g. death replays, highlight snippets) when auto-importing
// a whole folder, since only full match recordings should be imported.
export function probeVideoDurationMs(mediaUrl: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    const videoEl = document.createElement('video')
    videoEl.preload = 'metadata'
    videoEl.muted = true

    let settled = false
    const finish = (value: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      videoEl.removeAttribute('src')
      videoEl.load()
      resolve(value)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)

    videoEl.addEventListener('loadedmetadata', () => {
      const duration = videoEl.duration
      finish(Number.isFinite(duration) ? duration * 1000 : null)
    })
    videoEl.addEventListener('error', () => finish(null))

    videoEl.src = mediaUrl
  })
}
