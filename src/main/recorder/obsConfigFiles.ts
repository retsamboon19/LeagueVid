import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { RecordingSettings } from '../../shared/types'
import type { AudioInputSpec, CaptureTarget } from './ffmpegArgs'
import type { CaptureScope } from './captureBackend'
import {
  buildProfileIni,
  buildRecordEncoderJson,
  buildSceneCollection,
  buildUserIni,
  buildWebSocketConfig
} from './obsConfig'

// Puts the generated OBS configuration on disk.
//
// Split from obsConfig.ts so that module can stay free of the filesystem and be
// asserted directly in tests. This half is the boring part: which file goes
// where, and creating the directories OBS expects to already exist.
//
// Everything written here is inside a distribution LeagueVid owns, so nothing
// can reach the user's own OBS configuration. See obsBinary.ts for why that
// constraint rules out reusing an OBS the user installed themselves.

export interface WriteObsConfigInput {
  /** Distribution root -- the folder containing bin/, data/, obs-plugins/. */
  obsRoot: string
  /** Portable config tree, i.e. <obsRoot>/config/obs-studio. */
  configRoot: string
  settings: RecordingSettings
  target: CaptureTarget
  audioInputs: AudioInputSpec[]
  /** Directory OBS writes the session file into. */
  recordingDirectory: string
  /** Exact basename, without extension. */
  fileBasename: string
  scope: CaptureScope
  fallbackEncoder?: string
  webSocketPort: number
  webSocketPassword: string
  /** Injected for deterministic output in tests. */
  uuid?: () => string
}

export interface WrittenObsConfig {
  profileDir: string
  sceneCollectionPath: string
  webSocketConfigPath: string
  userIniPath: string
  portableMarkerPath: string
}

/**
 * Number of audio tracks the recording needs.
 *
 * Separate tracks are only worth the second encoder pass when there is actually
 * more than one source; a single input in 'separate' mode is still one track.
 */
export function audioTrackCount(
  audioInputs: AudioInputSpec[],
  mode: RecordingSettings['audioTrackMode']
): number {
  if (audioInputs.length <= 1) return Math.max(1, audioInputs.length)
  return mode === 'separate' ? audioInputs.length : 1
}

export function writeObsConfig(input: WriteObsConfigInput): WrittenObsConfig {
  const profileDir = join(input.configRoot, 'basic', 'profiles', 'LeagueVid')
  const sceneCollectionPath = join(input.configRoot, 'basic', 'scenes', 'LeagueVid.json')
  const webSocketConfigPath = join(
    input.configRoot,
    'plugin_config',
    'obs-websocket',
    'config.json'
  )
  const userIniPath = join(input.configRoot, 'user.ini')
  const portableMarkerPath = join(input.obsRoot, 'bin', '64bit', 'obs_portable_mode.txt')

  for (const dir of [
    profileDir,
    dirname(sceneCollectionPath),
    dirname(webSocketConfigPath),
    input.recordingDirectory
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(
    join(profileDir, 'basic.ini'),
    buildProfileIni({
      settings: input.settings,
      target: input.target,
      recordingDirectory: input.recordingDirectory,
      fileBasename: input.fileBasename,
      fallbackEncoder: input.fallbackEncoder,
      audioTrackCount: audioTrackCount(input.audioInputs, input.settings.audioTrackMode)
    }),
    'utf-8'
  )

  writeFileSync(
    join(profileDir, 'recordEncoder.json'),
    JSON.stringify(buildRecordEncoderJson(input.settings, input.fallbackEncoder), null, 2),
    'utf-8'
  )

  writeFileSync(
    sceneCollectionPath,
    JSON.stringify(
      buildSceneCollection({
        target: input.target,
        audioInputs: input.audioInputs,
        audioTrackMode: input.settings.audioTrackMode,
        drawMouse: input.settings.drawMouse,
        scope: input.scope,
        uuid: input.uuid
      }),
      null,
      2
    ),
    'utf-8'
  )

  writeFileSync(userIniPath, buildUserIni(), 'utf-8')

  writeFileSync(
    webSocketConfigPath,
    JSON.stringify(buildWebSocketConfig(input.webSocketPort, input.webSocketPassword), null, 2),
    'utf-8'
  )

  // Belt and braces alongside the --portable flag. Without portable mode OBS
  // would read and write the user's own configuration in %APPDATA%/obs-studio.
  writeFileSync(portableMarkerPath, '', 'utf-8')

  return {
    profileDir,
    sceneCollectionPath,
    webSocketConfigPath,
    userIniPath,
    portableMarkerPath
  }
}
