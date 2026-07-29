# Requirements Document

## Introduction

LeagueVid today is a review tool for footage someone else recorded. It links
existing files to Riot match data, guesses which match a file belongs to from the
timestamp in its filename, and derives bookmark positions from that guess. This
feature makes LeagueVid produce the footage itself: detect a League game starting,
capture it at a user-chosen quality, stop when the game ends, and hand the finished
file to the existing library and auto-link pipeline.

The payoff is not only convenience. A recorder knows the wall-clock time of its own
first frame, and the League Live Client Data endpoint reports the in-game clock. Put
together, the offset between video time and game time becomes **measured rather than
inferred**, which removes the single largest source of misplaced bookmarks in the
current product (`bestRecordingFit` / `searchMatchesForVideo` in
`src/renderer/src/lib/autoLinkVideo.ts`). The League client also exposes the exact
`gameId`, so a recorded VOD can skip match searching entirely.

### Decisions fixed before this document

These are constraints, not open questions. Acceptance criteria below assume them.

- **Capture is ffmpeg `ddagrab` (Desktop Duplication) spawned from the main
  process**, not Electron `desktopCapturer`. It gives real encoder, bitrate and
  framerate control, survives the app window closing, captures
  fullscreen-exclusive output, and never touches the game process.
- **The game process is never hooked.** No injected DLL, no graphics hook, no
  helper injector. Anti-cheat compatibility is the reason, and display
  duplication is the deliberate alternative.
- **Recording is written as Matroska and remuxed to MP4 on stop.** A truncated MP4
  has no `moov` atom and will not play; fragmented MP4 writes a zero duration into
  `mvhd` which defeats the existing `probeMp4Duration.ts` fast path. MKV tolerates
  truncation, and the remux is a stream copy at disk speed.
- **LeagueVid becomes a background application** with a tray icon, close-to-tray,
  a single-instance lock, optional launch at login, and a power-save blocker held
  while recording.

### Environment facts these requirements are built on

- The bundled ffmpeg (`node_modules/ffmpeg-static/ffmpeg.exe`) is 6.1.1, gyan
  essentials, GPL v3. Its build configuration includes `ddagrab`, `gdigrab`,
  `dshow`, `h264_nvenc`, `hevc_nvenc`, `av1_nvenc`, `h264_qsv`, `h264_amf`,
  `h264_mf`, `libx264`, `scale_cuda`, `tonemap`, `zscale`, and both the matroska
  and mp4 muxers. No new native dependency is required.
- **That build has no WASAPI loopback input.** The only Windows audio input is
  `dshow`. Desktop/game audio therefore requires either a virtual capture device
  the user probably does not have, or a bridge that pulls loopback audio out of
  Chromium and feeds it to ffmpeg.
- The codebase has no game-detection primitive, no tray, no single-instance lock,
  no test framework, and no packaging configuration. Every existing IPC channel is
  a pull-only `invoke`/`handle` pair named `domain:camelCaseAction`; there is no
  `webContents.send` anywhere, so pushing recorder status to the renderer is a new
  pattern that has to be introduced deliberately.

## Glossary

- **LeagueVid**: The Electron desktop application as a whole.
- **Recorder_Service**: The main-process component that owns the capture child
  process and is the only writer of Recorder_State.
- **Recorder_State**: The single value describing what the recorder is doing —
  `disabled`, `idle`, `arming`, `starting`, `recording`, `stopping`, `remuxing`,
  `finalizing`, or `failed`.
- **Recording_Settings**: The user's persisted recorder configuration (enabled,
  output folder, display, resolution scale, framerate, encoder, rate control,
  quality/bitrate, keyframe interval, cursor, audio selections, delays, retention,
  replay buffer).
- **Capture_Target**: The monitor being duplicated, identified by a `ddagrab`
  `output_idx`.
- **Encoder_Candidate**: One (encoder name, hardware/software) pair that ffmpeg
  reports as compiled in and that may or may not actually work on this machine.
- **Encoder_Capabilities**: The cached result of probing every Encoder_Candidate,
  including which ones passed, which failed, and the chosen default.
- **Encoder_Probe**: A short, timeout-bounded child process that attempts a
  one-second synthetic encode to prove one Encoder_Candidate actually initializes.
