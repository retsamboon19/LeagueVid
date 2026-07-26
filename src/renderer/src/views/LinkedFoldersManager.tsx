import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import { probeDurationsBatch } from '../lib/probeDurationBatch'

interface LinkedFolderRow {
  id: number
  folder_path: string
  added_at: number
  last_scanned_at: number | null
  last_scan_imported: number
  last_scan_skipped: number
}

interface LinkedFoldersManagerProps {
  onImported: () => void
  refreshSignal: number
}

const MIN_MATCH_DURATION_MS = 5 * 60 * 1000

function timeAgo(ms: number | null): string {
  if (!ms) return 'never'
  const diffMins = Math.floor((Date.now() - ms) / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function LinkedFoldersManager({ onImported, refreshSignal }: LinkedFoldersManagerProps): JSX.Element {
  const [folders, setFolders] = useState<LinkedFolderRow[]>([])
  const [scanningId, setScanningId] = useState<number | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    const rows = await window.api.db.listLinkedFolders()
    setFolders(rows)
  }

  useEffect(() => {
    refresh()
  }, [refreshSignal])

  async function handleRescan(folder: LinkedFolderRow): Promise<void> {
    setScanningId(folder.id)
    setProgress(null)
    try {
      const files = await window.api.video.scanFolder(folder.folder_path)
      let imported = 0
      let skipped = 0

      const probed = await probeDurationsBatch(files, (done, total, file) => {
        setProgress(`${done}/${total}: ${file.fileName}`)
      })

      // Single database save for the whole rescan (see AddMediaPopup).
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
      onImported()
      await refresh()
    } finally {
      setScanningId(null)
      setProgress(null)
    }
  }

  async function handleRemove(id: number): Promise<void> {
    await window.api.db.removeLinkedFolder(id)
    await refresh()
  }

  return (
    <div className="folders-panel">
      <div className="filter-panel-header">
        <span>
          <FolderOpen size={15} /> Linked folders
        </span>
      </div>

      <div className="folders-panel-body">
        {folders.length === 0 ? (
          <p className="subtitle">
            No folders linked yet. Use the Add button and choose &quot;Link a folder&quot; to
            auto-import full match recordings from a directory.
          </p>
        ) : (
          folders.map((folder) => (
            <div key={folder.id} className="folder-row">
              <div className="folder-row-info">
                <span className="folder-row-name" title={folder.folder_path}>
                  {folderName(folder.folder_path)}
                </span>
                <span className="folder-row-meta">
                  Last scan: {timeAgo(folder.last_scanned_at)}
                  {folder.last_scanned_at &&
                    ` \u00b7 ${folder.last_scan_imported} imported, ${folder.last_scan_skipped} skipped`}
                </span>
                {scanningId === folder.id && progress && (
                  <span className="folder-row-progress">{progress}</span>
                )}
              </div>
              <div className="folder-row-actions">
                <button
                  className="player-icon-btn"
                  onClick={() => handleRescan(folder)}
                  disabled={scanningId !== null}
                  title="Rescan folder"
                >
                  <RefreshCw size={14} className={scanningId === folder.id ? 'spin' : ''} />
                </button>
                <button
                  className="player-icon-btn"
                  onClick={() => handleRemove(folder.id)}
                  disabled={scanningId !== null}
                  title="Remove folder"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default LinkedFoldersManager
