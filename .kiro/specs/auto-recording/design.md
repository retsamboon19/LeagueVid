# Design Document

## Overview

Recording is added as five layers, each independently testable and each shipped in
an order that leaves the app working:

1. **Foundations** (R1–R4) — a test runner, persisted Recording_Settings, one shared
   ffmpeg path resolver, and a fix to the filename timestamp parser that today
   silently mis-dates any recording made before 10am.
2. **Capture** (R5–R10) — encoder probing, a pure argument builder, a long-lived
   process manager, device enumeration, and durable MKV→MP4 output.
3. **Orchestration** (R11, R12, R15, R18, R21) — the `recordings` table, a pure
   state reducer, the `recorder:` IPC namespace with a new push pattern, automatic
   start/stop, background lifecycle, and disk safety.
4. **League integration** (R13, R14, R16, R17) — Live Client Data polling, the
   best-effort LCU client, exact linking, and live-event fallback bookmarks.
5. **Extras** (R19, R20, R22, R23) — loopback audio, presets and preflight, replay
   buffer, packaging.

The architectural spine is that **capture is a child process the main process
supervises, and every decision about how to invoke it is a pure function.** The
impure parts (spawning, disk, polling, IPC) are thin and concentrated; the parts
worth testing (argv construction, progress parsing, state transitions, median
anchoring, retention selection) have no I/O in them at all.

### Why ddagrab, and why not the alternatives

| Option | Rejected because |
|---|---|
| Electron `desktopCapturer` + `MediaRecorder` | No encoder choice, no bitrate control, dies with the window, cannot capture fullscreen-exclusive. |
| Graphics hook into the game (`ow-graphics-hook64.dll` style) | Injection into the League process. This is exactly what Vanguard breaks on, and it is the one failure mode with a real cost to the user. |
| `gdigrab` | CPU-bound, no fullscreen-exclusive capture, visibly worse. |

`ddagrab` uses Desktop Duplication, keeps frames in GPU memory, and never touches
the game. R24 exists to make that a tested constraint rather than an implementation
detail somebody later "optimizes" away.

### Why MKV then remux

A recording ends in one of three ways: cleanly, by the app being killed, or by the
machine losing power. MP4 stores its index (`moov`) at the end, so a truncated MP4
is unplayable. Fragmented MP4 (`+frag_keyframe+empty_moov`) survives truncation but
writes duration 0 into `mvhd`, which breaks the existing `probeMp4Duration.ts` fast
path and would silently regress library scanning. Matroska survives truncation and
still reports a usable duration, and `-c copy` into MP4 afterwards costs a disk read
and write. So: record MKV, remux on stop, and on remux failure keep the MKV and
import that instead (R10.5) — never discard footage to preserve a container
preference.

## Architecture

```
main process
  recorder/
    ffmpegBinary.ts        shared resolver: dev / packaged / asar.unpacked   (R4)
    encoderCapabilities.ts parse -encoders/-filters, probe each candidate    (R5)
    ffmpegArgs.ts          PURE: settings + target -> argv                   (R6)
    ffmpegProcess.ts       spawn, -progress parsing, graceful 'q' stop       (R7)
    displays.ts            screen.getAllDisplays() -> ddagrab output_idx     (R8)
    audioDevices.ts        parse dshow device listing                        (R9)
    remux.ts               mkv -> mp4 -c copy, verify, orphan repair         (R10,R11)
    outputPaths.ts         output dir resolution + unique naming             (R10)
    diskSpace.ts           free space checks, usage, retention selection     (R21)
    recorderState.ts       PURE reducer: Recorder_State x Event -> State     (R12)
    recorderService.ts     owns the child; only writer of Recorder_State
    replayBuffer.ts        tee muxer segment ring + concat save              (R22)
    loopbackAudio.ts       hidden-window loopback -> localhost socket        (R19)
    ipc.ts                 recorder:* pull handlers + broadcast()            (R12)
  league/
    liveClientData.ts      https://127.0.0.1:2999 polling client             (R13)
    lcuClient.ts           lockfile/registry/cmdline auth, gameflow reads    (R14)
    gameWatcher.ts         lifecycle events + median game-start anchoring    (R13)
    liveEvents.ts          live event feed -> AutoTagEvent[]                 (R17)
  tray.ts                  tray icon, menu, tooltip                         (R18)
  db/repository.ts         recordings table CRUD, recordingSettings key
  db/index.ts              migrate(): recordings; migrateAddColumns: source

preload
  window.api.recorder.*    pull methods + onState/onProgress/... subscribers

renderer
  lib/useRecorder.ts               subscribe + pull-on-mount hook
  components/RecorderIndicator.tsx header status pill
  views/RecordingSettings.tsx      Settings.tsx child section
  lib/autoLinkVideo.ts             + linkRecordedVideo() exact path         (R16)
```