- **Capture_Argv**: The complete ffmpeg argument vector produced from
  Recording_Settings plus a Capture_Target.
- **Recording_Session**: One start-to-finish capture, represented by a row in the
  `recordings` table.
- **Session_File**: The Matroska file written during a Recording_Session.
- **Final_File**: The MP4 produced by remuxing a Session_File.
- **Recorder_Progress**: The periodic capture health sample parsed from ffmpeg's
  `-progress` stream — frame count, fps, output size, output time, dropped frames,
  duplicated frames, speed.
- **Live_Client_Data**: League's in-game HTTP API at `https://127.0.0.1:2999`,
  served with a self-signed certificate.
- **Game_Watcher**: The main-process component that polls Live_Client_Data and
  emits game lifecycle events.
- **LCU_Client**: The best-effort client for the League *client* (not in-game) API,
  authenticated from the lockfile or process command line.
- **Match_Id_Hint**: `platform + '_' + gameId`, composed from the LCU gameflow
  session, recorded against a Recording_Session.
- **Game_Start_Wall_Clock**: The estimated `Date.now()` value at which the in-game
  clock read zero, derived as the median of `Date.now() - gameTime * 1000` across
  many Live_Client_Data samples.
- **Sync_Offset**: `Game_Start_Wall_Clock - recording start wall clock`, in
  milliseconds — the existing `videos.sync_offset_ms` semantic.
- **Render_Readiness_Gate**: The condition that must hold before a Recording_Session
  is declared started: Live_Client_Data responding *and* the capture pipeline
  delivering consecutive frames at the target interval.
- **Source_Tag**: The new `videos.source` column, `'imported'` or `'recorded'`.
- **Preflight_Test**: A user-triggered short recording using the exact configured
  pipeline, reported back with measured fps, dropped frames, drift and size.
- **Retention_Sweep**: The deletion pass that enforces the user's total-size and
  age limits.
- **Retention_Preview**: The dry run of a Retention_Sweep, listing the exact files
  a sweep would delete without deleting anything.
- **Replay_Buffer**: The rolling window of recent footage that can be saved on
  demand while a Recording_Session continues.
- **Loopback_Bridge**: The hidden-window Chromium loopback audio path that supplies
  system audio to ffmpeg over a localhost socket.
- **Background_Mode**: The setting under which closing the main window hides it
  instead of quitting the application.
- **Recorder_Push_Channel**: An IPC channel on which the main process sends
  unsolicited recorder updates to renderers.

## Requirements

### Requirement 1: Correct recording timestamps from filenames

**User Story:** As someone with a folder of existing recordings, I want files
recorded in the small hours of the morning to import with their real capture time,
so that automatic match linking doesn't quietly attach them to the wrong game.

`parseFileNameDate.ts` pattern 1 requires two digits for the hour
(`(\d{2})-(\d{2})-(\d{2})`). Real Outplayed filenames use an unpadded hour, so
`Desktop 07-27-2026_0-25-37-967.mp4` and
`League of Legends 07-27-2026_1-02-21-702.mp4` match none of the three patterns and
fall back to filesystem `birthtimeMs || mtimeMs`. Every recording made between
midnight and 9am is affected.

#### Acceptance Criteria

1. WHEN a file name contains a month-day-year date followed by a time whose hour is
   a single digit, THE filename date parser SHALL return the timestamp encoded in
   that file name.
2. WHEN a file name contains a month-day-year date followed by a time whose hour is
   two digits, THE filename date parser SHALL return the same timestamp it returns
   today.
3. THE filename date parser SHALL return the timestamp encoded in
   `Desktop 07-27-2026_0-25-37-967.mp4` and in
   `League of Legends 07-27-2026_1-02-21-702.mp4`.
4. THE filename date parser SHALL continue to reject digit sequences that decode to
   an implausible recording date.
5. THE filename date parser SHALL be covered by automated tests including the two
   file names named in criterion 3.

### Requirement 2: Automated test harness

**User Story:** As the maintainer, I want the pure logic in this feature covered by
runnable tests, so that argument construction, state transitions and parsers can be
verified without launching a game.

#### Acceptance Criteria

1. THE project SHALL provide a single command that runs the whole test suite once
   and exits with a non-zero status on failure.
