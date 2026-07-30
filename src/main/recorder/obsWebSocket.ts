import { createHash } from 'crypto'
import WebSocket from 'ws'

// A minimal obs-websocket v5 client: just the requests LeagueVid needs.
//
// Written rather than taken from a package because the surface used here is six
// request types and two events, while the published clients bring an event
// emitter framework and a type generator for the whole 100-odd request protocol.
//
// Verified against obs-websocket 5.7.4, which is what OBS 32.2.1 ships.
//
// Protocol shape, for whoever reads this next:
//   server -> Hello(0)       { rpcVersion, authentication?: { challenge, salt } }
//   client -> Identify(1)    { rpcVersion, authentication?, eventSubscriptions }
//   server -> Identified(2)  { negotiatedRpcVersion }
//   client -> Request(6)     { requestType, requestId, requestData }
//   server -> Response(7)    { requestType, requestId, requestStatus, responseData }
//   server -> Event(5)       { eventType, eventIntent, eventData }

const enum OpCode {
  Hello = 0,
  Identify = 1,
  Identified = 2,
  Event = 5,
  Request = 6,
  RequestResponse = 7
}

/**
 * Event subscriptions requested at identify time.
 *
 * 1 = General, 64 = Outputs. Outputs is what carries RecordStateChanged, which
 * is how the client learns the recording actually stopped and where the file
 * went. Subscribing to everything instead would have OBS push scene, input and
 * transition traffic nobody reads.
 */
const EVENT_SUBSCRIPTIONS = 1 | 64

/** How long to wait for the connection and identify handshake. */
const CONNECT_TIMEOUT_MS = 15000

/** How long any single request may take before it is treated as failed. */
const REQUEST_TIMEOUT_MS = 10000

/**
 * obs-websocket's RequestStatus for "still starting up".
 *
 * Worth distinguishing by code rather than by message text: it is the one
 * failure that resolves itself with time, and everything else should surface
 * immediately instead of being retried.
 */
export const REQUEST_STATUS_NOT_READY = 207

/** A request OBS answered with a failure status, carrying its code. */
export class ObsRequestError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message)
    this.name = 'ObsRequestError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ObsRecordStatus {
  outputActive: boolean
  outputPaused: boolean
  /** Milliseconds of footage written. */
  outputDuration: number
  outputBytes: number
  outputTimecode: string
}

export interface ObsStats {
  /** Frames libobs never composited, i.e. the renderer fell behind. */
  renderSkippedFrames: number
  renderTotalFrames: number
  /** Frames the *output* dropped, i.e. the encoder or disk fell behind. */
  outputSkippedFrames: number
  outputTotalFrames: number
  activeFps: number
  averageFrameRenderTime: number
  cpuUsage: number
  memoryUsage: number
  availableDiskSpace: number
}

/**
 * Whether a source is part of the active and visible scene.
 *
 * Explicitly NOT whether game capture has hooked anything, however much the
 * names suggest otherwise. Measured against ground truth with League closed and
 * OBS's own window enumeration confirming its absence: both fields read true for
 * a game_capture source whose target window does not exist. They describe scene
 * membership, not capture state.
 *
 * Recording this here because building the capture health warning on videoActive
 * is the obvious thing to do and it would mean the warning could never fire --
 * reintroducing the exact class of bug the warning exists to catch. Use
 * captureWindowOptions for attachment instead.
 */
export interface ObsSourceActive {
  videoActive: boolean
  videoShowing: boolean
}

