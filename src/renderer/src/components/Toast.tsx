import { useEffect } from 'react'
import { CheckCircle2, X } from 'lucide-react'

interface ToastProps {
  message: string
  onDismiss: () => void
  /** Auto-dismisses after this many ms. Null disables the auto-dismiss. */
  durationMs?: number | null
}

// Minimal, self-contained toast for one-off notifications (e.g. "match data
// finished downloading") that don't warrant a persistent banner. Bottom
// corner, auto-dismissing, with a manual close for anyone who wants it gone
// sooner -- deliberately NOT reused for anything that represents ongoing
// state (that's what BackfillStatusBanner is for).
function Toast({ message, onDismiss, durationMs = 6000 }: ToastProps): JSX.Element {
  useEffect(() => {
    if (durationMs === null) return
    const timer = setTimeout(onDismiss, durationMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, durationMs])

  return (
    <div className="toast" role="status">
      <CheckCircle2 size={16} className="toast-icon" />
      <span className="toast-message">{message}</span>
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  )
}

export default Toast