2. THE project SHALL provide a command that runs the test suite in watch mode.
3. THE test runner SHALL execute main-process modules in a Node environment.
4. THE test suite SHALL NOT require Electron, a display, a GPU, a running League
   client, or network access to pass.
5. THE existing `npm run typecheck` and `npm run build` commands SHALL continue to
   succeed with test files present in the repository.

### Requirement 3: Persisted recording settings

**User Story:** As a user, I want my recorder configuration to survive restarts, so
that I configure it once.

#### Acceptance Criteria

1. THE main process SHALL persist Recording_Settings as a JSON row in the existing
   `settings` table under a dedicated key, separate from the Riot account list.
2. WHEN no Recording_Settings row exists, THE main process SHALL return documented
   defaults.
3. WHEN a stored Recording_Settings row is missing fields present in the current
   defaults, THE main process SHALL merge the stored values over the defaults and
   return the result.
4. WHEN a stored Recording_Settings row cannot be parsed, THE main process SHALL
   return the defaults rather than failing.
5. THE renderer SHALL read and write Recording_Settings over IPC.
6. WHEN Recording_Settings are saved, THEN the application is restarted, THE
   renderer SHALL display the saved values.
7. THE Settings view SHALL present recording configuration as its own section.

### Requirement 4: Single ffmpeg binary resolution

**User Story:** As a user of a packaged build, I want clipping and recording to find
ffmpeg the same way, so that one working feature implies the other.

#### Acceptance Criteria

1. THE main process SHALL resolve the ffmpeg executable path through one shared
   function.
2. WHILE running unpackaged, THE resolver SHALL return the path inside
   `node_modules`.
3. WHILE running packaged, THE resolver SHALL return the path inside the unpacked
   asar directory.
4. THE existing clip service SHALL obtain its ffmpeg path from that shared
   resolver.
5. WHEN the resolved executable does not exist, THE resolver SHALL report an error
   naming the path it looked for.

### Requirement 5: Encoder capability detection

**User Story:** As a user, I want LeagueVid to pick the best encoder my machine
actually supports, so that recording a game doesn't cost me frames.

Hardware encoder initialization can hang. OBS ships separate
`obs-nvenc-test.exe` / `obs-qsv-test.exe` helpers precisely so a failed probe
cannot take the application down with it.

#### Acceptance Criteria

1. THE main process SHALL determine which encoders and filters the bundled ffmpeg
   was compiled with by parsing its own reported capabilities.
2. FOR EACH Encoder_Candidate, THE main process SHALL run an Encoder_Probe that
   attempts a short synthetic encode.
3. THE main process SHALL run every Encoder_Probe as a separate child process.
4. WHEN an Encoder_Probe exceeds its time limit, THE main process SHALL terminate
   that child and record the candidate as failed.
5. THE main process SHALL remain responsive while Encoder_Probes run, and SHALL NOT
   propagate a probe crash or hang into the application.
6. THE main process SHALL rank passing candidates NVENC before QSV before AMF
   before Media Foundation before libx264.
7. THE main process SHALL persist Encoder_Capabilities so that subsequent launches
   do not re-probe.
8. THE user SHALL be able to trigger a re-probe that replaces the persisted
   Encoder_Capabilities.
9. THE Settings view SHALL display the selected encoder with a human-readable name
   and whether it is hardware or software.
10. WHEN no hardware Encoder_Candidate passes, THE main process SHALL select
    libx264 and THE Settings view SHALL state that software encoding is in use.

### Requirement 6: Capture argument construction

**User Story:** As the maintainer, I want the ffmpeg command line built by a pure
function, so that every encoder and option combination can be tested without
spawning anything.

#### Acceptance Criteria

1. THE argument builder SHALL be a pure function of Recording_Settings and a
   Capture_Target, performing no process spawning and no filesystem access.
2. THE argument builder SHALL default to native-resolution capture, keeping frames
   on the GPU with no download or scale filter.
3. WHERE a resolution scale other than native is configured, THE argument builder
   SHALL emit a download, pixel-format and scale chain.