export type ObsEventHandler = (eventType: string, eventData: Record<string, unknown>) => void

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class ObsWebSocketClient {
  private socket: WebSocket | null = null
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventHandlers = new Set<ObsEventHandler>()
  private closed = false
  private closeReason: string | null = null

  constructor(
    private readonly url: string,
    private readonly password: string
  ) {}

  onEvent(handler: ObsEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /**
   * Connects and completes the identify handshake.
   *
   * Resolves only once identified, not merely once the socket is open: a socket
   * that connects and then fails authentication would otherwise look like a
   * working connection right up until the first request silently never answers.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.socket = socket
      // Reset, because connect() is retried while OBS starts up: its websocket
      // server does not exist for the first second or two of the process's life.
      this.closed = false
      this.closeReason = null

      /**
       * Whether this socket is still the one the client is using.
       *
       * Every handler below is guarded by it. Without that, a failed early
       * attempt's socket fires 'close' *after* a later attempt succeeded, sets
       * closed = true, and every subsequent request fails with "Not connected to
       * OBS" against a connection that is in fact open. Observed exactly that.
       */
      const isCurrent = (): boolean => this.socket === socket

      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('OBS did not complete the WebSocket handshake in time.'))
      }, CONNECT_TIMEOUT_MS)

      let identified = false

      socket.on('message', (raw) => {
        if (!isCurrent()) return
        let frame: { op: number; d: Record<string, unknown> }
        try {
          frame = JSON.parse(String(raw))
        } catch {
          return
        }

        if (frame.op === OpCode.Hello) {
          socket.send(JSON.stringify(this.identifyFrame(frame.d)))
          return
        }

        if (frame.op === OpCode.Identified) {
          identified = true
          clearTimeout(timer)
          resolve()
          return
        }

        if (frame.op === OpCode.RequestResponse) {
          this.settleResponse(frame.d)
          return
        }

        if (frame.op === OpCode.Event) {
          const eventType = String(frame.d.eventType ?? '')
          const eventData = (frame.d.eventData ?? {}) as Record<string, unknown>
          for (const handler of this.eventHandlers) {
            try {
              handler(eventType, eventData)
            } catch {
              // A misbehaving observer must not tear down the connection.
            }
          }
        }
      })

      socket.on('error', (err) => {
        clearTimeout(timer)
        if (isCurrent()) this.closeReason = err.message
        if (!identified) reject(err)
      })

      socket.on('close', (code) => {
        clearTimeout(timer)
        const reason = this.closeReason ?? `OBS closed the connection (code ${code}).`

        // A superseded socket closing says nothing about the live connection, so
        // it must not mark the client closed or fail the live requests.
        if (isCurrent()) {
          this.closed = true
          // Every in-flight request has to be failed here, or a caller awaiting
          // a response when OBS dies waits for its timeout and reports the wrong
          // cause.
          for (const [, request] of this.pending) {
            clearTimeout(request.timer)
            request.reject(new Error(reason))
          }
          this.pending.clear()
        }

        if (!identified) reject(new Error(reason))
      })
    })
  }

  /**
   * Builds the Identify frame, answering the auth challenge when there is one.
   *
   * The scheme is base64(sha256(base64(sha256(password + salt)) + challenge)).
   * Authentication is deliberately left enabled in the generated OBS config --
   * obs-websocket does not bind to loopback only, and it can set the recording
   * output path, so an unauthenticated server would let anything that can reach
   * the machine write files through OBS.
   */
  private identifyFrame(hello: Record<string, unknown>): unknown {
    const data: Record<string, unknown> = {
      rpcVersion: hello.rpcVersion ?? 1,
      eventSubscriptions: EVENT_SUBSCRIPTIONS
    }

    const auth = hello.authentication as { challenge?: string; salt?: string } | undefined
    if (auth?.challenge && auth.salt) {
      data.authentication = authenticationString(this.password, auth.salt, auth.challenge)
    }

    return { op: OpCode.Identify, d: data }
  }

  private settleResponse(payload: Record<string, unknown>): void {
    const requestId = String(payload.requestId ?? '')
    const request = this.pending.get(requestId)
    if (!request) return

    this.pending.delete(requestId)
    clearTimeout(request.timer)

    const status = (payload.requestStatus ?? {}) as {
      result?: boolean
      code?: number
      comment?: string
    }

    if (status.result) {
      request.resolve((payload.responseData ?? {}) as Record<string, unknown>)
      return
    }

    // The comment is the only human-readable part, and OBS is good about
    // filling it in -- worth surfacing rather than just the numeric code.
    const error = new ObsRequestError(
      `OBS rejected ${String(payload.requestType)} (status ${status.code}): ` +
        `${status.comment ?? 'no comment given'}`,
      Number(status.code ?? 0)
    )
    request.reject(error)
  }

  /**
   * Waits until OBS will actually answer requests.
   *
   * Being identified is not the same as being ready: obs-websocket accepts the
   * connection while OBS is still loading its frontend and answers every request
   * with NotReady until it finishes. Observed on a cold start -- the first
   * GetVersion after a successful handshake failed with "OBS is not ready to
   * perform the request."
   */
  async waitUntilReady(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: Error | null = null

    while (Date.now() < deadline) {
      try {
        await this.version()
        return
      } catch (err) {
        lastError = err as Error
        // Only NotReady is worth waiting out. Anything else -- a bad password, a
        // protocol mismatch -- will not fix itself, and retrying would turn an
        // actionable error into a 30-second hang.
        if (!(err instanceof ObsRequestError && err.code === REQUEST_STATUS_NOT_READY)) {
          throw err
        }
        await sleep(500)
      }
    }

    throw lastError ?? new Error('OBS did not become ready in time.')
  }

  request<T = Record<string, unknown>>(
    requestType: string,
    requestData: Record<string, unknown> = {}
  ): Promise<T> {
    const socket = this.socket
    if (!socket || this.closed || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to OBS.'))
    }

    const requestId = String(this.nextRequestId++)

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`OBS did not answer ${requestType} in time.`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(requestId, {
        resolve: resolve as (data: Record<string, unknown>) => void,
        reject,
        timer
      })

      socket.send(JSON.stringify({ op: OpCode.Request, d: { requestType, requestId, requestData } }))
    })
  }

  // --- The requests LeagueVid actually uses ---

  async version(): Promise<{ obsVersion: string; obsWebSocketVersion: string }> {
    const data = await this.request('GetVersion')
    return {
      obsVersion: String(data.obsVersion ?? ''),
      obsWebSocketVersion: String(data.obsWebSocketVersion ?? '')
    }
  }

  async startRecord(): Promise<void> {
    await this.request('StartRecord')
  }

  /** Stops recording and reports the file OBS wrote. */
  async stopRecord(): Promise<string | null> {
    const data = await this.request('StopRecord')
    const path = data.outputPath
    return typeof path === 'string' && path.length > 0 ? path : null
  }

  async recordStatus(): Promise<ObsRecordStatus> {
    const data = await this.request('GetRecordStatus')
    return {
      outputActive: Boolean(data.outputActive),
      outputPaused: Boolean(data.outputPaused),
      outputDuration: Number(data.outputDuration ?? 0),
      outputBytes: Number(data.outputBytes ?? 0),
      outputTimecode: String(data.outputTimecode ?? '')
    }
  }

  async stats(): Promise<ObsStats> {
    const data = await this.request('GetStats')
    return {
      renderSkippedFrames: Number(data.renderSkippedFrames ?? 0),
      renderTotalFrames: Number(data.renderTotalFrames ?? 0),
      outputSkippedFrames: Number(data.outputSkippedFrames ?? 0),
      outputTotalFrames: Number(data.outputTotalFrames ?? 0),
      activeFps: Number(data.activeFps ?? 0),
      averageFrameRenderTime: Number(data.averageFrameRenderTime ?? 0),
      cpuUsage: Number(data.cpuUsage ?? 0),
      memoryUsage: Number(data.memoryUsage ?? 0),
      availableDiskSpace: Number(data.availableDiskSpace ?? 0)
    }
  }

  async sourceActive(sourceName: string): Promise<ObsSourceActive> {
    const data = await this.request('GetSourceActive', { sourceName })
    return {
      videoActive: Boolean(data.videoActive),
      videoShowing: Boolean(data.videoShowing)
    }
  }

  /**
   * The windows game capture can currently see, as OBS formats them.
   *
   * Each entry's value is the 'title:class:executable' triple that the source's
   * `window` setting expects, so this is the authoritative way to check a match
   * string rather than constructing one and hoping. Worth having for diagnosis:
   * when a capture reports itself detached, the first question is whether OBS can
   * see the game at all.
   */
  async captureWindowOptions(
    inputName: string
  ): Promise<Array<{ name: string; value: string }>> {
    const data = await this.request('GetInputPropertiesListPropertyItems', {
      inputName,
      propertyName: 'window'
    })

    const items = Array.isArray(data.propertyItems) ? data.propertyItems : []
    return items
      .map((item) => item as Record<string, unknown>)
      .filter((item) => item.itemEnabled !== false)
      .map((item) => ({
        name: String(item.itemName ?? ''),
        value: String(item.itemValue ?? '')
      }))
  }

  /**
   * The audio devices an input can use, as OBS enumerates them.
   *
   * Names map to Windows endpoint ids here. Needed because a WASAPI source's
   * device_id is an opaque endpoint string, not the friendly name the user picked
   * from a list -- passing the name fails with 80070057 and the device never
   * starts.
   */
  async audioDeviceOptions(inputName: string): Promise<Array<{ name: string; value: string }>> {
    const data = await this.request('GetInputPropertiesListPropertyItems', {
      inputName,
      propertyName: 'device_id'
    })

    const items = Array.isArray(data.propertyItems) ? data.propertyItems : []
    return items
      .map((item) => item as Record<string, unknown>)
      .filter((item) => item.itemEnabled !== false)
      .map((item) => ({ name: String(item.itemName ?? ''), value: String(item.itemValue ?? '') }))
  }

  async setInputSettings(
    inputName: string,
    inputSettings: Record<string, unknown>,
    overlay = true
  ): Promise<void> {
    await this.request('SetInputSettings', { inputName, inputSettings, overlay })
  }

  async startReplayBuffer(): Promise<void> {
    await this.request('StartReplayBuffer')
  }

  async stopReplayBuffer(): Promise<void> {
    await this.request('StopReplayBuffer')
  }

  async saveReplayBuffer(): Promise<void> {
    await this.request('SaveReplayBuffer')
  }

  async lastReplayPath(): Promise<string | null> {
    const data = await this.request('GetLastReplayBufferReplay')
    const path = data.savedReplayPath
    return typeof path === 'string' && path.length > 0 ? path : null
  }

  /** Asks OBS to shut down cleanly, which is what finalizes the container. */
  async shutdown(): Promise<void> {
    // Not awaited for a response: OBS exits while handling this, so the socket
    // usually closes before a reply can arrive. Awaiting it would always time out.
    try {
      this.socket?.send(
        JSON.stringify({
          op: OpCode.Request,
          d: { requestType: 'ShutdownOBS', requestId: String(this.nextRequestId++), requestData: {} }
        })
      )
    } catch {
      // Already gone, which is the desired end state anyway.
    }
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // Nothing useful to do about a socket that will not close.
    }
  }

  get isConnected(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN
  }
}

/**
 * obs-websocket v5's authentication string.
 *
 * Exported for its own test: getting this wrong produces a connection that opens
 * and is then closed by the server, which is easy to misread as OBS not running.
 */
export function authenticationString(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256')
    .update(password + salt)
    .digest('base64')
  return createHash('sha256')
    .update(secret + challenge)
    .digest('base64')
}
