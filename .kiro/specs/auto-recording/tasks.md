# Implementation Plan

- [x] 1. Test harness, recording settings, and the filename timestamp fix
- [x] 1.1 Add the vitest harness
  - `vitest` devDependency, node-environment `vitest.config.ts`, `npm run test` and
    `test:watch`
  - Tests sit beside their modules and import from `vitest` explicitly, so they
    typecheck under the existing projects and are never bundled
  - Lands before 1.2 only because the fix's fixtures need somewhere to run
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
- [x] 1.2 Fix the single-digit hour in `parseFileNameDate.ts` (its own commit)
  - Pattern 1 requires `(\d{2})` for the hour, so `Desktop 07-27-2026_0-25-37-967.mp4`
    and `League of Legends 07-27-2026_1-02-21-702.mp4` match no pattern and fall back
    to `birthtimeMs || mtimeMs` — every recording made before 10am is mis-dated
  - Accept `(\d{1,2})` for the hour; keep the plausible-date rejection
  - Fixtures for both real file names above, plus the existing padded forms
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
- [x] 1.3 Add `RecordingSettings` and `DEFAULT_RECORDING_SETTINGS` to `src/shared/types.ts`
  - Own interface, not folded into `AppSettings`; follow the `PlayerPreferences` precedent
  - _Requirements: 3.1, 3.2_