4. THE argument builder SHALL emit rate-control arguments matching the configured
   encoder and mode as follows:
   - NVENC quality: constant-quality VBR with the bitrate cap disabled.
   - NVENC bitrate: CBR with matched bitrate and maxrate and a double-size buffer.
   - QSV quality: global quality. QSV bitrate: bitrate with matched maxrate.
   - AMF quality: constant QP applied to I and P frames. AMF bitrate: CBR.
   - Media Foundation quality: quality-mode rate control. Bitrate: CBR.
   - libx264 quality: CRF with a fast preset. Bitrate: bitrate with maxrate and a
     double-size buffer.
5. THE argument builder SHALL emit an explicit keyframe interval, defaulting to one
   times the configured framerate.
6. THE argument builder SHALL disable mouse cursor drawing by default.
7. THE argument builder SHALL emit Matroska as the output format for a
   Recording_Session.
8. THE argument builder SHALL emit `-progress` on standard output so that
   Recorder_Progress can be parsed.
9. WHERE audio inputs are configured, THE argument builder SHALL emit wall-clock
   input timestamps for each capture device input, constant-framerate video output,
   and an asynchronous resampling filter on the audio path.
10. WHERE two audio inputs are configured, THE argument builder SHALL either mix
    them into one track or emit them as separate tracks, according to the setting.
11. WHERE the display is reported as HDR, THE argument builder SHALL emit a tone
    mapping chain.
12. THE argument builder SHALL be covered by tests spanning every supported
    encoder, both rate-control modes, native and scaled capture, and zero, one and
    two audio inputs.

### Requirement 7: Capture process lifecycle

**User Story:** As a user, I want a recording to stop cleanly, so that the file is
always playable and I can see whether capture is healthy while it runs.

Terminating ffmpeg with a signal corrupts the output. It must be asked to finish.

#### Acceptance Criteria

1. THE Recorder_Service SHALL spawn the capture child with a writable standard
   input.
2. THE Recorder_Service SHALL parse ffmpeg's progress stream into Recorder_Progress
   values.
3. THE progress parser SHALL correctly reassemble progress blocks that arrive split
   across stream chunk boundaries.
4. THE Recorder_Service SHALL emit at most one Recorder_Progress update per second.
5. THE Recorder_Service SHALL retain a bounded tail of the child's standard error
   for diagnostics.
6. WHEN a Recording_Session is asked to stop, THE Recorder_Service SHALL request a
   graceful finish by writing to the child's standard input.
7. IF the child has not exited within a bounded grace period after a graceful stop
   request, THEN THE Recorder_Service SHALL terminate it forcibly and record that
   it did so.
8. THE Recorder_Service SHALL NOT stop a capture child by sending a termination
   signal as the first action.
9. WHEN the capture child exits with a non-zero status, THE Recorder_Service SHALL
   record the retained standard error tail against the Recording_Session.

### Requirement 8: Display selection

**User Story:** As a user with more than one monitor, I want to choose which one is
recorded, so that I capture the game and not my browser.

#### Acceptance Criteria

1. THE main process SHALL enumerate the connected displays with a label,
   resolution, scale factor and primary flag.
2. THE main process SHALL map each enumerated display to the `ddagrab` output index
   used to capture it.
3. THE Settings view SHALL let the user choose the Capture_Target from that list.
4. WHEN the configured Capture_Target is no longer present, THE Recorder_Service
   SHALL fall back to the primary display and report that it did so.
5. THE Settings view SHALL note that on a multi-GPU machine an output index can map
   to a different adapter than expected, which is why the choice is exposed.

### Requirement 9: Audio device selection

**User Story:** As a user, I want to choose my microphone, and to be told plainly
what LeagueVid can and cannot capture, so that I don't discover silent audio after
a good game.

#### Acceptance Criteria

1. THE main process SHALL enumerate the available capture devices reported by
   ffmpeg's DirectShow device listing.
2. THE device listing parser SHALL handle quoted device names and alternative-name
   lines.
3. THE main process SHALL flag devices whose names indicate a loopback or virtual
   capture device.
4. THE Settings view SHALL let the user select a microphone device, a desktop audio
   device, or neither.
5. WHILE no viable desktop audio source is available, THE Settings view SHALL state
   that system audio cannot be captured, rather than offering an option that
   records silence.
6. WHEN a configured audio device is missing at start time, THE Recorder_Service
   SHALL start without that input and report the omission rather than failing the
   Recording_Session.

### Requirement 10: Durable output and remux