### Layering rule

`ffmpegArgs.ts`, `recorderState.ts`, the progress parser, the device-listing parser,
the lockfile parser, the median anchoring and the retention selector are pure and
import nothing from Electron. That is what makes R2.4 achievable — the test suite
needs no display, GPU, League client or network.

`recorderService.ts` is the only module that both holds the child handle and writes
state. Everything else either computes or observes.

## Components and Interfaces

### Recording_Settings (`src/shared/types.ts`)

Follows the `PlayerPreferences` precedent exactly: an exported interface, an
exported `DEFAULT_RECORDING_SETTINGS`, a dedicated `settings`-table key, and
defaults merged over the stored value on read (R3.3). It is deliberately **not**
folded into `AppSettings`, which is only the Riot account list.

```ts
export interface RecordingSettings {
  enabled: boolean                  // master switch for automatic recording
  outputDir: string | null          // null = default (app folder / recordings)

  displayId: number | null          // Electron display id; null = primary
  resolutionScale: 'native' | '1440p' | '1080p' | '720p'
  framerate: 30 | 48 | 60
  drawMouse: boolean

  encoder: string | null            // null = use the probed best
  rateControl: 'quality' | 'bitrate'
  quality: number                   // CQ/CRF/QP/global_quality, per encoder
  bitrateKbps: number
  // -g also sets the granularity of the clip editor's lossless "fast" cut,
  // which is why this is a labeled user setting and not a hidden constant.
  keyframeIntervalSeconds: number

  micDeviceName: string | null
  desktopAudioDeviceName: string | null
  useLoopbackBridge: boolean
  audioTrackMode: 'mixed' | 'separate'

  startDelayMs: number              // manual override only; see R15.3
  stopDelayMs: number               // keep recording past game end
  minKeepDurationMs: number         // below this, discard (remakes)

  replayBufferEnabled: boolean
  replayBufferSeconds: number
  replayHotkey: string | null

  retentionEnabled: boolean         // opt-in; see R21.6
  retentionMaxGb: number | null
  retentionMaxAgeDays: number | null
}
```

`quality` is one number across five encoders whose scales differ (CQ 0–51, CRF
0–51, QP 0–51, `global_quality`, MF `quality` 0–100). The argument builder owns the
translation; the UI labels it per encoder. A single field beats five conditionally
present ones for a value the user thinks of as "how good should it look".

### Encoder capabilities (R5)

Two stages, because "compiled in" and "works here" are different claims:

1. Parse `ffmpeg -encoders` and `ffmpeg -filters` for candidate presence.
2. For each candidate, run an **Encoder_Probe**: a separate child doing
   `-f lavfi -i testsrc=duration=1:size=640x480:rate=30 -c:v <enc> -f null -`,
   with a hard timeout and forced kill.

Stage 2 is not optional. A driver-level hardware encoder init can hang
indefinitely; OBS ships `obs-nvenc-test.exe` and `obs-qsv-test.exe` as separate
executables for exactly this reason. Here the isolation is a child process with a
timer that kills it, so a hang costs one probe result and nothing else (R5.4, R5.5).

Ranking is NVENC > QSV > AMF > Media Foundation > libx264 (R5.6): dedicated silicon
first, vendor SDKs before the generic OS wrapper, CPU last. The result is cached in
settings (R5.7) with a manual refresh (R5.8), because probing costs seconds and
hardware rarely changes between launches.

