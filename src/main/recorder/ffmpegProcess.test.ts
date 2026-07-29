import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { startCapture, type CaptureChild } from './ffmpegProcess'

/**
 * Stand-in for the ffmpeg child. Lets the tests drive stdout, stderr, exit
 * codes and -- the part that matters -- a child that ignores 'q' and has to be
 * killed, which is impossible to arrange reliably with the real binary.
 */
class FakeChild extends EventEmitter implements CaptureChild {
  stdinWrites: string[] = []
  killSignals: string[] = []
  /** When false, the child ignores 'q' and only stops when killed. */
  respondsToQuit = true

  stdin = {
    write: (data: string): boolean => {
      this.stdinWrites.push(data)
      if (this.respondsToQuit && data === 'q') {
        // Real ffmpeg finalizes the container and exits 0.
        setTimeout(() => this.emit('close', 0), 0)
      }
      return true
    }
  }

  stdout = new EventEmitter() as unknown as CaptureChild['stdout']
  stderr = new EventEmitter() as unknown as CaptureChild['stderr']

  kill(signal?: string): boolean {
    this.killSignals.push(signal ?? 'SIGTERM')
    setTimeout(() => this.emit('close', 137), 0)
    return true
  }

  pushStdout(text: string): void {
    ;(this.stdout as unknown as EventEmitter).emit('data', text)
  }

  pushStderr(text: string): void {
    ;(this.stderr as unknown as EventEmitter).emit('data', text)
  }
}

