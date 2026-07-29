import { describe, expect, it } from 'vitest'
import {
  MAX_BUFFERED_BYTES,
  bytesPerSecond,
  createBufferState,
  drain,
  floatsToLe,
  interleave,
  pushBounded
} from './pcmFraming'

describe('interleave', () => {
  // Web Audio hands out one array per channel; ffmpeg's f32le wants L,R,L,R.
  // Getting this wrong produces no error at all -- just audio of the right
  // length with the channels smeared together, which survives a casual listen.
  it('interleaves two channels', () => {
    const left = new Float32Array([1, 2, 3])
    const right = new Float32Array([-1, -2, -3])
    expect(Array.from(interleave([left, right]))).toEqual([1, -1, 2, -2, 3, -3])
  })

  // The ffmpeg input is declared stereo, and a mismatch between the declared
  // channel count and the byte stream desynchronises everything after it.
  it('duplicates a mono source into both channels', () => {
    const mono = new Float32Array([0.5, 0.25])
    expect(Array.from(interleave([mono]))).toEqual([0.5, 0.5, 0.25, 0.25])
  })

  it('takes only as many channels as declared', () => {
    const a = new Float32Array([1, 2])
    const b = new Float32Array([3, 4])
    const c = new Float32Array([5, 6])
    expect(Array.from(interleave([a, b, c], 2))).toEqual([1, 3, 2, 4])
  })

  it('handles no channels at all', () => {
    expect(interleave([]).length).toBe(0)
  })

  it('handles an empty render quantum', () => {
    expect(interleave([new Float32Array(0), new Float32Array(0)]).length).toBe(0)
  })
})

describe('floatsToLe', () => {
  // Explicitly little-endian because the input format says f32le. Relying on
  // the platform's order works on x86 and silently corrupts audio elsewhere.
  it('writes little-endian floats', () => {
    const bytes = floatsToLe(new Float32Array([1, -1]))
    expect(bytes.length).toBe(8)
    expect(bytes.readFloatLE(0)).toBe(1)
    expect(bytes.readFloatLE(4)).toBe(-1)
  })

  // Web Audio can exceed [-1, 1] after mixing, and f32le has no defined
  // behaviour there -- some decoders wrap, which turns a loud moment into noise.
  it('clamps samples to the valid range', () => {
    const bytes = floatsToLe(new Float32Array([1.8, -2.5]))
    expect(bytes.readFloatLE(0)).toBe(1)
    expect(bytes.readFloatLE(4)).toBe(-1)
  })

  it('turns non-finite samples into silence rather than garbage', () => {
    const bytes = floatsToLe(new Float32Array([NaN, Infinity, -Infinity]))
    expect(bytes.readFloatLE(0)).toBe(0)
    expect(bytes.readFloatLE(4)).toBe(1)
    expect(bytes.readFloatLE(8)).toBe(-1)
  })

  it('produces four bytes per sample', () => {
    expect(floatsToLe(new Float32Array(128)).length).toBe(512)
  })
})

describe('bytesPerSecond', () => {
  it('is 48kHz stereo float', () => {
    expect(bytesPerSecond()).toBe(48000 * 2 * 4)
  })
})

describe('the bounded buffer', () => {
  // ffmpeg connects a moment after the bridge starts and could stall later. An
  // unbounded queue would grow at 384 KB/s until the process died.
  it('holds audio until something reads it', () => {
    const state = createBufferState()
    pushBounded(state, Buffer.alloc(100))
    pushBounded(state, Buffer.alloc(200))

    expect(state.bytes).toBe(300)
    expect(state.dropped).toBe(0)
  })

  it('drops the oldest audio once the cap is passed', () => {
    const state = createBufferState()
    pushBounded(state, Buffer.alloc(100), 250)
    pushBounded(state, Buffer.alloc(100), 250)
    pushBounded(state, Buffer.alloc(100), 250)

    expect(state.bytes).toBeLessThanOrEqual(250)
    expect(state.dropped).toBe(100)
  })

  it('keeps the newest audio, not the oldest', () => {
    const state = createBufferState()
    pushBounded(state, Buffer.from([1]), 2)
    pushBounded(state, Buffer.from([2]), 2)
    pushBounded(state, Buffer.from([3]), 2)

    expect(Array.from(drain(state))).toEqual([2, 3])
  })

  it('empties on drain', () => {
    const state = createBufferState()
    pushBounded(state, Buffer.alloc(64))
    drain(state)

    expect(state.bytes).toBe(0)
    expect(state.chunks).toEqual([])
  })

  it('drains everything as one chunk in order', () => {
    const state = createBufferState()
    pushBounded(state, Buffer.from([1, 2]))
    pushBounded(state, Buffer.from([3, 4]))

    expect(Array.from(drain(state))).toEqual([1, 2, 3, 4])
  })

  it('caps at a few seconds of audio, not an arbitrary byte count', () => {
    expect(MAX_BUFFERED_BYTES).toBe(bytesPerSecond() * 3)
  })
})