**This is the go/no-go point for the quality presets.** If no hardware encoder
passes on the development machine, the R20 preset defaults have to be re-centred
around libx264 rather than assumed NVENC headroom.

### Capture_Argv (R6)

Native capture, the default, never leaves the GPU:

```
ffmpeg -hide_banner -loglevel warning -nostats -progress pipe:1
  -init_hw_device d3d11va
  -filter_complex "ddagrab=output_idx=0:framerate=60:draw_mouse=0[v]"
  -map "[v]" -c:v h264_nvenc -rc vbr -cq 21 -b:v 0 -maxrate 40M -bufsize 80M
  -g 60 -f matroska <session>.mkv
```

Scaling costs a round trip to system memory
(`hwdownload,format=bgra,scale=...,format=nv12`), so native is the default and
scaling is an explicit choice (R6.2, R6.3).

Rate control per encoder (R6.4) — the table the builder encodes:

| encoder | quality mode | bitrate mode |
|---|---|---|
| `h264_nvenc` / `hevc_nvenc` | `-rc vbr -cq N -b:v 0` | `-rc cbr -b:v Nk -maxrate Nk -bufsize 2Nk` |
| `h264_qsv` | `-global_quality N` | `-b:v Nk -maxrate Nk` |
| `h264_amf` | `-rc cqp -qp_i N -qp_p N` | `-rc cbr -b:v Nk` |
| `h264_mf` | `-rate_control quality -quality N` | `-rate_control cbr -b:v Nk` |
| `libx264` | `-crf N -preset veryfast` | `-b:v Nk -maxrate Nk -bufsize 2Nk` |

Getting this wrong is quiet rather than loud — passing `-crf` to NVENC or `-cq` to
libx264 is accepted-and-ignored or errors depending on build, and the user just gets
the wrong bitrate. Hence R6.12: a table-driven test over every encoder × mode ×
scaled/native × 0/1/2 audio inputs.

Desync mitigation on any device input (R6.9), because `ddagrab` + `dshow` drift is a
known ffmpeg behavior: `-use_wallclock_as_timestamps 1` on each dshow input,
`-vsync cfr` on the video output, `aresample=async=1:first_pts=0` on the audio path.
R20.5 measures whether it worked instead of assuming.

### Process management (R7)

`-progress pipe:1` emits `key=value` lines terminated by `progress=continue`.
Chunk boundaries fall anywhere, so the parser keeps a residual buffer and only
emits on a complete block (R7.3) — a test fixture splits a block mid-key
deliberately. Emission to renderers is throttled to 1 Hz (R7.4); the parse rate is
whatever ffmpeg produces.

Stopping writes `q` to stdin and waits up to 15 s, then kills (R7.6, R7.7).
`SIGTERM` is never the first move (R7.8): ffmpeg does not finalize the container on
a signal, which for MKV means a file missing its cues and for MP4 means no file
worth having. The 15 s ceiling exists so a wedged child cannot block a quit (R18.7).

### `recordings` table (R11)

```sql
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  temp_path TEXT NOT NULL,
  final_path TEXT,
  state TEXT NOT NULL,              -- recording|stopping|remuxing|complete|failed|discarded
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  game_start_ms INTEGER,
  match_id_hint TEXT,
  platform TEXT, puuid TEXT, queue_id INTEGER, champion_name TEXT,
  live_events TEXT,
  link_state TEXT,                  -- pending|linked|failed|skipped
  link_attempts INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL,
  ffmpeg_error TEXT, dropped_frames INTEGER, avg_fps REAL, size_bytes INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
```

Created through `migrate()`'s `CREATE TABLE IF NOT EXISTS` idiom; `videos.source`
goes into `migrateAddColumns`' `columnsToAdd` list (R11.2). There is no version
table, and this design does not introduce one.

`settings_json` records the configuration a session actually ran with, so a
"why is this one 40 GB" question is answerable after the fact. `source` on `videos`
drives both a library badge and the retention scope — R21.7/R21.9 make deletion
structurally unable to touch imported files.