**User Story:** As a user, I want footage to survive a crash, a power loss or a
forced quit, so that a lost game is never also a lost recording.

#### Acceptance Criteria

1. THE Recorder_Service SHALL write the Session_File in the Matroska container.
2. WHEN a Recording_Session's capture child exits successfully, THE Recorder_Service
   SHALL remux the Session_File to an MP4 Final_File by copying streams without
   re-encoding.
3. THE Recorder_Service SHALL verify that the Final_File exists and reports a
   plausible duration before treating the remux as successful.
4. WHEN a remux succeeds, THE Recorder_Service SHALL delete the Session_File.
5. IF a remux fails, THEN THE Recorder_Service SHALL retain the Session_File,
   record the failure, and import the Matroska file rather than discarding footage.
6. THE Recorder_Service SHALL name output files so that the game start time is
   identifiable from the file name.

### Requirement 11: Recording records and orphan recovery

**User Story:** As a user who force-quit the app mid-game, I want the partial
recording repaired on the next launch, so that I still have the footage.

#### Acceptance Criteria

1. THE database SHALL provide a `recordings` table holding, per Recording_Session:
   temporary and final paths, state, start and end times, the derived game start,
   the Match_Id_Hint, platform, puuid, queue and champion hints, the captured live
   event feed, link state and attempt count, the settings used, and capture health
   figures.
2. THE database migration SHALL create the `recordings` table only when it does not
   already exist, and SHALL add the `source` column to the existing `videos` table
   through the additive column mechanism.
3. WHEN a Recording_Session's row is written, THE main process SHALL record the
   Recording_Settings actually used for it.
4. WHEN LeagueVid starts, THE main process SHALL find `recordings` rows left in an
   in-progress state.
5. FOR EACH such row whose Session_File still exists, THE main process SHALL remux
   it and import the result.
6. FOR EACH such row whose Session_File no longer exists, THE main process SHALL
   mark the row failed and take no further action.
7. WHEN a recovered file is imported, THE main process SHALL mark the resulting
   video row with the `recorded` Source_Tag.

### Requirement 12: Recorder state, IPC, and status indicator

**User Story:** As a user, I want to see at a glance whether LeagueVid is recording,
so that I never have to guess.

#### Acceptance Criteria

1. THE Recorder_State transitions SHALL be computed by a pure reducer with no I/O.
2. THE reducer SHALL leave Recorder_State unchanged when given an event that is not
   legal in the current state.
3. THE Recorder_Service SHALL be the only component that writes Recorder_State.
4. THE main process SHALL expose recorder operations as `invoke`-style IPC handlers
   under a dedicated namespace, following the existing channel naming convention.
5. THE main process SHALL push Recorder_State changes, Recorder_Progress samples,
   completed recordings and errors to every open renderer window.
6. FOR EACH Recorder_Push_Channel, THE main process SHALL also expose a pull
   handler returning the same information, so that a renderer mounting mid-session
   can obtain current state without waiting for the next push.
7. THE preload bridge SHALL expose each push subscription as a function that
   returns an unsubscribe function.
8. THE application header SHALL display a recorder indicator reflecting the current
   Recorder_State.
9. THE user SHALL be able to start and stop a recording manually.
10. WHEN a manual recording completes, THE resulting file SHALL appear in the
    library with the `recorded` Source_Tag.

### Requirement 13: Game detection

**User Story:** As a user, I want recording to start because a game started, not
because I remembered to press a button.

A single failed poll is not a finished game. Alt-tabbing, a frame hitch or a busy
disk can all drop one request, and treating that as game-over would cut a recording
in half.

#### Acceptance Criteria

1. THE Game_Watcher SHALL poll Live_Client_Data over HTTPS, accepting its
   self-signed certificate.
2. THE Game_Watcher SHALL apply a request timeout shorter than its polling
   interval.
3. THE Game_Watcher SHALL poll less frequently while a Recording_Session is in
   progress than while idle.
4. WHEN Live_Client_Data responds successfully and no game was previously known,
   THE Game_Watcher SHALL emit a game-detected event.
5. THE Game_Watcher SHALL NOT emit a game-ended event until at least three
   consecutive polls have failed.
