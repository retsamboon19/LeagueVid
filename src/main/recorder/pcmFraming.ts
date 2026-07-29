// Turns Web Audio's planar float buffers into the interleaved byte stream
// ffmpeg reads as `-f f32le -ar 48000 -ac 2`.
//
// Web Audio hands out one Float32Array per channel (planar). ffmpeg's f32le
// expects samples interleaved (L,R,L,R...). Getting this wrong does not produce
// an error: it produces audio that plays at the right length with the channels
// smeared into each other, which is the kind of bug that survives a casual
// listen and ruins a recording.
//
// Pure and separate from the socket so the conversion can be verified against
// known sample values.

export const LOOPBACK_SAMPLE_RATE = 48000
export const LOOPBACK_CHANNELS = 2

/**
 * Interleaves planar channel data.
 *
 * A mono source is duplicated to both channels rather than emitted as one:
 * the ffmpeg input is declared as stereo, and a mismatch between the declared
 * channel count and the byte stream desynchronises everything after it.
 */
export function interleave(channels: Float32Array[], channelCount = LOOPBACK_CHANNELS): Float32Array {
  if (channels.length === 0) return new Float32Array(0)

  const frames = channels[0].length
  const output = new Float32Array(frames * channelCount)

  for (let channel = 0; channel < channelCount; channel++) {
    // Mono in, stereo out: the same data goes to both sides.
    const source = channels[Math.min(channel, channels.length - 1)]
    for (let frame = 0; frame < frames; frame++) {
      output[frame * channelCount + channel] = source[frame] ?? 0
    }
  }

  return output
}

/**
 * Float samples to little-endian bytes.
 *
 * Explicitly little-endian because the ffmpeg input format says f32le. Relying
 * on the platform's native order would work on x86 and silently corrupt audio
 * anywhere else.
 */
export function floatsToLe(samples: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(samples.length * 4)
  for (let i = 0; i < samples.length; i++) {
    buffer.writeFloatLE(clampSample(samples[i]), i * 4)
  }
  return buffer
}

/**
 * Web Audio can hand back values outside [-1, 1] after mixing. f32le has no
 * defined behaviour there, and different decoders wrap rather than clip, so
 * clamping here keeps a loud moment from turning into a burst of noise.
 */
function clampSample(value: number): number {
  // NaN has no sensible loudness, so it becomes silence. Infinity does: it's a
  // sample louder than full scale, and clamping it to the rail is continuous
  // with the samples around it where dropping it to zero would be a click.
  if (Number.isNaN(value)) return 0
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

/** Bytes one second of audio occupies, for buffer sizing and diagnostics. */
export function bytesPerSecond(
  sampleRate = LOOPBACK_SAMPLE_RATE,
  channels = LOOPBACK_CHANNELS
): number {
  return sampleRate * channels * 4
}

/**
 * Caps how much audio may pile up while nothing is reading it.
 *
 * ffmpeg connects a moment after the bridge starts, and could stall later. An
 * unbounded queue would grow at 384 KB/s until the process died; dropping the
 * oldest audio instead costs a gap at the start, which is inaudible against
 * losing the recording.
 */
export const MAX_BUFFERED_BYTES = bytesPerSecond() * 3

export interface BufferState {
  chunks: Buffer[]
  bytes: number
  /** How many bytes have been discarded through overflow. */
  dropped: number
}

export function createBufferState(): BufferState {
  return { chunks: [], bytes: 0, dropped: 0 }
}

/** Appends, discarding the oldest audio once the cap is exceeded. */
export function pushBounded(
  state: BufferState,
  chunk: Buffer,
  maxBytes = MAX_BUFFERED_BYTES
): BufferState {
  state.chunks.push(chunk)
  state.bytes += chunk.length

  while (state.bytes > maxBytes && state.chunks.length > 0) {
    const oldest = state.chunks.shift() as Buffer
    state.bytes -= oldest.length
    state.dropped += oldest.length
  }

  return state
}

/** Empties the queue, returning everything buffered as one chunk. */
export function drain(state: BufferState): Buffer {
  const combined = Buffer.concat(state.chunks, state.bytes)
  state.chunks = []
  state.bytes = 0
  return combined
}
