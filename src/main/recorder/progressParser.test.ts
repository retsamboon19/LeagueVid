import { describe, expect, it } from 'vitest'
import { assessCaptureHealth, parseProgressChunk } from './progressParser'

/** One complete -progress block as ffmpeg writes it. */
function block(overrides: Record<string, string | number> = {}, terminator = 'continue'): string {
  const fields: Record<string, string | number> = {
    frame: 600,
    fps: 59.94,
    stream_0_0_q: 21.0,
    bitrate: '12345.6kbits/s',
    total_size: 52428800,
    out_time_us: 10000000,
    out_time_ms: 10000000,
    out_time: '00:00:10.000000',
    dup_frames: 0,
    drop_frames: 0,
    speed: '1.01x',
    ...overrides
  }
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${value}`)
  lines.push(`progress=${terminator}`)
  return `${lines.join('\n')}\n`
}

describe('parseProgressChunk', () => {
  it('parses a complete block', () => {
    const { samples, remainder } = parseProgressChunk(block())
    expect(samples).toHaveLength(1)
    expect(remainder).toBe('')
    expect(samples[0]).toEqual({
      frame: 600,
      fps: 59.94,
      totalSizeBytes: 52428800,
      outTimeMs: 10000,
      dropFrames: 0,
      dupFrames: 0,
      speed: 1.01,
      ended: false
    })
  })

  // ffmpeg's out_time_ms is a long-standing misnomer: it reports microseconds,
  // the same as out_time_us. Reading it as milliseconds would put the
  // recording position out by a factor of 1000.
  it('reads position from out_time_us, not the misnamed out_time_ms', () => {
    const { samples } = parseProgressChunk(
      block({ out_time_us: 20583000, out_time_ms: 20583000 })
    )
    expect(samples[0].outTimeMs).toBe(20583)
  })

  it('marks the final block', () => {
    const { samples } = parseProgressChunk(block({}, 'end'))
    expect(samples[0].ended).toBe(true)
  })

  it('parses several blocks arriving in one chunk', () => {
    const { samples } = parseProgressChunk(
      block({ frame: 60 }) + block({ frame: 120 }) + block({ frame: 180 })
    )
    expect(samples.map((s) => s.frame)).toEqual([60, 120, 180])
  })

  // A pipe splits wherever it likes. Anything that parsed per-chunk would drop
  // samples at random, and would do it more often under load -- exactly when
  // the numbers are worth having.
  it('reassembles a block split across two chunks', () => {
    const whole = block({ frame: 300 })
    const cut = Math.floor(whole.length / 2)

    const first = parseProgressChunk(whole.slice(0, cut))
    expect(first.samples).toHaveLength(0)
    expect(first.remainder).not.toBe('')

    const second = parseProgressChunk(whole.slice(cut), first.remainder)
    expect(second.samples).toHaveLength(1)
    expect(second.samples[0].frame).toBe(300)
    expect(second.remainder).toBe('')
  })

  it('reassembles a block split mid-key', () => {
    const whole = block({ frame: 900, drop_frames: 7 })
    const cut = whole.indexOf('drop_fra') + 4

    const first = parseProgressChunk(whole.slice(0, cut))
    const second = parseProgressChunk(whole.slice(cut), first.remainder)

    expect(second.samples).toHaveLength(1)
    expect(second.samples[0].frame).toBe(900)
    expect(second.samples[0].dropFrames).toBe(7)
  })

  it('reassembles a block split one byte at a time', () => {
    const whole = block({ frame: 42, speed: '0.87x' })
    let carry = ''
    const collected: number[] = []

    for (const char of whole) {
      const result = parseProgressChunk(char, carry)
      carry = result.remainder
      for (const sample of result.samples) collected.push(sample.frame)
    }

    expect(collected).toEqual([42])
    expect(carry).toBe('')
  })

  it('keeps a trailing partial block as the remainder and completes it later', () => {
    const first = parseProgressChunk(`${block({ frame: 60 })}frame=120\nfps=60.0\n`)
    expect(first.samples).toHaveLength(1)
    expect(first.remainder).toContain('frame=120')

    const second = parseProgressChunk('drop_frames=0\nspeed=1.0x\nprogress=continue\n', first.remainder)
    expect(second.samples).toHaveLength(1)
    expect(second.samples[0].frame).toBe(120)
  })

  it('treats N/A as zero rather than NaN', () => {
    const { samples } = parseProgressChunk(
      block({ fps: 'N/A', speed: 'N/A', total_size: 'N/A', drop_frames: 'N/A' })
    )
    expect(samples[0].fps).toBe(0)
    expect(samples[0].speed).toBe(0)
    expect(samples[0].totalSizeBytes).toBe(0)
    expect(samples[0].dropFrames).toBe(0)
  })

  it('ignores lines that are not key=value', () => {
    const { samples } = parseProgressChunk(`some banner text\n${block({ frame: 15 })}`)
    expect(samples).toHaveLength(1)
    expect(samples[0].frame).toBe(15)
  })

  it('returns nothing for empty input', () => {
    expect(parseProgressChunk('')).toEqual({ samples: [], remainder: '' })
  })
})

describe('assessCaptureHealth', () => {
  const sample = {
    frame: 1000,
    fps: 60,
    totalSizeBytes: 1000,
    outTimeMs: 16000,
    dropFrames: 0,
    dupFrames: 0,
    speed: 1.0,
    ended: false
  }

  it('is healthy with no drops at real time', () => {
    const health = assessCaptureHealth(sample)
    expect(health.healthy).toBe(true)
    expect(health.reasons).toEqual([])
  })

  it('tolerates a handful of dropped frames', () => {
    expect(assessCaptureHealth({ ...sample, dropFrames: 5 }).healthy).toBe(true)
  })

  it('complains above one percent dropped', () => {
    const health = assessCaptureHealth({ ...sample, dropFrames: 25 })
    expect(health.healthy).toBe(false)
    expect(health.dropRatio).toBeCloseTo(0.025)
    expect(health.reasons[0]).toContain('Dropping frames')
  })

  // Falling behind real time is a separate failure from dropping frames: the
  // buffer is growing, so drops are coming even though none have happened yet.
  it('complains below real-time speed even with no drops', () => {
    const health = assessCaptureHealth({ ...sample, speed: 0.8 })
    expect(health.healthy).toBe(false)
    expect(health.reasons[0]).toContain('slower than real time')
  })

  it('reports both problems at once', () => {
    const health = assessCaptureHealth({ ...sample, dropFrames: 50, speed: 0.5 })
    expect(health.reasons).toHaveLength(2)
  })

  // The failure this check was added for. Reproduced from a real 193-second
  // session: 5777 frames written at a steady 30fps, nothing dropped, 1.00x
  // speed, full file size -- and only 1186 of those frames carried new content,
  // so it played as a slideshow. Every other signal here reads as healthy.
  it('catches a capture whose frames are nearly all repeats', () => {
    const health = assessCaptureHealth({
      ...sample,
      frame: 5777,
      fps: 30,
      dupFrames: 5777 - 1186,
      dropFrames: 0,
      speed: 1.0
    })

    expect(health.healthy).toBe(false)
    expect(health.dupRatio).toBeCloseTo(0.795, 2)
    expect(health.reasons[0]).toContain('look choppy')
  })

  // Duplication is normal in the cases the recorder cannot avoid: a loading
  // screen has nothing to hand over, and capturing above the panel's refresh
  // duplicates by definition. Warning on those would train the user to ignore
  // the warning that matters.
  it('tolerates the duplication a still screen legitimately produces', () => {
    expect(assessCaptureHealth({ ...sample, dupFrames: 150 }).healthy).toBe(true)
  })

  it('separates a stuttering source from an overloaded encoder', () => {
    const stuttering = assessCaptureHealth({ ...sample, dupFrames: 800 })
    const overloaded = assessCaptureHealth({ ...sample, dropFrames: 100, speed: 0.6 })

    expect(stuttering.reasons).toHaveLength(1)
    expect(stuttering.reasons[0]).toContain('look choppy')
    expect(overloaded.reasons.every((r) => !r.includes('look choppy'))).toBe(true)
  })

  // Before the first frame lands, speed reads 0 and nothing has been dropped.
  // Warning there would fire on every single recording at startup.
  it('does not warn before the first frame', () => {
    expect(assessCaptureHealth({ ...sample, frame: 0, speed: 0, fps: 0 }).healthy).toBe(true)
  })
})