6. THE Game_Watcher SHALL extract the in-game clock, game mode, map number, the
   active player's champion, and the in-game event feed from each successful poll.
7. THE Game_Watcher SHALL derive Game_Start_Wall_Clock as the median of the
   per-sample estimates rather than from any single sample.
8. THE Game_Watcher SHALL distinguish a game that ended normally from a game whose
   data stopped being available unexpectedly.
9. THE Game_Watcher's median derivation, failure debouncing and payload extraction
   SHALL be covered by tests using recorded fixtures.

### Requirement 14: Match id hint from the League client

**User Story:** As a user, I want the recording to know exactly which match it is,
so that linking is exact instead of a search.

#### Acceptance Criteria

1. THE LCU_Client SHALL discover its credentials from the League client lockfile.
2. WHERE the lockfile is not found, THE LCU_Client SHALL attempt the documented
   install-path and registry locations, and finally the running process's command
   line arguments.
3. THE LCU_Client SHALL authenticate using the discovered port and password.
4. THE LCU_Client SHALL read the current gameflow phase and the gameflow session.
5. WHEN a gameflow session reports a game id, THE main process SHALL compose the
   Match_Id_Hint as the platform routing value, an underscore, and the game id.
6. THE LCU_Client SHALL be entirely optional: every failure SHALL degrade to
   Live_Client_Data only, and SHALL NOT prevent or stop a Recording_Session.
7. THE lockfile parsing, command-line credential extraction and Match_Id_Hint
   composition SHALL be covered by tests.

### Requirement 15: Automatic start and stop

**User Story:** As a user, I want to play a game and find a complete recording
afterwards, having done nothing at all.

A fixed delay after process launch is the wrong trigger — the game may still be on a
loading screen. Readiness has to be observed, not assumed.

#### Acceptance Criteria

1. WHILE recording is enabled and a game is detected, THE Recorder_Service SHALL
   prepare a Recording_Session.
2. THE Recorder_Service SHALL NOT declare a Recording_Session started until the
   Render_Readiness_Gate is satisfied: Live_Client_Data is responding, and the
   capture pipeline has delivered a configured number of consecutive frames at the
   target interval.
3. THE Recorder_Service SHALL treat any configured fixed start delay as an optional
   manual override, not as the primary start trigger.
4. BEFORE starting a Recording_Session, THE Recorder_Service SHALL verify
   sufficient free disk space and SHALL refuse to start with a clear reason when
   there is not enough.
5. WHEN a game ends, THE Recorder_Service SHALL continue recording for a
   configured additional period before stopping, so that the post-game screen is
   captured.
6. WHEN a completed Recording_Session is shorter than a configured minimum
   duration, THE Recorder_Service SHALL discard it and its file.
7. THE Recorder_Service SHALL persist the Match_Id_Hint, platform, puuid, queue and
   champion hints and Game_Start_Wall_Clock onto the Recording_Session row.
8. WHEN the capture child dies unexpectedly during a Recording_Session, THE
   Recorder_Service SHALL move to a failed state, retain whatever footage exists,
   and return to idle without requiring a restart.
9. THE automatic start and stop behavior SHALL be covered by tests driving the
   reducer with scripted watcher event sequences, including a game that disappears
   mid-recording.

### Requirement 16: Exact linking of recorded footage

**User Story:** As a user, I want a finished recording to already be linked to its
match with correctly placed bookmarks, without LeagueVid guessing.

Riot's match-v5 endpoint lags the end of a game by seconds to minutes, so the first
attempt will often legitimately fail.

#### Acceptance Criteria

1. WHEN a Recording_Session has a Match_Id_Hint, THE linking path SHALL fetch that
   match directly and SHALL NOT run the filename-based match search.
2. THE linking path SHALL compute Sync_Offset from the recorded
   Game_Start_Wall_Clock and the recording start time, not from any filename
   timestamp or best-fit heuristic.
3. WHEN a direct fetch fails because the match is not yet available, THE linking
   path SHALL retry on an increasing backoff schedule.
4. WHEN every hinted attempt has failed, THE linking path SHALL fall back to the
   existing search-based linking path.
5. THE main process SHALL maintain a queue of Recording_Sessions awaiting linking,
   with an attempt count per session.
6. WHEN the library view mounts, THE renderer SHALL drain the pending-link queue so
   that recordings made while the window was closed are linked.
