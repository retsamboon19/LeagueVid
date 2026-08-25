import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppSettings,
  AudioCaptureDevice,
  AutoTagEvent,
  CaptureDisplay,
  DDragonBundle,
  DiskUsageInfo,
  EncoderCapabilities,
  GankVerdict,
  LeadSwingResult,
  MatchHistorySummary,
  MatchActionTimelineResult,
  MatchPickerSummary,
  MatchRosterData,
  MatchStats,
  MatchStatsResult,
  PlatformRouting,
  PlayerPreferences,
  PreflightResultInfo,
  QualityPresetInfo,
  RecorderProgress,
  RecorderStateSnapshot,
  RecordingLinkState,
  RecordingRow,
  RecordingSettings,
  RetentionPreviewInfo,
  RetentionSweepInfo,
  RiotAccountDto,
  TagRow,
  VideoFileInfo,
  VideoRow
} from '../shared/types'
import type { UpdateCheckResult, UpdateInstallResult, UpdateProgress } from '../shared/updater'

export interface MatchBundleParticipant {
  puuid: string
  participantId: number
  championName: string
  kills: number
  deaths: number
  assists: number
  win: boolean
  teamPosition: string
  goldEarned: number
  summoner1Id: number
  summoner2Id: number
}

export interface MatchBundleResult {
  match: {
    metadata: { matchId: string; participants: string[] }
    info: {
      gameStartTimestamp: number
      gameEndTimestamp: number
      gameDuration: number
      gameMode: string
      gameVersion: string
    }
  }
  participant: MatchBundleParticipant
  events: AutoTagEvent[]
  derived: {
    enemyChampionName: string | null
    cs: number
    enemyCs: number | null
    goldDiff: number | null
    keystoneId: number | null
    rosterData: MatchRosterData
    teamPosition: string | null
    queueId: number | null
  }
}

export interface LinkedFolderRow {
  id: number
  folder_path: string
  added_at: number
  last_scanned_at: number | null
  last_scan_imported: number
  last_scan_skipped: number
}

/** A stored verdict on one detected gank. Mirrors the gank_feedback table. */
export interface GankFeedbackRow {
  id: number
  match_id: string
  participant_id: number
  /** GAME time, not video time. */
  timestamp_ms: number
  outcome: string
  /** JSON array of participantIds. */
  ganker_ids: string | null
  verdict: string
  created_at: number
}

/** What the main process sends when a recording lands in the library. */
export interface RecordingSavedPayload {
  recordingId: number
  video: VideoRow
  /** False when converting failed and the original recording was imported. */
  converted: boolean
}

