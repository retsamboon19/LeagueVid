import { ipcMain } from 'electron'
import * as repo from './repository'
import { resetRiotClient } from '../riot/clientSingleton'
import { resumePersist, suspendPersist } from './index'

export function registerDbHandlers(): void {
  ipcMain.handle('db:getSettings', () => repo.getSettings())

  ipcMain.handle('db:saveSettings', (_e, settings: repo.AppSettings) => repo.saveSettings(settings))

  ipcMain.handle('db:getPlayerPreferences', () => repo.getPlayerPreferences())

  ipcMain.handle('db:savePlayerPreferences', (_e, prefs: Parameters<typeof repo.savePlayerPreferences>[0]) =>
    repo.savePlayerPreferences(prefs)
  )

  ipcMain.handle('db:listVideos', () => repo.listVideos())

  ipcMain.handle('db:getVideo', (_e, id: number) => repo.getVideo(id))

  ipcMain.handle(
    'db:insertVideo',
    (
      _e,
      input: { filePath: string; fileName: string; recordedAt?: number | null; durationMs?: number | null }
    ) => repo.insertVideo(input)
  )

  ipcMain.handle(
    'db:linkVideoToMatch',
    (_e, input: Parameters<typeof repo.linkVideoToMatch>[0]) => repo.linkVideoToMatch(input)
  )

  ipcMain.handle(
    'db:updateSyncOffset',
    (_e, input: { videoId: number; syncOffsetMs: number }) =>
      repo.updateSyncOffset(input.videoId, input.syncOffsetMs)
  )

  ipcMain.handle(
    'db:setFavorite',
    (_e, input: { videoId: number; isFavorite: boolean }) =>
      repo.setFavorite(input.videoId, input.isFavorite)
  )

  ipcMain.handle(
    'db:updateLastPosition',
    (_e, input: { videoId: number; positionMs: number }) =>
      repo.updateLastPosition(input.videoId, input.positionMs)
  )

  ipcMain.handle(
    'db:resyncTags',
    (_e, input: { videoId: number; recordingStartSeconds: number }) =>
      repo.resyncTags(input.videoId, input.recordingStartSeconds)
  )

  ipcMain.handle(
    'db:insertTags',
    (
      _e,
      input: {
        videoId: number
        tags: Array<{
          timestampMs: number
          type: string
          label: string
          detail?: string | null
          source: 'auto' | 'manual'
        }>
      }
    ) => repo.insertTags(input.videoId, input.tags)
  )

  ipcMain.handle('db:clearAutoTags', (_e, videoId: number) => repo.clearAutoTags(videoId))

  ipcMain.handle('db:listTags', (_e, videoId: number) => repo.listTags(videoId))

  ipcMain.handle('db:listTowerDiveTagCounts', () => repo.listTowerDiveTagCounts())

  ipcMain.handle(
    'db:updateTag',
    (_e, input: { tagId: number; timestampMs?: number; label?: string; detail?: string | null }) =>
      repo.updateTag(input.tagId, input)
  )

  ipcMain.handle('db:deleteTag', (_e, tagId: number) => repo.deleteTag(tagId))

  ipcMain.handle(
    'db:insertManualTag',
    (
      _e,
      input: { videoId: number; timestampMs: number; type: string; label: string; detail?: string }
    ) => repo.insertManualTag(input)
  )

  // Per-gank accuracy verdicts from the stats panel's "Gank source" list. The
  // detection is a heuristic, and these are the ground truth for retuning it.
  ipcMain.handle('db:setGankFeedback', (_e, input: Parameters<typeof repo.setGankFeedback>[0]) =>
    repo.setGankFeedback(input)
  )

  ipcMain.handle(
    'db:clearGankFeedback',
    (_e, input: Parameters<typeof repo.clearGankFeedback>[0]) => repo.clearGankFeedback(input)
  )

  ipcMain.handle('db:listGankFeedback', (_e, input: { matchId: string; participantId: number }) =>
    repo.listGankFeedback(input.matchId, input.participantId)
  )

  ipcMain.handle('db:getGankFeedbackSummary', () => repo.getGankFeedbackSummary())

  ipcMain.handle('db:addLinkedFolder', (_e, folderPath: string) => repo.addLinkedFolder(folderPath))

  ipcMain.handle('db:listLinkedFolders', () => repo.listLinkedFolders())

  ipcMain.handle('db:removeLinkedFolder', (_e, id: number) => repo.removeLinkedFolder(id))

  ipcMain.handle(
    'db:recordFolderScan',
    (_e, input: { id: number; imported: number; skipped: number }) =>
      repo.recordFolderScan(input.id, { imported: input.imported, skipped: input.skipped })
  )

  ipcMain.handle('db:deleteVideo', (_e, videoId: number) => repo.deleteVideo(videoId))

  ipcMain.handle('db:deleteVideos', (_e, videoIds: number[]) => repo.deleteVideos(videoIds))

  ipcMain.handle('db:deleteAllVideos', () => repo.deleteAllVideos())

  ipcMain.handle('db:getApiCacheStats', () => repo.getApiCacheStats())

  // Bulk-write window. Saving the database means rewriting the whole file
  // (sql.js has no incremental write), so a loop over hundreds of videos
  // must not save on every step. Renderer-driven bulk operations wrap
  // themselves in these.
  ipcMain.handle('db:beginBulkWrites', () => suspendPersist())
  ipcMain.handle('db:endBulkWrites', () => resumePersist())

  ipcMain.handle('db:clearMatchCache', () => repo.clearMatchCache())

  ipcMain.handle('db:findVideosWithSuspiciousBookmarks', () => repo.findVideosWithSuspiciousBookmarks())

  // Every multikill tag across every video, for the library's multikill
  // filter buttons (Double/Triple/Quadra/Penta + Solo).
  ipcMain.handle('db:listMultikillTags', () => repo.listMultikillTags())

  // Returns whether an API key is currently usable (either a saved override
  // or a .env RIOT_API_KEY), and whether the active key came from Settings
  // vs .env -- masked so the actual key value isn't round-tripped back to
  // the renderer unnecessarily (it's only shown once, right after saving).
  ipcMain.handle('db:getRiotApiKeyStatus', () => {
    const override = repo.getRiotApiKeyOverride()
    const hasEnvKey = !!process.env.RIOT_API_KEY
    return {
      hasCustomKey: !!override,
      hasEnvKey,
      maskedKey: override ? maskApiKey(override) : hasEnvKey ? maskApiKey(process.env.RIOT_API_KEY as string) : null
    }
  })

  ipcMain.handle('db:setRiotApiKey', (_e, apiKey: string | null) => {
    repo.setRiotApiKeyOverride(apiKey)
    resetRiotClient()
  })

  ipcMain.handle('db:getRiotRateLimit', () => repo.getRiotRateLimitOverride())

  ipcMain.handle('db:setRiotRateLimit', (_e, config: repo.RateLimitConfig | null) => {
    repo.setRiotRateLimitOverride(config)
    resetRiotClient()
  })

  // Summary of how much match history has been indexed/backfilled locally
  // for a set of accounts -- powers the "downloading your match history"
  // progress indicator on the library page.
  ipcMain.handle('db:getBackfillStatus', (_e, puuids: string[]) => repo.getBackfillStatusSummary(puuids))
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '****'
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}