- [x] 1.4 Persist recording settings and surface a read-only Settings section
  - `getRecordingSettings` / `saveRecordingSettings` in `repository.ts` under a
    `recordingSettings` key, defaults merged on read, defaults on parse failure
  - `recorder:getSettings` / `recorder:saveSettings` IPC plus the preload `recorder`
    namespace
  - `RecordingSettings.tsx` as a `<h2>Recording</h2>` section in `Settings.tsx`,
    read-only for now
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 2. ffmpeg resolution and isolated encoder probing
- [x] 2.1 Extract `ffmpegBinaryPath()` and refactor `clipService.ts` onto it
  - Handle dev, packaged, and `app.asar.unpacked`; error naming the path searched
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
- [x] 2.2 Probe encoders in hard-timeout-bounded child processes
  - Parse `-encoders` and `-filters`, then verify each candidate with a one-second
    `testsrc` encode in its own child that cannot hang or crash the app
  - Rank nvenc > qsv > amf > mf > libx264; cache in settings; manual refresh
  - Show "Detected: NVENC H.264 (hardware)" in Settings; fall back to libx264 loudly
  - **Go/no-go answered — GO.** `scripts/probe-encoders.ts` on the development
    machine: `h264_nvenc` PASS (285ms), `h264_amf` PASS, `h264_mf` PASS, `libx264`
    PASS, `hevc_nvenc` PASS, `h264_qsv` FAIL (no active Intel iGPU — "Error while
    opening encoder"). `ddagrab`, scaling and tonemap filters all present; 213
    encoders and 503 filters parsed out of the real listings. Task 15 presets can
    assume hardware NVENC rather than being re-centred on libx264
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10_

- [x] 3. Pure argument builder
  - `ffmpegArgs.ts` maps settings + capture target to argv with no spawning and no
    filesystem access
  - Native capture by default; scaled path via `hwdownload,format=bgra,scale=,format=nv12`
  - The per-encoder rate-control table, keyframe interval, `draw_mouse`, matroska
    output, `-progress pipe:1`
  - HDR tonemap chain; audio inputs mixed or separate; desync mitigations
    (`-use_wallclock_as_timestamps 1`, `-vsync cfr`, `aresample=async=1:first_pts=0`)
  - Table-driven tests: every encoder × both rate modes × scaled/native × 0/1/2 audio
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12_

- [x] 4. Long-lived capture process manager
  - `ffmpegProcess.ts`: piped stdin, `-progress` parsing into `RecorderProgress`
    (frame, fps, total_size, out_time_us, drop_frames, dup_frames, speed)
  - Throttle emission to 1/sec; bounded stderr tail as in `clipService`
  - Graceful `q` stop with a 15s ceiling then force kill — never signal first
  - Tests: progress blocks split across chunk boundaries; stop-timeout path
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

- [x] 5. Display and audio device enumeration
  - `displays.ts` maps `screen.getAllDisplays()` to `ddagrab output_idx` with labels,
    resolutions, scale factor, primary flag; fall back to primary when the configured
    display is gone
  - `audioDevices.ts` parses `ffmpeg -list_devices true -f dshow -i dummy`, flagging
    likely loopback devices (Stereo Mix, VB-Cable, virtual-audio-capturer)
  - Both surfaced over IPC as pickers; note the multi-GPU `output_idx` caveat
  - Tests: device-listing fixtures with quoted names and alternative-name lines
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 6. Remux, recordings table, orphan recovery
  - `recordings` table in `migrate()`; `['source','TEXT']` in `migrateAddColumns`
  - `remux.ts`: mkv → mp4 `-c copy`, verify existence and a sane duration, delete the
    mkv only on success
  - Launch sweep repairs rows stuck in `recording`/`stopping`; mark failed when the
    file is gone; keep the mkv and import it when remux fails
  - Output naming that identifies the game start time
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

- [x] 7. State machine, IPC, header indicator
  - Pure `recorderState.ts` reducer; illegal transitions are no-ops
  - `recorderService.ts` owns the child and is the only writer of state
  - `ipc.ts` pull handlers plus a `broadcast()` helper over
    `BrowserWindow.getAllWindows()` — the first push pattern in this codebase
  - A pull equivalent for every push channel; preload `recorder.onState(cb)` returning
    an unsubscribe; `useRecorder` pulls on mount then subscribes
  - `RecorderIndicator` in `.app-header-actions`; manual start/stop only, no game
    detection yet
  - Tests: exhaustive transition table including illegal transitions and mid-flight errors
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10_

- [x] 8. Live Client Data watcher
  - `liveClientData.ts` polls `https://127.0.0.1:2999/liveclientdata/allgamedata` with
    `rejectUnauthorized: false` and a ~1.5s timeout; 2s idle, 5s while recording
  - Three consecutive failures required before declaring the game over
  - Extract `gameData.gameTime`, `gameMode`, `mapNumber`, the active player's champion,
    and `events.Events`
  - `gameWatcher.ts` emits `game-detected`, `gameplay-started`, `game-ended`,
    `game-lost`; derives median `gameStartWallClockMs`
  - Tests: median anchoring against jittered samples, failure debouncing, payload fixtures
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9_

- [x] 9. LCU client for the match-id hint
  - Credentials from the lockfile (`LeagueClient:PID:PORT:PASSWORD:https`, basic auth
    `riot:PASSWORD`), then known install paths, `RiotClientInstalls.json`, the registry,
    and finally a `Get-CimInstance Win32_Process` read of `LeagueClientUx.exe`'s
    `--app-port` / `--remoting-auth-token`
  - Read `/lol-gameflow/v1/gameflow-phase` and `/lol-gameflow/v1/session`; compose
    `matchId = platform + '_' + gameId`
  - Entirely best-effort: every failure degrades to Live Client Data only
  - Tests: lockfile parsing, command-line arg extraction, matchId composition per platform
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

- [x] 10. Automatic start/stop with a render-readiness gate
  - Wire the watcher into the service; gate the start on Live Client Data responding
    **and** N consecutive frames at the target interval — not on a fixed delay
  - Keep `startDelayMs` as a manual override only
  - Disk preflight before starting; `stopDelayMs` after game end; discard under
    `minKeepDurationMs`
  - Persist match/platform/puuid/queue/champion hints and the game start onto the row
  - Handle a child dying mid-session without needing a restart
  - Tests: reducer driven by scripted watcher sequences including a game that vanishes
    mid-recording
  - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9_

- [x] 11. Exact auto-link for recorded footage
  - `linkRecordedVideo()` in `autoLinkVideo.ts`: fetch `match_id_hint` directly, compute
    `syncOffsetMs` from the measured `game_start_ms`, bypassing `searchMatchesForVideo`
    and `bestRecordingFit`
  - Retry on backoff (10s, 30s, 1m, 2m, 5m) for match-v5 lag; fall back to the search
    path when the hint is exhausted
  - Pending-link queue with attempt counts, drained on Library mount
  - Tests: offset math, backoff schedule, fallback
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7_

- [x] 12. Live event fallback bookmarks
  - Persist the in-game event feed onto the recordings row
  - Riot's timeline wins when linking succeeds; live events only when linking has
    permanently failed
  - Map live events to `tags` with `source='auto'` using `EventTime * 1000 + syncOffset`
  - Tests: per-event-type mapping fixtures, precedence between live and Riot tags
  - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_

- [x] 13. Background app lifecycle
  - `requestSingleInstanceLock()` with `second-instance` focusing the window
  - Tray with a state-reflecting tooltip and menu (Open / Recording on-off / Start-stop
    now / Save replay / Quit)
  - `mainWindow.on('close')` hides in background mode; `window-all-closed` stops quitting
  - `before-quit` sets `isQuitting` and, while recording, `preventDefault()`s until the
    session stops and remuxes (30s cap), then quits
  - `powerSaveBlocker` held during recording; `setLoginItemSettings` with `--hidden`
    honored by not showing the window; best-effort `q` on `session-end`
  - Tests: quit-while-recording ordering (stop → remux → finalize → quit) with a fake child
  - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11_

- [x] 14. System audio without a virtual driver
  - Hidden `BrowserWindow` with `setDisplayMediaRequestHandler` and `audio: 'loopback'`,
    an `AudioWorklet` producing Float32 PCM over a localhost TCP socket, read by ffmpeg
    as `-f f32le -ar 48000 -ac 2 -i tcp://127.0.0.1:PORT`
  - Mixed with mic input and drift-corrected via `aresample=async=1`
  - Until this lands, the UI states plainly that system audio is unavailable rather than
    silently recording silence
  - Tests: PCM framing, socket lifecycle, mixing arg generation
  - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7_

- [x] 15. Preflight test and quality presets
  - Low/Medium/High/Custom presets, a live "~X GB per hour" estimate, and a "Test for 10
    seconds" action running the exact configured pipeline
  - Report measured fps, dropped frames, A/V drift and file size, with a specific
    recommendation when it sees trouble
  - In-app warning during real recordings when drops exceed ~1% of frames or speed falls
    under 0.95x
  - Tests: estimator math, health-threshold logic
  - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8_

- [ ] 16. Disk management and retention
  - Free-space preflight requiring `max(5GB, estimatedBitrate × 60min × 1.2)` to cover
    the remux peak; a 60s check during recording that stops gracefully rather than
    filling the disk; a usage readout
  - Retention by total GB and age, **opt-in**, scoped to `source='recorded'` and
    non-favorites, with a dry-run preview listing exactly which files would go
  - Tests: retention ordering, favorite and imported exclusion, preview matching actual
    deletion
  - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9, 21.10, 21.11, 21.12, 21.13_

- [ ] 17. Replay buffer
  - Single encode split with the `tee` muxer into the session file and a wrapping segment
    ring (`segment_time`, `segment_wrap`, `reset_timestamps`, `h264_mp4toannexb` on the
    mpegts leg) so the buffer costs one encode rather than two
  - `globalShortcut` hotkey concatenates the newest segments with the concat demuxer and
    `-c copy`, without interrupting the session
  - Tests: segment selection across a wrap boundary, concat list generation
  - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7_

- [ ] 18. Packaging and documentation
  - Packaging config with `ffmpeg.exe` asar-unpacked; verify `ffmpegBinaryPath()` in a
    real packaged build for both clipping and recording
  - Update the README, which currently says LeagueVid "doesn't record anything itself",
    plus the Requirements section
  - _Requirements: 23.1, 23.2, 23.3, 23.4_

- [ ] 19. Verify anti-cheat and process safety constraints hold
  - Confirm no injection, no process memory access, no game file modification anywhere in
    the implementation; capture is display duplication only and League is touched only
    over its local HTTP endpoints
  - Validate a real recording on a Vanguard-enabled account
  - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_