/**
 * Wraps ipcRenderer.on and hands back an unsubscribe.
 *
 * The listener is wrapped so the renderer never receives the IpcRendererEvent,
 * which would leak a privileged object across the context bridge.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  updater: {
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updater:check'),
    install: (): Promise<{ restarting: true }> => ipcRenderer.invoke('updater:install'),
    lastInstallResult: (): Promise<UpdateInstallResult | null> =>
      ipcRenderer.invoke('updater:lastInstallResult'),
    onProgress: (callback: (progress: UpdateProgress) => void): (() => void) =>
      subscribe('updater:progress', callback)
  },
  riot: {
    findAccount: (args: {
      platform: PlatformRouting
      gameName: string
      tagLine: string
    }): Promise<RiotAccountDto> => ipcRenderer.invoke('riot:findAccount', args),

    fetchRecentMatches: (args: {
      accounts: Array<{ platform: PlatformRouting; puuid: string; accountLabel: string }>
      count?: number
      startTimeMs?: number
      endTimeMs?: number
    }): Promise<MatchPickerSummary[]> => ipcRenderer.invoke('riot:fetchRecentMatches', args),

    fetchMatchBundle: (args: {
      platform: PlatformRouting
      matchId: string
      puuid: string
    }): Promise<MatchBundleResult> => ipcRenderer.invoke('riot:fetchMatchBundle', args),

    // Every locally-downloaded match the given accounts played in. No
    // network, no date window -- backs manual linking, where the user
    // filters over already-downloaded history instead of picking a range.
    listCachedMatches: (args: {
      accounts: Array<{ platform: PlatformRouting; puuid: string; accountLabel: string }>
    }): Promise<MatchPickerSummary[]> => ipcRenderer.invoke('riot:listCachedMatches', args),

    // Rich cached history for the Library. Includes compact scoreboard and
    // loadout data, but remains local-only and consumes no Riot API budget.
    listCachedMatchHistory: (args: {
      accounts: Array<{ platform: PlatformRouting; puuid: string; accountLabel: string }>
    }): Promise<MatchHistorySummary[]> => ipcRenderer.invoke('riot:listCachedMatchHistory', args),

    // Full stats payload for the player page's stats panel, derived from
    // locally cached match + timeline data. Issues no Riot API requests.
    getMatchStats: (args: {
      matchId: string
      accounts: Array<{ platform: PlatformRouting; puuid: string }>
    }): Promise<MatchStatsResult> => ipcRenderer.invoke('riot:getMatchStats', args),

    // Timeline-free stats for many matches at once, keyed by videoId. Backs the
    // achievement chips on the library's match tiles; skipping timelines is
    // what makes it cheap enough to call for a whole library.
    getMatchStatsBulkLite: (args: {
      matches: Array<{ videoId: number; matchId: string }>
      accounts: Array<{ platform: PlatformRouting; puuid: string }>
    }): Promise<Record<number, MatchStats>> =>
      ipcRenderer.invoke('riot:getMatchStatsBulkLite', args),

    // Full stats for exact achievement counts/filtering. Called lazily and in
    // small batches because this reads each match's cached timeline.
    getMatchStatsBulk: (args: {
      matches: Array<{ videoId: number; matchId: string }>
      accounts: Array<{ platform: PlatformRouting; puuid: string }>
    }): Promise<Record<number, MatchStats>> => ipcRenderer.invoke('riot:getMatchStatsBulk', args),

    // Match-wide action events (every player, not just the linked account) --
    // backs the action-density curve so it reflects the whole game.
    getMatchActionTimeline: (args: {
      matchId: string
      accounts: Array<{ platform: PlatformRouting; puuid: string }>
    }): Promise<MatchActionTimelineResult> =>
      ipcRenderer.invoke('riot:getMatchActionTimeline', args),

    // Gold-diff-vs-lane-opponent series for many matches at once, backing
    // the library's comeback/lead-throw filter.
    getLeadSwingBulk: (args: {
      matches: Array<{ videoId: number; matchId: string }>
      accounts: Array<{ platform: PlatformRouting; puuid: string }>
    }): Promise<Record<number, LeadSwingResult>> =>
      ipcRenderer.invoke('riot:getLeadSwingBulk', args),

    // Kicks off an immediate check for match data that isn't downloaded yet.
    downloadMatchData: (): Promise<void> => ipcRenderer.invoke('riot:downloadMatchData'),

    // Checks Riot's latest match-id page immediately, waits for missing
    // entries to cache, then lets Match History repaint from local data.
    refreshRecentMatches: (): Promise<void> => ipcRenderer.invoke('riot:refreshRecentMatches')
  },
  ddragon: {
    getBundle: (): Promise<DDragonBundle> => ipcRenderer.invoke('ddragon:getBundle')
  },
  db: {
    getSettings: (): Promise<AppSettings | null> => ipcRenderer.invoke('db:getSettings'),
    saveSettings: (settings: AppSettings): Promise<void> =>
      ipcRenderer.invoke('db:saveSettings', settings),

    getPlayerPreferences: (): Promise<PlayerPreferences> =>
      ipcRenderer.invoke('db:getPlayerPreferences'),
    savePlayerPreferences: (prefs: PlayerPreferences): Promise<void> =>
      ipcRenderer.invoke('db:savePlayerPreferences', prefs),

    listVideos: (): Promise<VideoRow[]> => ipcRenderer.invoke('db:listVideos'),
    getVideo: (id: number): Promise<VideoRow | undefined> => ipcRenderer.invoke('db:getVideo', id),
    insertVideo: (input: {
      filePath: string
      fileName: string
      recordedAt?: number | null
      durationMs?: number | null
    }): Promise<VideoRow> => ipcRenderer.invoke('db:insertVideo', input),

    linkVideoToMatch: (input: {
      videoId: number
      matchId: string
      syncOffsetMs: number
      championName: string
      kda: string
      win: boolean
      kills: number
      deaths: number
      assists: number
      cs: number
      goldDiff: number | null
      enemyChampionName: string | null
      summoner1Id: number
      summoner2Id: number
      keystoneId: number | null
      gameMode: string
      matchData: MatchRosterData
      teamPosition?: string | null
      queueId?: number | null
    }): Promise<void> => ipcRenderer.invoke('db:linkVideoToMatch', input),

    // Detaches a mistaken association while keeping both the recording row
    // and the independently cached match-history entry.
    unlinkVideoFromMatch: (videoId: number): Promise<void> =>
      ipcRenderer.invoke('db:unlinkVideoFromMatch', videoId),

    updateSyncOffset: (input: { videoId: number; syncOffsetMs: number }): Promise<void> =>
      ipcRenderer.invoke('db:updateSyncOffset', input),

    // Manual star marker, independent of any computed filter data.
    setFavorite: (input: { videoId: number; isFavorite: boolean }): Promise<void> =>
      ipcRenderer.invoke('db:setFavorite', input),

    // Persists roughly where playback stopped, so re-opening a video resumes
    // near there instead of always restarting from 0:00.
    updateLastPosition: (input: { videoId: number; positionMs: number }): Promise<void> =>
      ipcRenderer.invoke('db:updateLastPosition', input),

    resyncTags: (input: { videoId: number; recordingStartSeconds: number }): Promise<void> =>
      ipcRenderer.invoke('db:resyncTags', input),

    insertTags: (input: {
      videoId: number
      tags: Array<{
        timestampMs: number
        type: string
        label: string
        detail?: string | null
        source: 'auto' | 'manual'
      }>
    }): Promise<void> => ipcRenderer.invoke('db:insertTags', input),

    clearAutoTags: (videoId: number): Promise<void> => ipcRenderer.invoke('db:clearAutoTags', videoId),

    listTags: (videoId: number): Promise<TagRow[]> => ipcRenderer.invoke('db:listTags', videoId),

    listTowerDiveTagCounts: (): Promise<Array<{ videoId: number; count: number }>> =>
      ipcRenderer.invoke('db:listTowerDiveTagCounts'),

    updateTag: (input: {
      tagId: number
      timestampMs?: number
      label?: string
      detail?: string | null
    }): Promise<void> => ipcRenderer.invoke('db:updateTag', input),

    deleteTag: (tagId: number): Promise<void> => ipcRenderer.invoke('db:deleteTag', tagId),

    insertManualTag: (input: {
      videoId: number
      timestampMs: number
      type: string
      label: string
      detail?: string
    }): Promise<TagRow> => ipcRenderer.invoke('db:insertManualTag', input),

    // Per-gank accuracy verdicts. Gank detection is a heuristic, so the stats
    // panel lets the user mark each detected gank right or wrong; these verdicts
    // are what later retuning is measured against.
    setGankFeedback: (input: {
      matchId: string
      participantId: number
      timestampMs: number
      outcome: string
      gankerParticipantIds: number[]
      verdict: GankVerdict
    }): Promise<void> => ipcRenderer.invoke('db:setGankFeedback', input),

    clearGankFeedback: (input: {
      matchId: string
      participantId: number
      timestampMs: number
    }): Promise<void> => ipcRenderer.invoke('db:clearGankFeedback', input),

    listGankFeedback: (input: {
      matchId: string
      participantId: number
    }): Promise<GankFeedbackRow[]> => ipcRenderer.invoke('db:listGankFeedback', input),

    getGankFeedbackSummary: (): Promise<{
      accurate: number
      wrong: number
      byOutcome: Array<{ outcome: string; verdict: string; count: number }>
      rows: GankFeedbackRow[]
    }> => ipcRenderer.invoke('db:getGankFeedbackSummary'),

    addLinkedFolder: (folderPath: string): Promise<LinkedFolderRow> =>
      ipcRenderer.invoke('db:addLinkedFolder', folderPath),
    listLinkedFolders: (): Promise<LinkedFolderRow[]> => ipcRenderer.invoke('db:listLinkedFolders'),
    removeLinkedFolder: (id: number): Promise<void> => ipcRenderer.invoke('db:removeLinkedFolder', id),
    recordFolderScan: (input: { id: number; imported: number; skipped: number }): Promise<void> =>
      ipcRenderer.invoke('db:recordFolderScan', input),
    deleteVideo: (videoId: number): Promise<void> => ipcRenderer.invoke('db:deleteVideo', videoId),

    // Removes a chosen subset of recordings in one batch -- the middle
    // ground between deleteVideo and deleteAllVideos, for multi-select.
    deleteVideos: (videoIds: number[]): Promise<void> =>
      ipcRenderer.invoke('db:deleteVideos', videoIds),

    // Removes every recording from the library (does NOT delete the
    // underlying video files on disk).
    deleteAllVideos: (): Promise<void> => ipcRenderer.invoke('db:deleteAllVideos'),

    // How much Riot match data is currently downloaded locally.
    getApiCacheStats: (): Promise<{ count: number; oldestAt: number | null }> =>
      ipcRenderer.invoke('db:getApiCacheStats'),

    // Discards all downloaded Riot match/timeline data and resets backfill
    // progress so history re-downloads. Videos/bookmarks/links are kept.
    clearMatchCache: (): Promise<void> => ipcRenderer.invoke('db:clearMatchCache'),

    // Wrap long write loops in these: the database is saved by rewriting the
    // entire file, so persisting once at the end instead of per step is the
    // difference between seconds and milliseconds per item.
    beginBulkWrites: (): Promise<void> => ipcRenderer.invoke('db:beginBulkWrites'),
    endBulkWrites: (): Promise<void> => ipcRenderer.invoke('db:endBulkWrites'),

    // Returns ids of videos whose auto-generated bookmarks are all clamped
    // to timestamp <= 0 -- the signature of a video linked to the wrong
    // match (see findVideosWithSuspiciousBookmarks in the main-process repo).
    findVideosWithSuspiciousBookmarks: (): Promise<number[]> =>
      ipcRenderer.invoke('db:findVideosWithSuspiciousBookmarks'),

    // Every multikill tag across every video (Double/Triple/Quadra/Penta,
    // plus whether it was solo) -- backs the library's multikill filters.
    listMultikillTags: (): Promise<Array<{ videoId: number; type: string; solo: boolean }>> =>
      ipcRenderer.invoke('db:listMultikillTags'),

    // Riot API key management -- lets the user swap keys from Settings
    // instead of only via .env. The actual key value is never sent back to
    // the renderer except as a masked preview (first 8 + last 4 chars).
    getRiotApiKeyStatus: (): Promise<{
      hasCustomKey: boolean
      hasEnvKey: boolean
      hasBundledKey: boolean
      maskedKey: string | null
    }> => ipcRenderer.invoke('db:getRiotApiKeyStatus'),
    setRiotApiKey: (apiKey: string | null): Promise<void> =>
      ipcRenderer.invoke('db:setRiotApiKey', apiKey),

    getRiotRateLimit: (): Promise<{ perSecond: number; per2Minutes: number } | null> =>
      ipcRenderer.invoke('db:getRiotRateLimit'),
    setRiotRateLimit: (config: { perSecond: number; per2Minutes: number } | null): Promise<void> =>
      ipcRenderer.invoke('db:setRiotRateLimit', config),

    // Background match-history warming progress across a set of accounts,
    // for the library page's "downloading your match history" indicator.
    getBackfillStatus: (puuids: string[]): Promise<{
      totalAccounts: number
      accountsFullyBackfilled: number
      matchesDownloaded: number
      matchesTotal: number | null
      matchesCached: number
    }> => ipcRenderer.invoke('db:getBackfillStatus', puuids)
  },
  video: {
    selectFile: (): Promise<VideoFileInfo | null> => ipcRenderer.invoke('video:selectFile'),
    selectFolder: (): Promise<string | null> => ipcRenderer.invoke('video:selectFolder'),
    scanFolder: (folderPath: string): Promise<VideoFileInfo[]> =>
      ipcRenderer.invoke('video:scanFolder', folderPath),
    toFileUrl: (filePath: string): Promise<string> => ipcRenderer.invoke('video:toFileUrl', filePath),

    // Tries the on-disk cache, then a fast MP4/MOV container header read.
    // Returns null if neither resolves it (unsupported container, or first
    // time seeing this file) -- caller should fall back to probeVideoDurationMs.
    probeDurationFast: (args: { filePath: string; sizeBytes: number }): Promise<number | null> =>
      ipcRenderer.invoke('video:probeDurationFast', args),

    // Persists a duration resolved via the renderer's <video>-element
    // fallback, so future scans of this file (same size) skip probing.
    cacheDuration: (args: { filePath: string; sizeBytes: number; durationMs: number }): Promise<void> =>
      ipcRenderer.invoke('video:cacheDuration', args),

    // --- Clipping ---
    // 'fast' stream-copies (instant, lossless, but starts on the nearest
    // keyframe); 'exact' re-encodes to hit the requested frame precisely.
    createClip: (request: {
      sourcePath: string
      startMs: number
      endMs: number
      name: string
      mode: 'fast' | 'exact'
    }): Promise<{ outputPath: string; sizeBytes: number; durationMs: number }> =>
      ipcRenderer.invoke('video:createClip', request),

    getClipsDir: (): Promise<string> => ipcRenderer.invoke('video:getClipsDir'),

    // Clip output folder. Defaults to a 'clips' folder inside the app's own
    // directory; the user can point it anywhere writable.
    getClipsDirInfo: (): Promise<{ current: string; default: string; isCustom: boolean }> =>
      ipcRenderer.invoke('video:getClipsDirInfo'),
    chooseClipsDir: (): Promise<string | null> => ipcRenderer.invoke('video:chooseClipsDir'),
    resetClipsDir: (): Promise<string> => ipcRenderer.invoke('video:resetClipsDir'),
    revealClipsFolder: (): Promise<void> => ipcRenderer.invoke('video:revealClipsFolder'),
    revealClip: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('video:revealClip', filePath),

    // Shows any library file in Explorer, selected in its folder. Falls back to
    // opening the parent folder if the file has moved, and says so.
    revealInFolder: (filePath: string): Promise<{ revealed: boolean; reason: string | null }> =>
      ipcRenderer.invoke('video:revealInFolder', filePath)
  },
  recorder: {
    // Recorder configuration. Saving returns the stored result rather than
    // void, because reads merge the row over the current defaults -- so the
    // response is the configuration that will actually be used.
    getSettings: (): Promise<RecordingSettings> => ipcRenderer.invoke('recorder:getSettings'),
    saveSettings: (settings: RecordingSettings): Promise<RecordingSettings> =>
      ipcRenderer.invoke('recorder:saveSettings', settings),

    // Which video encoders actually work on this machine. The first call
    // after install probes (a few seconds, one child process per candidate);
    // later calls read the cached result.
    getCapabilities: (): Promise<EncoderCapabilities> =>
      ipcRenderer.invoke('recorder:getCapabilities'),
    refreshCapabilities: (): Promise<EncoderCapabilities> =>
      ipcRenderer.invoke('recorder:refreshCapabilities'),

    // Monitors, each mapped to the ddagrab output index that should capture
    // it. Read live, since a display can be attached between opening Settings
    // and starting a game.
    listDisplays: (): Promise<CaptureDisplay[]> => ipcRenderer.invoke('recorder:listDisplays'),

    // DirectShow capture devices. On Windows this is the only audio input the
    // bundled ffmpeg has -- there is no WASAPI loopback -- so desktop audio
    // depends on either a virtual device listed here or the loopback bridge.
    listAudioDevices: (): Promise<AudioCaptureDevice[]> =>
      ipcRenderer.invoke('recorder:listAudioDevices'),

    // --- Where recordings are written ---
    getOutputDirInfo: (): Promise<{ current: string; default: string; isCustom: boolean }> =>
      ipcRenderer.invoke('recorder:getOutputDirInfo'),
    chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke('recorder:chooseOutputDir'),
    resetOutputDir: (): Promise<string> => ipcRenderer.invoke('recorder:resetOutputDir'),
    revealOutputFolder: (): Promise<void> => ipcRenderer.invoke('recorder:revealOutputFolder'),

    // --- Recorder state ---
    // Each of these pull methods mirrors a push channel below. That pairing
    // matters: a renderer mounting halfway through a recording has missed
    // every push so far, so it reads the current state once and then
    // subscribes.
    getState: (): Promise<RecorderStateSnapshot> => ipcRenderer.invoke('recorder:getState'),
    getProgress: (): Promise<RecorderProgress | null> =>
      ipcRenderer.invoke('recorder:getProgress'),

    setEnabled: (enabled: boolean): Promise<RecorderStateSnapshot> =>
      ipcRenderer.invoke('recorder:setEnabled', enabled),
    startManual: (): Promise<RecorderStateSnapshot> => ipcRenderer.invoke('recorder:startManual'),
    stopManual: (): Promise<RecorderStateSnapshot> => ipcRenderer.invoke('recorder:stopManual'),

    // --- Push subscriptions ---
    // The first use of main-to-renderer push in this app; everything else is
    // request/response. Each returns its own unsubscribe function so a React
    // effect's cleanup is the natural shape and listeners can't accumulate
    // across remounts.
    onState: (callback: (state: RecorderStateSnapshot) => void): (() => void) =>
      subscribe('recorder:state', callback),
    onProgress: (callback: (progress: RecorderProgress) => void): (() => void) =>
      subscribe('recorder:progress', callback),
    onRecordingSaved: (callback: (payload: RecordingSavedPayload) => void): (() => void) =>
      subscribe('recorder:recordingSaved', callback),
    onError: (callback: (message: string) => void): (() => void) =>
      subscribe('recorder:error', callback),

    // --- Linking queue ---
    // Recordings complete whether or not a window is open, so the library
    // drains this on mount rather than relying on having been listening.
    getPendingLinks: (): Promise<RecordingRow[]> => ipcRenderer.invoke('recorder:getPendingLinks'),
    setLinkState: (input: {
      recordingId: number
      state: RecordingLinkState
    }): Promise<void> => ipcRenderer.invoke('recorder:setLinkState', input),
    bumpLinkAttempt: (recordingId: number): Promise<void> =>
      ipcRenderer.invoke('recorder:bumpLinkAttempt', recordingId),
    listRecordings: (): Promise<RecordingRow[]> => ipcRenderer.invoke('recorder:listRecordings'),

    // --- Quality ---
    getPresets: (): Promise<{
      presets: QualityPresetInfo[]
      active: string
      refreshHz: number | null
    }> =>
      ipcRenderer.invoke('recorder:getPresets'),

    // Whether Windows' Hardware-accelerated GPU scheduling is likely to be
    // costing capture performance. Detected only -- LeagueVid does not change
    // machine-wide graphics settings.
    getGraphicsScheduling: (): Promise<{
      state: string
      shouldWarn: boolean
      message: string | null
    }> => ipcRenderer.invoke('recorder:getGraphicsScheduling'),

    // --- Capture backend ---
    // Which capture technology records, and why the other one cannot. Game
    // capture reads the game's own frames; screen capture scrapes the desktop
    // and cannot see a game in exclusive fullscreen at all.
    getCaptureBackends: (): Promise<
      Array<{
        id: string
        label: string
        availability: { available: boolean; reason?: string; version?: string }
        active: boolean
      }>
    > => ipcRenderer.invoke('recorder:getCaptureBackends'),

    // Downloads OBS, which is not shipped with LeagueVid because it is larger
    // than everything else here combined.
    installObs: (): Promise<{ alreadyPresent: boolean; root: string; origin: string }> =>
      ipcRenderer.invoke('recorder:installObs'),

    isInstallingObs: (): Promise<boolean> => ipcRenderer.invoke('recorder:isInstallingObs'),

    // Progress for the install above. A 179 MB download with no feedback is
    // indistinguishable from a button that does nothing.
    onObsInstallProgress: (
      handler: (progress: {
        phase: string
        receivedBytes: number
        totalBytes: number | null
        fraction: number | null
      }) => void
    ): (() => void) => {
      const listener = (_e: unknown, progress: Parameters<typeof handler>[0]): void =>
        handler(progress)
      ipcRenderer.on('recorder:obsInstallProgress', listener)
      return () => ipcRenderer.removeListener('recorder:obsInstallProgress', listener)
    },
    applyPreset: (preset: string): Promise<RecordingSettings> =>
      ipcRenderer.invoke('recorder:applyPreset', preset),

    // Modelled cost of the current configuration. The preflight test below is
    // the measured counterpart -- an estimate can't know whether this machine
    // sustains the settings.
    estimateBitrate: (): Promise<{
      totalKbps: number
      gbPerHour: number
      summary: string
    } | null> => ipcRenderer.invoke('recorder:estimateBitrate'),

    // Records for ten seconds with the exact configured pipeline and reports
    // measured framerate, dropped frames and size.
    runPreflightTest: (): Promise<PreflightResultInfo> =>
      ipcRenderer.invoke('recorder:runPreflightTest'),

    // --- Disk usage and retention ---
    getDiskUsage: (): Promise<DiskUsageInfo> => ipcRenderer.invoke('recorder:getDiskUsage'),

    // The dry run and the deletion are separate channels on purpose: previewing
    // must never be mistakable for performing.
    previewRetentionSweep: (): Promise<RetentionPreviewInfo> =>
      ipcRenderer.invoke('recorder:previewRetentionSweep'),
    runRetentionSweep: (): Promise<RetentionSweepInfo> =>
      ipcRenderer.invoke('recorder:runRetentionSweep'),

    // Saves the last N seconds from the buffer the capture is already writing.
    // The recording continues.
    saveReplay: (): Promise<{
      outputPath: string
      durationSeconds: number
      sizeBytes: number
    }> => ipcRenderer.invoke('recorder:saveReplay')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type LeagueVidApi = typeof api