function progressBlock(fields: Record<string, string | number>, terminator = 'continue'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${value}`)
  lines.push(`progress=${terminator}`)
  return `${lines.join('\n')}\n`
}

function start(child: FakeChild, options: Partial<Parameters<typeof startCapture>[0]> = {}) {
  return startCapture({
    ffmpegPath: 'ffmpeg',
    args: ['-f', 'matroska', 'out.mkv'],
    spawnFn: () => child,
    ...options
  })
}

describe('startCapture', () => {
  it('passes the arguments to the spawner', () => {
    const child = new FakeChild()
    const spawnFn = vi.fn(() => child as CaptureChild)
    startCapture({ ffmpegPath: 'C:\\ffmpeg.exe', args: ['-x'], spawnFn })
    expect(spawnFn).toHaveBeenCalledWith('C:\\ffmpeg.exe', ['-x'])
  })

  it('reports progress samples', async () => {
    const child = new FakeChild()
    const samples: number[] = []
    let clock = 0
    const handle = start(child, {
      onProgress: (sample) => samples.push(sample.frame),
      now: () => clock
    })

    child.pushStdout(progressBlock({ frame: 60, fps: 60, out_time_us: 1000000 }))
    clock += 1000
    child.pushStdout(progressBlock({ frame: 120, fps: 60, out_time_us: 2000000 }))

    expect(samples).toEqual([60, 120])
    expect(handle.lastProgress()?.frame).toBe(120)
  })

  // ffmpeg can flush progress several times a second. Forwarding every one of
  // them to the renderer is pointless churn, but the totals still have to be
  // tracked from all of them.
  it('throttles emission to once a second while still tracking every sample', () => {
    const child = new FakeChild()
    const emitted: number[] = []
    let clock = 0
    const handle = start(child, {
      onProgress: (sample) => emitted.push(sample.frame),
      now: () => clock
    })

    child.pushStdout(progressBlock({ frame: 10 }))
    child.pushStdout(progressBlock({ frame: 20 }))
    child.pushStdout(progressBlock({ frame: 30 }))
    clock += 1000
    child.pushStdout(progressBlock({ frame: 40 }))

    expect(emitted).toEqual([10, 40])
    expect(handle.lastProgress()?.frame).toBe(40)
  })

  it('always emits the final sample regardless of throttling', () => {
    const child = new FakeChild()
    const emitted: number[] = []
    let clock = 0
    start(child, { onProgress: (s) => emitted.push(s.frame), now: () => clock })

    child.pushStdout(progressBlock({ frame: 10 }))
    child.pushStdout(progressBlock({ frame: 20 }))
    child.pushStdout(progressBlock({ frame: 30 }, 'end'))

    expect(emitted).toEqual([10, 30])
  })

  it('reassembles progress blocks split across chunks', () => {
    const child = new FakeChild()
    const emitted: number[] = []
    let clock = 0
    start(child, { onProgress: (s) => emitted.push(s.frame), now: () => clock })

    const whole = progressBlock({ frame: 777, fps: 60 })
    child.pushStdout(whole.slice(0, 10))
    expect(emitted).toEqual([])
    child.pushStdout(whole.slice(10))
    expect(emitted).toEqual([777])
  })

  describe('readiness', () => {
    // ddagrab can open a display and produce nothing at all -- observed on a
    // machine where gdigrab captured fine. So readiness is measured in frames
    // actually encoded, never in elapsed time.
    it('is not ready until enough frame-bearing samples arrive', () => {
      const child = new FakeChild()
      const firstFrames = vi.fn()
      let clock = 0
      const handle = start(child, {
        onFirstFrames: firstFrames,
        readyAfterSamples: 3,
        now: () => clock
      })

      expect(handle.isProducingFrames()).toBe(false)

      child.pushStdout(progressBlock({ frame: 1 }))
      child.pushStdout(progressBlock({ frame: 2 }))
      expect(handle.isProducingFrames()).toBe(false)
      expect(firstFrames).not.toHaveBeenCalled()

      child.pushStdout(progressBlock({ frame: 3 }))
      expect(handle.isProducingFrames()).toBe(true)
      expect(firstFrames).toHaveBeenCalledOnce()
    })

    it('never becomes ready on frame-less samples, however many arrive', () => {
      const child = new FakeChild()
      let clock = 0
      const handle = start(child, { readyAfterSamples: 3, now: () => clock })

      for (let i = 0; i < 50; i++) {
        child.pushStdout(progressBlock({ frame: 0, fps: 'N/A', speed: 'N/A' }))
        clock += 1000
      }

      expect(handle.isProducingFrames()).toBe(false)
    })

    it('announces readiness only once', () => {
      const child = new FakeChild()
      const firstFrames = vi.fn()
      let clock = 0
      start(child, { onFirstFrames: firstFrames, readyAfterSamples: 1, now: () => clock })

      child.pushStdout(progressBlock({ frame: 1 }))
      child.pushStdout(progressBlock({ frame: 2 }))
      child.pushStdout(progressBlock({ frame: 3 }))

      expect(firstFrames).toHaveBeenCalledOnce()
    })
  })

  describe('stopping', () => {
    // The whole reason this module exists: ffmpeg only writes the container
    // index when it leaves its main loop normally, which is what 'q' triggers.
    // A signal skips that.
    it('asks ffmpeg to quit by writing q, not by signalling', async () => {
      const child = new FakeChild()
      const handle = start(child)

      const exit = await handle.stop()

      expect(child.stdinWrites).toEqual(['q'])
      expect(child.killSignals).toEqual([])
      expect(exit.code).toBe(0)
      expect(exit.forced).toBe(false)
    })

    it('kills the child when it ignores the quit request', async () => {
      const child = new FakeChild()
      child.respondsToQuit = false
      const handle = start(child)

      const exit = await handle.stop(10)

      expect(child.stdinWrites).toEqual(['q'])
      expect(child.killSignals).toEqual(['SIGKILL'])
      expect(exit.forced).toBe(true)
      expect(exit.code).toBe(137)
    })

    it('does not kill a child that stops within the grace period', async () => {
      const child = new FakeChild()
      const handle = start(child)

      const exit = await handle.stop(5000)
      // Let any stray timer fire.
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(child.killSignals).toEqual([])
      expect(exit.forced).toBe(false)
    })

    it('survives a stdin that has already closed', async () => {
      const child = new FakeChild()
      child.stdin = {
        write: () => {
          throw new Error('EPIPE')
        }
      }
      const handle = start(child)

      const stopped = handle.stop(10)
      const exit = await stopped

      // Nothing thrown; the kill fallback still settles it.
      expect(exit.forced).toBe(true)
    })

    it('carries the final progress totals out with the exit', async () => {
      const child = new FakeChild()
      let clock = 0
      const handle = start(child, { now: () => clock })

      child.pushStdout(
        progressBlock({ frame: 3600, fps: 59.9, total_size: 999, drop_frames: 4 }, 'end')
      )
      const exit = await handle.stop()

      expect(exit.lastProgress?.frame).toBe(3600)
      expect(exit.lastProgress?.dropFrames).toBe(4)
    })
  })

  describe('failure reporting', () => {
    it('keeps a bounded tail of stderr', async () => {
      const child = new FakeChild()
      const handle = start(child)

      child.pushStderr('x'.repeat(20000))
      child.pushStderr('the actual error at the end')
      child.emit('close', 1)

      const exit = await handle.exited
      expect(exit.code).toBe(1)
      expect(exit.stderrTail.length).toBeLessThanOrEqual(8000)
      expect(exit.stderrTail).toContain('the actual error at the end')
    })

    it('reports a child that could not be spawned as a failed exit', async () => {
      const child = new FakeChild()
      const handle = start(child)

      child.emit('error', new Error('spawn ENOENT'))

      const exit = await handle.exited
      expect(exit.code).toBeNull()
      expect(exit.stderrTail).toContain('spawn ENOENT')
    })

    it('settles exactly once even if close follows error', async () => {
      const child = new FakeChild()
      const handle = start(child)

      child.emit('error', new Error('first'))
      child.emit('close', 1)

      const exit = await handle.exited
      expect(exit.code).toBeNull()
    })

    it('forwards stderr lines as they arrive', () => {
      const child = new FakeChild()
      const lines: string[] = []
      start(child, { onStderr: (line) => lines.push(line) })

      child.pushStderr('Opened dxgi output 0')
      expect(lines).toEqual(['Opened dxgi output 0'])
    })
  })
})