7. THE Sync_Offset computation, backoff schedule and fallback behavior SHALL be
   covered by tests.

### Requirement 17: Live event bookmarks as a fallback

**User Story:** As a user recording a custom game or a game the API never returns,
I still want bookmarks on the action.

#### Acceptance Criteria

1. THE Recorder_Service SHALL persist the in-game event feed collected during a
   Recording_Session onto its row.
2. WHEN a Recording_Session links successfully to a Riot match, THE main process
   SHALL derive bookmarks from the Riot timeline and SHALL NOT also write live-event
   bookmarks.
3. WHEN a Recording_Session's linking has permanently failed, THE main process
   SHALL derive bookmarks from the persisted live event feed.
4. WHEN deriving bookmarks from live events, THE main process SHALL convert each
   event's in-game time to video time using the Sync_Offset.
5. THE live-event bookmarks SHALL be written with the automatic bookmark source so
   that existing bookmark handling applies unchanged.
6. THE per-event-type mapping and the precedence between Riot and live-event
   bookmarks SHALL be covered by tests.

### Requirement 18: Background application lifecycle

**User Story:** As a user, I want to close the LeagueVid window and still have my
games recorded, and I want a recording in progress to survive my quitting the app.

#### Acceptance Criteria

1. THE application SHALL hold a single-instance lock, and a second launch SHALL
   focus the existing window instead of starting a second recorder.
2. THE application SHALL provide a tray icon whose tooltip reflects the current
   Recorder_State.
3. THE tray menu SHALL offer opening the window, toggling whether recording is
   enabled, starting or stopping a recording now, saving the Replay_Buffer, and
   quitting.
4. WHILE Background_Mode is enabled, closing the main window SHALL hide it rather
   than destroy it, and SHALL NOT quit the application.
5. THE application SHALL NOT quit when its last window closes.
6. WHEN a quit is requested WHILE a Recording_Session is in progress, THE
   application SHALL defer quitting, stop the session, remux it, and then quit.
7. THE deferred-quit path SHALL be bounded in time so that a stuck child cannot
   prevent the application from quitting.
8. WHILE a Recording_Session is in progress, THE application SHALL prevent the
   system from sleeping.
9. WHERE launch at login is enabled, THE application SHALL start hidden and SHALL
   NOT show its window until asked.
10. WHEN the operating system reports session end, THE application SHALL make a
    best-effort graceful stop of any Recording_Session.
11. THE ordering of stop, remux, finalize and quit SHALL be covered by a test using
    a stand-in capture child.

### Requirement 19: System audio without a virtual audio driver

**User Story:** As a user, I want game audio in my recordings without installing a
virtual audio cable.

The bundled ffmpeg has no WASAPI loopback input. This is the constraint that makes
this requirement non-trivial, and it is why the Loopback_Bridge exists.

#### Acceptance Criteria

1. THE Loopback_Bridge SHALL obtain system audio through Chromium's loopback
   display-media path in a window the user does not see.
2. THE Loopback_Bridge SHALL deliver interleaved 32-bit float stereo samples to
   ffmpeg over a localhost socket.
3. THE argument builder SHALL accept the Loopback_Bridge as a raw audio input with
   an explicit sample format, rate and channel count.
4. WHERE both the Loopback_Bridge and a microphone are configured, THE argument
   builder SHALL mix them with drift correction on each input.
5. WHEN the Loopback_Bridge fails to start, THE Recorder_Service SHALL continue the
   Recording_Session without system audio and report the degradation.
6. WHILE the Loopback_Bridge is unavailable, THE Settings view SHALL state that
   system audio is not being captured.
7. THE Loopback_Bridge's sample framing, socket lifecycle and mixing argument
   generation SHALL be covered by tests.

### Requirement 20: Quality presets and preflight testing

**User Story:** As a user, I want to know whether my chosen quality is actually
sustainable on my machine before I trust it with a real game.

#### Acceptance Criteria

1. THE Settings view SHALL offer low, medium, high and custom quality presets.
2. WHEN a preset is chosen, THE Settings view SHALL apply that preset's resolution
   scale, framerate and rate-control values to Recording_Settings.
3. THE Settings view SHALL display an estimated storage cost per hour for the
   current configuration.
