import { describe, expect, it } from 'vitest'
import { looksLikeLoopback, parseAudioDevices } from './audioDevices'

/**
 * Verbatim output from the development machine, including the video
 * enumeration failure and the trailing error -- this command always exits
 * non-zero because listing devices is a side effect of failing to open an
 * input called 'dummy'.
 */
const REAL_OUTPUT = `[dshow @ 000001eeef06b240] Could not enumerate video devices (or none found).
[dshow @ 000001eeef06b240] "Headset Microphone (2- DualSense Wireless Controller)" (audio)
[dshow @ 000001eeef06b240]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{60AA2801-2F0F-4E19-A6BE-A917482ACE69}"
[dshow @ 000001eeef06b240] "Microphone (HyperX QuadCast)" (audio)
[dshow @ 000001eeef06b240]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{6252AACF-61A9-431D-BB1C-D231A50DBEA0}"
[dshow @ 000001eeef06b240] "Microphone (Steam Streaming Microphone)" (audio)
[dshow @ 000001eeef06b240]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{FB635046-660D-4886-A476-0B9FEEBF3C66}"
[in#0 @ 000001eeef06b080] Error opening input: Immediate exit requested
Error opening input file dummy.
`

/** The older section-header shape, still worth handling. */
const LEGACY_OUTPUT = `[dshow @ 0000021d] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0000021d]  "Integrated Camera"
[dshow @ 0000021d]     Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"
[dshow @ 0000021d] DirectShow audio devices
[dshow @ 0000021d]  "Microphone (Realtek(R) Audio)"
[dshow @ 0000021d]     Alternative name "@device_cm_{33D9A762}\\wave_{AAAA}"
[dshow @ 0000021d]  "Stereo Mix (Realtek(R) Audio)"
[dshow @ 0000021d]     Alternative name "@device_cm_{33D9A762}\\wave_{BBBB}"
`

describe('parseAudioDevices', () => {
  it('finds every audio device in real ffmpeg output', () => {
    const devices = parseAudioDevices(REAL_OUTPUT)
    expect(devices.map((d) => d.name)).toEqual([
      'Headset Microphone (2- DualSense Wireless Controller)',
      'Microphone (HyperX QuadCast)',
      'Microphone (Steam Streaming Microphone)'
    ])
  })

  // Names contain parentheses, digits and hyphens. A parser that split on
  // punctuation would mangle every one of these.
  it('keeps the full quoted name, parentheses and all', () => {
    const devices = parseAudioDevices(REAL_OUTPUT)
    expect(devices[0].name).toContain('(2- DualSense Wireless Controller)')
  })

  it('attaches the alternative name to the right device', () => {
    const devices = parseAudioDevices(REAL_OUTPUT)
    expect(devices[1].alternativeName).toContain('wave_{6252AACF-61A9-431D-BB1C-D231A50DBEA0}')
    expect(devices[2].alternativeName).toContain('wave_{FB635046-660D-4886-A476-0B9FEEBF3C66}')
  })

  it('ignores the enumeration failure and the trailing open error', () => {
    const devices = parseAudioDevices(REAL_OUTPUT)
    expect(devices.every((d) => !d.name.includes('Error'))).toBe(true)
    expect(devices).toHaveLength(3)
  })

  it('reads the older section-header format', () => {
    const devices = parseAudioDevices(LEGACY_OUTPUT)
    expect(devices.map((d) => d.name)).toEqual([
      'Microphone (Realtek(R) Audio)',
      'Stereo Mix (Realtek(R) Audio)'
    ])
  })

  it('does not report video devices as audio inputs', () => {
    const devices = parseAudioDevices(LEGACY_OUTPUT)
    expect(devices.some((d) => d.name === 'Integrated Camera')).toBe(false)
  })

  it('returns nothing for empty or unrelated output', () => {
    expect(parseAudioDevices('')).toEqual([])
    expect(parseAudioDevices('ffmpeg: command not found')).toEqual([])
  })

  // The finding that shapes the whole audio design: this machine has three
  // microphones and no loopback device of any kind, so desktop audio is not
  // available through dshow at all and has to come from the Chromium bridge.
  it('finds no loopback device on a machine that has none', () => {
    const devices = parseAudioDevices(REAL_OUTPUT)
    expect(devices.filter((d) => d.likelyLoopback)).toEqual([])
  })

  it('flags a Stereo Mix device when one exists', () => {
    const devices = parseAudioDevices(LEGACY_OUTPUT)
    const stereoMix = devices.find((d) => d.name.startsWith('Stereo Mix'))
    expect(stereoMix?.likelyLoopback).toBe(true)
  })
})

describe('looksLikeLoopback', () => {
  it('recognises the common desktop-audio sources', () => {
    expect(looksLikeLoopback('Stereo Mix (Realtek(R) Audio)')).toBe(true)
    expect(looksLikeLoopback('What U Hear (Sound Blaster)')).toBe(true)
    expect(looksLikeLoopback('CABLE Output (VB-Audio Virtual Cable)')).toBe(true)
    expect(looksLikeLoopback('VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)')).toBe(true)
    expect(looksLikeLoopback('virtual-audio-capturer')).toBe(true)
    expect(looksLikeLoopback('Loopback Audio')).toBe(true)
  })

  it('does not flag ordinary microphones', () => {
    expect(looksLikeLoopback('Microphone (HyperX QuadCast)')).toBe(false)
    expect(looksLikeLoopback('Headset Microphone (2- DualSense Wireless Controller)')).toBe(false)
  })

  // Virtual, but not desktop audio. Flagging it would send someone down a
  // dead end looking for game sound that will never arrive.
  it('does not flag a virtual device that is not desktop audio', () => {
    expect(looksLikeLoopback('Microphone (Steam Streaming Microphone)')).toBe(false)
    expect(looksLikeLoopback('NVIDIA Broadcast Microphone')).toBe(false)
  })
})
