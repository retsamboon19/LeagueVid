import { useState } from 'react'
import { FileVideo, FolderOpen, X } from 'lucide-react'
import { probeDurationsBatch } from '../lib/probeDurationBatch'

interface AddMediaPopupProps {
  onClose: () => void
  onImported: () => void
}

// Videos shorter than this are assumed to be highlight clips / death replays
// rather than full match recordings, and are skipped during folder import.
const MIN_MATCH_DURATION_MS = 5 * 60 * 1000

function AddMediaPopup({ onClose, onImported }: AddMediaPopupProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAddFile(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const file = await window.api.video.selectFile()
      if (!file) {
        setBusy(false)
        return
      }
      // Probed the same way folder import does (see handleAddFolder) --
      // without this, a single-file add left duration_ms unset, which
      // silently broke anything derived from it later: the tile's duration
      // display, CS/min, and the resume-last-position feature.
      setProgress(`Checking duration: ${file.fileName}`)
      const [probed] = await probeDurationsBatch([file])
      await window.api.db.insertVideo({
        filePath: file.filePath,
        fileName: file.fileName,
        recordedAt: file.recordedAt,
        durationMs: probed?.durationMs ?? undefined
      })
      onImported()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    } finally {
      setProgress(null)
    }
  }

  async function handleAddFolder(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const folderPath = await window.api.video.selectFolder()
      if (!folderPath) {
        setBusy(false)
        return
      }

      const folder = await window.api.db.addLinkedFolder(folderPath)
      const files = await window.api.video.scanFolder(folderPath)

      let imported = 0
      let skipped = 0

      const probed = await probeDurationsBatch(files, (done, total, file) => {
        setProgress(`Checking ${done} of ${total}: ${file.fileName}`)
      })

      // One database save for the whole import rather than one per file --
      // saving rewrites the entire DB file, so per-file saves dominate the
      // cost of a large folder scan.
      await window.api.db.beginBulkWrites()
      try {
        for (const { file, durationMs } of probed) {
          if (durationMs !== null && durationMs >= MIN_MATCH_DURATION_MS) {
            await window.api.db.insertVideo({
              filePath: file.filePath,
              fileName: file.fileName,
              recordedAt: file.recordedAt,
              durationMs
            })
            imported++
          } else {
            skipped++
          }
        }
      } finally {
        setProgress('Saving...')
        await window.api.db.endBulkWrites()
      }

      await window.api.db.recordFolderScan({ id: folder.id, imported, skipped })
      setProgress(`Done: imported ${imported}, skipped ${skipped} (under 5 min).`)
      onImported()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-panel-overlay" onClick={busy ? undefined : onClose}>
      <div className="add-media-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-panel-header">
          <h3>Add recordings</h3>
          <button className="link-button" onClick={onClose} disabled={busy}>
            <X size={18} />
          </button>
        </div>

        <div className="add-media-options">
          <button className="add-media-option" onClick={handleAddFile} disabled={busy}>
            <FileVideo size={28} />
            <span className="add-media-option-title">Add a single video</span>
            <span className="add-media-option-hint">Pick one recording file to import.</span>
          </button>

          <button className="add-media-option" onClick={handleAddFolder} disabled={busy}>
            <FolderOpen size={28} />
            <span className="add-media-option-title">Link a folder</span>
            <span className="add-media-option-hint">
              Scans a folder for recordings and auto-imports full matches (5 min or longer),
              skipping short clips.
            </span>
          </button>
        </div>

        {progress && <p className="status add-media-progress">{progress}</p>}
        {error && <p className="status status-error">{error}</p>}

        {!busy && (
          <div className="settings-panel-footer">
            <button className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default AddMediaPopup
