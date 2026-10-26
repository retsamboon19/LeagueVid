import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS } from '../../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '' }, screen: {} }))
vi.mock('../db/repository', () => ({ getRecordingSettings: vi.fn() }))
vi.mock('./backendSelection', () => ({ activeCaptureBackend: vi.fn() }))
vi.mock('./loopbackAudio', () => ({ startLoopbackBridge: vi.fn(), stopLoopbackBridge: vi.fn() }))
vi.mock('./recorderService', () => ({ reportRecorderProblem: vi.fn() }))

const { getRecordingSettings } = await import('../db/repository')
const { activeCaptureBackend } = await import('./backendSelection')
const { startLoopbackBridge } = await import('./loopbackAudio')
const { reportRecorderProblem } = await import('./recorderService')
const { resolveAudioInputs } = await import('./autoRecorderHost')

describe('recording audio routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRecordingSettings).mockReturnValue({
      ...DEFAULT_RECORDING_SETTINGS, captureMicrophone: true, micDeviceName: 'Microphone',
      systemAudioDeviceId: '{0.0.0.00000000}.{speakers}'
    })
    vi.mocked(activeCaptureBackend).mockResolvedValue({ capturesDesktopAudioNatively: true } as never)
  })

  it('records the microphone and selected playback endpoint together', async () => {
    expect(await resolveAudioInputs()).toEqual([
      { kind: 'dshow', source: 'Microphone', role: 'mic', volume: 100 },
      { kind: 'wasapi-output', source: '{0.0.0.00000000}.{speakers}', role: 'desktop', volume: 100 }
    ])
    expect(startLoopbackBridge).not.toHaveBeenCalled()
  })

  it('honours system sound being switched off', async () => {
    vi.mocked(getRecordingSettings).mockReturnValue({ ...getRecordingSettings(), captureSystemAudio: false })
    expect((await resolveAudioInputs()).map(input => input.role)).toEqual(['mic'])
  })

  it('follows Windows default when no explicit endpoint is saved', async () => {
    vi.mocked(getRecordingSettings).mockReturnValue({ ...getRecordingSettings(), systemAudioDeviceId: null })
    expect(await resolveAudioInputs()).toContainEqual({ kind: 'wasapi-output', source: 'default', role: 'desktop', volume: 100 })
  })

  it('retains an explicitly chosen virtual cable for existing users', async () => {
    vi.mocked(getRecordingSettings).mockReturnValue({ ...getRecordingSettings(), systemAudioDeviceId: null, desktopAudioDeviceName: 'Stereo Mix' })
    expect(await resolveAudioInputs()).toContainEqual({ kind: 'dshow', source: 'Stereo Mix', role: 'desktop', volume: 100 })
  })

  it('warns when the fallback engine cannot use a selected endpoint', async () => {
    vi.mocked(activeCaptureBackend).mockResolvedValue({ capturesDesktopAudioNatively: false } as never)
    vi.mocked(startLoopbackBridge).mockResolvedValue({ url: 'tcp://127.0.0.1:1234', stop: vi.fn() })
    expect(await resolveAudioInputs()).toContainEqual({ kind: 'loopback-socket', source: 'tcp://127.0.0.1:1234', role: 'desktop', volume: 100 })
    expect(reportRecorderProblem).toHaveBeenCalledWith(expect.stringContaining('Windows default'))
  })
})
