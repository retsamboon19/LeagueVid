import { ipcMain, dialog } from 'electron'
import { statSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'
import { toMediaUrl } from './mediaProtocol'
import { parseRecordedAtFromFileName } from './parseFileNameDate'
import { probeMp4DurationMs } from './probeMp4Duration'
import {
  clipsDir,
  createClip,
  defaultClipsDir,
  revealClip,
  revealClipsFolder,
  type ClipRequest
} from './clipService'
import { getClipsDirOverride, setClipsDirOverride } from '../db/repository'
import { getCachedVideoDuration, setCachedVideoDuration } from '../db/repository'

// Containers this app knows how to read a duration out of directly (see
// probeMp4Duration.ts) without decoding any frames. MKV/AVI/WebM use
// different container formats and aren't covered -- those fall back to the
// renderer's <video>-element probe.
const FAST_PROBE_EXTENSIONS = new Set(['.mp4', '.mov'])

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm'])

function fileInfo(filePath: string): {
  filePath: string
  fileName: string
  recordedAt: number
  sizeBytes: number
} {
  const stats = statSync(filePath)
  const fileName = basename(filePath)

  // Recording tools (Outplay, OBS, etc.) commonly embed the exact recording
  // date/time in the filename, e.g. "League of Legends_07-22-2026_22-35-48-
  // 300.mp4". That's a far more reliable anchor for match-search than file
  // system timestamps, which get reset by copies, backups, or moving the
  // file to a different drive/folder. Fall back to birthtime/mtime only
  // when the filename doesn't contain a recognizable date/time.
  const parsedFromName = parseRecordedAtFromFileName(fileName)

  return {
    filePath,
    fileName,
    recordedAt: parsedFromName ?? (stats.birthtimeMs || stats.mtimeMs),
    sizeBytes: stats.size
  }
}

// Recursively walks a directory for video files, one level deep is common
// for recording folders but nested subfolders (e.g. per-day) are common too.
function findVideoFiles(dir: string, depth = 0, maxDepth = 4): string[] {
  if (depth > maxDepth) return []
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const results: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findVideoFiles(fullPath, depth + 1, maxDepth))
    } else if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath)
    }
  }
  return results
}

export function registerVideoHandlers(): void {
  ipcMain.handle('video:selectFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return fileInfo(result.filePaths[0])
  })

  ipcMain.handle('video:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Lists candidate video files within a folder (recursive, depth-limited).
  // Duration filtering happens in the renderer via a hidden <video> element,
  // since ffprobe/mediainfo aren't bundled and this avoids a native dependency.
  ipcMain.handle('video:scanFolder', async (_e, folderPath: string) => {
    const files = findVideoFiles(folderPath)
    return files.map(fileInfo)
  })

  // Converts a local filesystem path into a URL the <video> element can load.
  // Uses a custom protocol (see mediaProtocol.ts) instead of file:// directly,
  // since file:// media is blocked cross-origin from the app's http(s) page.
  ipcMain.handle('video:toFileUrl', (_e, filePath: string) => {
    return toMediaUrl(filePath)
  })

  // --- Clipping ---

  ipcMain.handle('video:createClip', async (_e, request: ClipRequest) => {
    return createClip(request)
  })

  ipcMain.handle('video:getClipsDir', () => clipsDir())

  // Reports both the folder in use and the default, plus whether the current
  // one is a user choice -- the settings UI needs to distinguish "you picked
  // this" from "this is where it goes by default".
  ipcMain.handle('video:getClipsDirInfo', () => ({
    current: clipsDir(),
    default: defaultClipsDir(),
    isCustom: getClipsDirOverride() !== null
  }))

  ipcMain.handle('video:chooseClipsDir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where to save clips',
      defaultPath: clipsDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const chosen = result.filePaths[0]
    // Verify it's actually writable before saving the choice, so a bad pick
    // surfaces here instead of when the user tries to export a clip.
    try {
      mkdirSync(chosen, { recursive: true })
      const probe = join(chosen, '.leaguevid-write-test')
      writeFileSync(probe, '')
      unlinkSync(probe)
    } catch {
      throw new Error('That folder cannot be written to. Pick a different one.')
    }

    setClipsDirOverride(chosen)
    return clipsDir()
  })

  ipcMain.handle('video:resetClipsDir', () => {
    setClipsDirOverride(null)
    return clipsDir()
  })

  ipcMain.handle('video:revealClipsFolder', () => revealClipsFolder())

  ipcMain.handle('video:revealClip', (_e, filePath: string) => revealClip(filePath))

  // Fast duration lookup: checks the on-disk cache first (instant, no I/O
  // beyond a DB read), then tries reading the container header directly for
  // MP4/MOV files (no video decode, just a few small seeked reads). Returns
  // null for anything it can't resolve this way -- the caller should fall
  // back to the slower <video>-element probe in the renderer for those
  // (typically MKV/AVI/WebM, or a corrupt/unusual MP4).
  ipcMain.handle(
    'video:probeDurationFast',
    async (_e, args: { filePath: string; sizeBytes: number }) => {
      const cached = getCachedVideoDuration(args.filePath, args.sizeBytes)
      if (cached !== null) return cached

      const ext = extname(args.filePath).toLowerCase()
      if (!FAST_PROBE_EXTENSIONS.has(ext)) return null

      const durationMs = await probeMp4DurationMs(args.filePath)
      if (durationMs !== null) {
        setCachedVideoDuration(args.filePath, args.sizeBytes, durationMs)
      }
      return durationMs
    }
  )

  // Lets the renderer persist a duration it resolved via the slower
  // <video>-element fallback, so the next scan of the same file (unchanged
  // size) can skip probing entirely.
  ipcMain.handle(
    'video:cacheDuration',
    (_e, args: { filePath: string; sizeBytes: number; durationMs: number }) => {
      setCachedVideoDuration(args.filePath, args.sizeBytes, args.durationMs)
    }
  )
}