**Orphan recovery** (R11.4–R11.7) is a launch-time sweep for rows still in
`recording`/`stopping`. If the MKV is there, remux and import; if not, mark failed.
This is the payoff of the container choice: kill the app mid-game and the next
launch produces a playable file.

### State machine (R12)

```
disabled --enable--------> idle
idle     --game-detected-> arming
arming   --render-ready--> starting
starting --first-frames--> recording
recording --game-ended---> (stopDelay) --> stopping
stopping --exit 0--------> remuxing --> finalizing --> idle
recording --child-died / disk-full--> failed --> idle
finalizing: duration < minKeepDuration ? discard : insertVideo + queue link
```

A pure reducer (R12.1) with illegal transitions returning the state unchanged
(R12.2). `arming` and `starting` are separate because the gate has two independent
conditions: League responding, and frames actually arriving. Collapsing them would
lose the ability to report *which* one is outstanding.

### Render readiness (R15.2)

Outplayed's own manifest declares `wait_for_stable_framerate: 30` — they wait for
the game to render steadily rather than trusting a delay. The equivalent here needs
no hook:

- Live Client Data answering at all means the game is genuinely up, not loading.
- `ddagrab` delivering N consecutive frames at the target interval means the capture
  pipeline is really producing output.

Only then is the session declared started, and only then is the recording start
timestamp — the anchor for Sync_Offset — taken. `startDelayMs` survives as a manual
override (R15.3), not the trigger.

### Exact sync (R13.7, R16.2)

`gameData.gameTime` from `/liveclientdata/allgamedata` is seconds since the game
clock started, so each sample gives
`gameStartWallClock ≈ Date.now() - gameTime * 1000`. Individual samples carry
request latency and polling jitter; the **median** across many samples cancels it
(R13.7) where a mean would not, because the error distribution has a one-sided tail
(a slow response is possible, a negative one is not).

```
sync_offset_ms = gameStartWallClock - recordingStartWallClock
```

That is a measurement. The existing path infers the same number from a filename
timestamp and a best-fit search over candidate matches. For recorded VODs, R16.1
skips `searchMatchesForVideo` and `bestRecordingFit` entirely and fetches
`match_id_hint` directly.

Match id composition (R14.5): `/lol-gameflow/v1/session` exposes
`gameData.gameId`, and match-v5 ids are `PLATFORM_gameId` — so `na1` + `_` +
`7412345678`. The LCU is best-effort throughout (R14.6); without it, recordings
still link through the existing search path, just less precisely.

### IPC (R12.4–R12.7)

Every existing channel is pull-only `invoke`/`handle` named
`domain:camelCaseAction`. Recorder pulls follow that convention:

```
recorder:getState getSettings saveSettings getCapabilities refreshCapabilities
         listDisplays listAudioDevices getOutputDirInfo chooseOutputDir
         resetOutputDir revealOutputFolder startManual stopManual
         runPreflightTest estimateBitrate saveReplay listRecordings
         getPendingLinks markLinked getDiskUsage previewRetentionSweep
         runRetentionSweep
```

Push is new to this codebase — there is no `webContents.send` anywhere today. It is
introduced as one `broadcast(channel, payload)` helper over
`BrowserWindow.getAllWindows()`, used by four channels:

```
recorder:state  recorder:progress  recorder:recordingSaved  recorder:error
```

**Every push channel has a pull equivalent** (R12.6). A renderer that mounts halfway
through a recording must be able to ask "what is happening right now" rather than
sitting blank until the next push. `useRecorder` pulls on mount, then subscribes.

Preload exposes subscriptions as `onState(cb): () => void` returning an
unsubscribe, so a React effect's cleanup is the natural shape and listeners cannot
accumulate across remounts.

### Retention (R21)

Deletion is the one destructive behavior here, so it is constrained three ways:
off unless enabled (R21.6), scoped to `source='recorded'` and non-favorites
(R21.7–R21.9), and previewable (R21.11). The selector is a pure function from
(candidate list, limits) to a delete list, so R21.12 — preview equals actual
deletion — is a test asserting the sweep calls delete with exactly the preview's
output, not two code paths hoping to agree.

