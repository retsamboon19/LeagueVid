import { BrowserWindow, ipcMain, session } from 'electron'
import { createServer, type Server, type Socket } from 'net'
import {
  LOOPBACK_CHANNELS,
  LOOPBACK_SAMPLE_RATE,
  createBufferState,
  drain,
  floatsToLe,
  interleave,
  pushBounded,
  type BufferState
} from './pcmFraming'

// System audio, without asking the user to install a virtual audio driver.
//
// The bundled ffmpeg has no WASAPI loopback input at all -- its only Windows
// audio input is DirectShow, which can read a microphone or a virtual cable the
// user has installed themselves. Verified on the development machine: three
// audio devices, all microphones, no Stereo Mix and no VB-Cable. So desktop
// audio has to come from somewhere else.
//
// Chromium can do it. getDisplayMedia with audio: 'loopback' gives the mixed
// system output, which Electron exposes through setDisplayMediaRequestHandler.
// The route is therefore:
//
//   hidden window -> AudioWorklet -> IPC -> localhost socket -> ffmpeg
//
// Unconventional, and the least conventional part of this whole feature. It is
// also the only option that doesn't push a driver install onto the user.

const AUDIO_CHANNEL = 'recorder:loopbackAudioChunk'

/**
 * The page that does the capture.
 *
 * Inlined rather than shipped as a file so it doesn't need a build entry of its
 * own. The AudioWorklet is registered from a blob URL for the same reason.
 */
const CAPTURE_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>LeagueVid audio bridge</title></head>
<body><script>
const { ipcRenderer } = require('electron')

const WORKLET = \`
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0 && input[0].length > 0) {
      // Copies, because the render quantum's buffers are reused immediately.
      this.port.postMessage(input.map((channel) => new Float32Array(channel)))
    }
    // Keep the processor alive even during silence: stopping would end the
    // stream, and silence in a game is normal.
    return true
  }
}
registerProcessor('tap', TapProcessor)
\`

async function start() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })

    // The video track is required to obtain the stream but is never used, so it
    // is stopped immediately -- leaving it running would duplicate the display
    // a second time purely to get at the audio.
    for (const track of stream.getVideoTracks()) track.stop()

    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      ipcRenderer.send('${AUDIO_CHANNEL}', { error: 'No system audio track was provided.' })
      return
    }

    const context = new AudioContext({ sampleRate: ${LOOPBACK_SAMPLE_RATE} })
    const blob = new Blob([WORKLET], { type: 'application/javascript' })
    await context.audioWorklet.addModule(URL.createObjectURL(blob))

    const source = context.createMediaStreamSource(new MediaStream(audioTracks))
    const node = new AudioWorkletNode(context, 'tap')
    node.port.onmessage = (event) => {
      ipcRenderer.send('${AUDIO_CHANNEL}', { channels: event.data })
    }

    // Connected to the worklet only, never to the destination: routing system
    // audio back to the speakers would feed it into itself.
    source.connect(node)
    ipcRenderer.send('${AUDIO_CHANNEL}', { ready: true })
  } catch (err) {
    ipcRenderer.send('${AUDIO_CHANNEL}', { error: String(err && err.message ? err.message : err) })
  }
}

start()
</script></body></html>`

export interface LoopbackBridge {
  /** What to hand ffmpeg: tcp://127.0.0.1:PORT. */
  url: string
  stop: () => void
}

let bridge: {
  window: BrowserWindow
  server: Server
  sockets: Set<Socket>
  buffer: BufferState
} | null = null

/**
 * Starts the bridge and resolves once system audio is actually flowing.
 *
 * Rejects rather than resolving with a broken bridge: the caller has to be able
 * to tell the difference, because starting a recording that silently contains
 * no game audio is the failure this whole path exists to avoid.
 */
export async function startLoopbackBridge(timeoutMs = 8000): Promise<LoopbackBridge> {
  if (bridge) return { url: urlFor(bridge.server), stop: stopLoopbackBridge }

  const buffer = createBufferState()
  const sockets = new Set<Socket>()

  // ffmpeg is the client, so the app listens. Port 0 lets the OS choose, which
  // avoids colliding with whatever else is on the machine.
  const server = createServer((socket) => {
    sockets.add(socket)
    // Anything buffered while ffmpeg was still connecting goes out first.
    const pending = drain(buffer)
    if (pending.length > 0) socket.write(pending)

    socket.on('error', () => sockets.delete(socket))
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  // Loopback audio is granted through the display-media handler. Video has to
  // be offered for the request to succeed at all; the page stops that track
  // immediately.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      callback({ audio: 'loopback' })
    },
    { useSystemPicker: false }
  )

  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      // The page talks to the main process directly; it is app-authored content
      // with no remote code, loaded from a data URL.
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })

  bridge = { window, server, sockets, buffer }

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('System audio capture did not start in time.'))
    }, timeoutMs)

    ipcMain.on(AUDIO_CHANNEL, function handler(_event, payload) {
      if (payload?.ready) {
        clearTimeout(timer)
        resolve()
        return
      }
      if (payload?.error) {
        clearTimeout(timer)
        reject(new Error(payload.error))
        return
      }
      if (payload?.channels) {
        writeChunk(payload.channels as Float32Array[])
      }
    })
  })

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CAPTURE_PAGE)}`)

  try {
    await ready
  } catch (err) {
    stopLoopbackBridge()
    throw err
  }

  return { url: urlFor(server), stop: stopLoopbackBridge }
}

function writeChunk(channels: Float32Array[]): void {
  if (!bridge) return

  const bytes = floatsToLe(interleave(channels, LOOPBACK_CHANNELS))

  if (bridge.sockets.size === 0) {
    // ffmpeg hasn't connected yet, or has gone away. Buffer, bounded.
    pushBounded(bridge.buffer, bytes)
    return
  }

  for (const socket of bridge.sockets) {
    // Backpressure is ignored deliberately: dropping a chunk is better than
    // growing a queue behind a stalled reader, and the socket is local.
    socket.write(bytes)
  }
}

export function stopLoopbackBridge(): void {
  if (!bridge) return

  ipcMain.removeAllListeners(AUDIO_CHANNEL)
  for (const socket of bridge.sockets) socket.destroy()
  bridge.server.close()
  if (!bridge.window.isDestroyed()) bridge.window.destroy()
  bridge = null
}

function urlFor(server: Server): string {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  // listen=0 means connect as a client, which is what ffmpeg does here.
  return `tcp://127.0.0.1:${port}`
}

export function isLoopbackBridgeRunning(): boolean {
  return bridge !== null
}