4. THE user SHALL be able to run a Preflight_Test that records for a short fixed
   period using the exact configured pipeline.
5. THE Preflight_Test SHALL report measured average framerate, dropped frame count,
   audio/video drift and resulting file size.
6. WHEN a Preflight_Test measures sustained frame drops or a processing speed below
   real time, THE Settings view SHALL recommend a specific lower setting.
7. WHILE a real Recording_Session is running, THE application SHALL raise a warning
   when dropped frames exceed a threshold proportion of total frames or processing
   speed falls below real time.
8. THE storage estimate arithmetic and the capture-health thresholds SHALL be
   covered by tests.

### Requirement 21: Disk management and retention

**User Story:** As a user, I want LeagueVid to avoid filling my drive, and I want to
be certain it will never delete footage I care about.

Automatic deletion of recordings is the only genuinely destructive behavior in this
feature. It is opt-in, scoped, and previewable.

#### Acceptance Criteria

1. BEFORE starting a Recording_Session, THE Recorder_Service SHALL require free
   space of at least the greater of a fixed floor and the estimated size of an
   hour's recording with headroom for the remux copy.
2. WHILE a Recording_Session is in progress, THE Recorder_Service SHALL re-check
   free space periodically.
3. WHEN free space falls below the safety threshold during a Recording_Session, THE
   Recorder_Service SHALL stop the session gracefully and report why.
4. THE Settings view SHALL display how much disk space recordings currently use.
5. THE user SHALL be able to configure retention by total size and by age.
6. THE Retention_Sweep SHALL be disabled unless the user explicitly enables it.
7. THE Retention_Sweep SHALL only consider videos carrying the `recorded`
   Source_Tag.
8. THE Retention_Sweep SHALL never delete a video marked as a favorite.
9. THE Retention_Sweep SHALL never delete a video carrying the `imported`
   Source_Tag or no Source_Tag.
10. THE Retention_Sweep SHALL delete oldest-first.
11. THE user SHALL be able to obtain a Retention_Preview listing the exact files a
    sweep would delete.
12. THE set of files reported by a Retention_Preview SHALL equal the set a sweep run
    immediately afterwards deletes.
13. THE retention ordering, the favorite and imported exclusions, and the
    equivalence of preview and deletion SHALL be covered by tests.

### Requirement 22: Replay buffer

**User Story:** As a user, I want to press a key after something great happens and
get just that moment as its own file.

#### Acceptance Criteria

1. WHILE the Replay_Buffer is enabled, THE Recorder_Service SHALL produce both the
   Session_File and a rolling set of recent segments from a single encode.
2. THE Recorder_Service SHALL bound the rolling segment set to the configured
   buffer duration.
3. THE user SHALL be able to save the Replay_Buffer with a configurable global
   hotkey.
4. WHEN the Replay_Buffer is saved, THE Recorder_Service SHALL concatenate the
   relevant segments into a separate file without re-encoding.
5. THE Recorder_Service SHALL continue the Recording_Session uninterrupted while
   saving the Replay_Buffer.
6. THE segment selection SHALL be correct across a wrap of the rolling set.
7. THE segment selection and concatenation list generation SHALL be covered by
   tests.

### Requirement 23: Packaging and documentation

**User Story:** As a user installing a built copy of LeagueVid, I want recording to
work, and I want the documentation to describe what the app now does.

#### Acceptance Criteria

1. THE build configuration SHALL place the ffmpeg executable outside the asar
   archive.
2. THE ffmpeg path resolver SHALL be verified against a real packaged build for
   both clipping and recording.
3. THE README SHALL no longer state that LeagueVid does not record anything itself.
4. THE README SHALL describe the recording feature and its requirements.

### Requirement 24: Anti-cheat and process safety

**User Story:** As a player on an account with kernel-level anti-cheat, I want to be
sure LeagueVid cannot get me banned or crash my game.

#### Acceptance Criteria

1. THE application SHALL NOT inject any code into the League of Legends process.
2. THE application SHALL NOT read or write the memory of the League of Legends
   process.
3. THE application SHALL capture video only through display duplication of a
   monitor's output.
4. THE application SHALL interact with League only over its local HTTP endpoints.
5. THE application SHALL NOT modify any game file or configuration.