### Replay buffer (R22)

Naive implementation is two encodes. Instead, one encode is split with the `tee`
muxer: one leg to the session MKV, one to a wrapping segment ring
(`segment_time`, `segment_wrap`, `reset_timestamps`, plus `h264_mp4toannexb` for
the mpegts leg). Saving concatenates the newest segments with the concat demuxer and
`-c copy`, which is why the ring is mpegts — it concatenates cleanly where MP4 does
not. Segment selection across a wrap boundary is the fiddly part and the reason
R22.6 is called out separately.

### System audio (R19)

The bundled ffmpeg has **no WASAPI loopback**. Its only Windows audio input is
`dshow`, which can capture a microphone or a virtual device the user probably does
not have. Overwolf solves this with its own `win-wasapi.dll` / `NAudio.dll` — and
notably ships no virtual audio driver either, which confirms the gap is real rather
than an oversight in this build.

So: a hidden `BrowserWindow` with `setDisplayMediaRequestHandler` returning
`audio: 'loopback'`, an `AudioWorklet` producing Float32 PCM, a localhost TCP
socket, and ffmpeg reading `-f f32le -ar 48000 -ac 2 -i tcp://127.0.0.1:PORT` mixed
with the mic and drift-corrected by `aresample=async=1`.

Until that lands, the UI states plainly that system audio is unavailable (R19.6).
Silently recording silence is the failure mode worth engineering against.

## Error Handling

| Condition | Behavior | Req |
|---|---|---|
| No hardware encoder passes probing | select libx264, say so in Settings | R5.10 |
| Encoder probe hangs | child killed at timeout, candidate marked failed, app unaffected | R5.4, R5.5 |
| ffmpeg binary missing | error naming the path searched | R4.5 |
| Configured display gone | fall back to primary, report the substitution | R8.4 |
| Configured audio device gone | start without it, report the omission | R9.6 |
| Loopback bridge fails | record without system audio, report degradation | R19.5 |
| Child exits non-zero | stderr tail stored on the row, state -> failed | R7.9 |
| Child dies mid-session | retain footage, -> failed -> idle, no restart needed | R15.8 |
| Graceful stop times out | force kill, record that it happened | R7.7 |
| Remux fails | keep the MKV and import it | R10.5 |
| App killed mid-session | launch sweep remuxes and imports the orphan | R11.4–R11.7 |
| Orphan row with no file | mark failed, do nothing else | R11.6 |
| Session under minKeepDuration | discard file and row (remake) | R15.6 |
| Insufficient disk at start | refuse to start, state the reason | R21.1 |
| Disk fills mid-session | graceful stop, report why | R21.3 |
| Match not yet in match-v5 | retry 10s/30s/1m/2m/5m | R16.3 |
| Hint exhausted | fall back to search-based linking | R16.4 |
| Linking permanently failed | bookmarks from the live event feed | R17.3 |
| LCU unreachable | Live Client Data only; no hint, no failure | R14.6 |
| Quit while recording | defer, stop, remux, then quit, time-bounded | R18.6, R18.7 |

The recurring principle: **never trade footage for tidiness.** Every failure branch
above keeps whatever was captured, in the worst container, with the wrong name, in
the wrong state — rather than deleting it to keep the model clean. The only
deletions in the whole design are the post-remux MKV (R10.4), the sub-minimum
discard (R15.6), and the explicitly opt-in retention sweep (R21.6).

## Testing Strategy

`vitest` in a Node environment, run by `npm run test`, with no Electron, display,
GPU, League client or network dependency (R2). Test files live beside the modules
they cover and import `describe`/`it`/`expect` explicitly rather than relying on
globals, which means they typecheck under the existing `tsconfig.node.json` /
`tsconfig.web.json` projects instead of having to be excluded from them. Nothing
imports them from an entry point, so they are never bundled and `npm run build` is
unaffected (R2.5).

What gets tested, and why it is worth testing:

| Module | Tests | Why |
|---|---|---|
| `parseFileNameDate` | single- and double-digit hours, the two real Outplayed names, implausible-date rejection | the bug being fixed is silent and time-of-day dependent (R1) |
| `ffmpegArgs` | every encoder × rate mode × scaled/native × 0/1/2 audio | wrong flags are accepted-and-ignored, not errors (R6.12) |
| progress parser | blocks split across chunk boundaries, partial trailing block | stream framing is the classic source of dropped updates (R7.3) |
| `recorderState` | full transition table incl. illegal events and mid-flight errors | the reducer is the whole correctness argument for the lifecycle (R12.1, R12.2) |
| `gameWatcher` | median anchoring over jittered samples, 3-failure debounce | a wrong anchor mis-places every bookmark (R13.7, R13.9) |
| `lcuClient` | lockfile parse, cmdline extraction, matchId composition | string parsing over formats we don't control (R14.7) |
| `linkRecordedVideo` | offset arithmetic, backoff schedule, fallback | off-by-one here is the current product's main defect (R16.7) |
| `liveEvents` | per-type mapping, Riot-vs-live precedence | R17.6 |
| retention selector | ordering, favorite/imported exclusion, preview == deletion | it deletes user files (R21.13) |
| replay segments | selection across a ring wrap, concat list | R22.6 |
| quit ordering | stop -> remux -> finalize -> quit with a fake child | R18.11 |
| estimator / health | GB-per-hour math, drop and speed thresholds | R20.8 |

Three things cannot be verified by tests and are verified by hand, once, on real
hardware: that a real game is detected and recorded end to end (R15), that the
resulting sync offset places bookmarks correctly (R16), and that a packaged build
resolves ffmpeg for both clipping and recording (R23.2).

## Open Risks

Surfaced rather than absorbed. Each is a real possibility of this feature working on
the development machine and not on someone else's.

1. **System audio.** No WASAPI loopback in the bundled ffmpeg. The Loopback_Bridge
   (R19) is the only route that does not demand the user install a virtual audio
   driver, and it is the least conventional part of this design.
2. **`ddagrab` + `dshow` desync.** Documented ffmpeg behavior. Mitigated in the
   argument builder (R6.9), measured by the preflight test (R20.5). Mitigation is
   not proof.
3. **HDR.** Worse than first assumed, and now measured rather than guessed.
   `ffmpeg -h filter=ddagrab` on the bundled 6.1.1 build shows `output_fmt`
   defaulting to `8bit` and `allow_fallback` defaulting to **false** — so on a
   display that cannot supply 8-bit BGRA, ddagrab *errors out* rather than
   producing washed-out output. The capture filter therefore always passes
   `allow_fallback=1`, and the `zscale`/`tonemap` chain handles whatever format
   comes back (R6.11). Recording nothing is a worse outcome than recording
   something that needs tonemapping.

8. **`ddagrab` can open a display and still deliver zero frames.** Observed on
   the development machine: ddagrab reports `Opened dxgi output 0 with dimensions
   2560x1440` and then produces no frames at all, while `gdigrab` on the same
   machine records normally (1.3 MB in 3 s). Desktop Duplication only delivers
   on desktop *updates*, so an idle, blanked or non-composited display yields
   nothing even though every ffmpeg flag was accepted. This is the concrete
   justification for the render-readiness gate (R15.2) requiring observed frames
   rather than a delay, and for the preflight test (R20.4) reporting measured
   framerate — "the command was accepted" is not evidence that capture works.
4. **Vanguard.** Display duplication should be untouched by it, and the game process
   is never hooked (R24). Still worth validating on a Vanguard-enabled account
   before claiming compatibility.
5. **GPL v3.** The bundled Windows ffmpeg is GPL v3 and this repository has no
   license file. Already true for clipping; recording makes ffmpeg load-bearing
   rather than incidental.
6. **Packaging.** Recording will not work in any packaged build until R23, because
   `ffmpeg-static` resolves inside the asar archive.
7. **Multi-GPU laptops.** `ddagrab`'s `output_idx` can address a different adapter
   than the one driving the monitor the user means. This is why display selection is
   a user-facing picker (R8.5) rather than an automatic guess.
