/**
 * T7a item 2: a scripted protocol client over `ws`.
 *
 * It is a member with no page: it joins with an optional name, sends §5's
 * frames, waits for the frame it asked about, and records **every** frame it
 * received with the instant it arrived — so "visible within 300 ms" (R6) and
 * "exactly one `state`" are measured, never assumed.
 *
 * The offset estimate is `src/shared/timing.ts`'s, folded from real `pong`s;
 * nothing here re-derives a clock.
 */

import { WebSocket } from 'ws'

import type {
  ClientFrame,
  ErrorFrame,
  Playback,
  ServerFrame,
  StateFrame,
  WelcomeFrame,
} from '../../src/shared/protocol.ts'
import {
  emptyEstimate,
  estimateOffset,
  sampleFrom,
  type OffsetEstimate,
} from '../../src/shared/timing.ts'
import { FakeClock, FakePlayer, type FakeClockOptions } from './fakePlayer.ts'

/** One frame as this client saw it, with the wall-clock instant it landed. */
export interface FrameRecord<F extends ServerFrame = ServerFrame> {
  frame: F
  /** Millis, this machine's real clock, when the frame was read off the socket. */
  at: number
}

export interface ClientOptions {
  clock?: FakeClockOptions
  duration?: number
  timeoutMs?: number
  /**
   * T148: the member id this client claims in `hello`. Absent means the
   * authority mints one, which is what every older case asserts.
   */
  id?: string
  /**
   * T165: the seat proof the room issued this member's page on its first join.
   * Absent means "I hold no proof", which is what a guest quoting an id it read
   * out of `members` has - and that join must never inherit the row.
   */
  proof?: string
}

const DEFAULT_TIMEOUT_MS = 3000

interface Waiter {
  match: (frame: ServerFrame) => boolean
  resolve: (record: FrameRecord) => void
}

export class ScriptedClient {
  readonly socket: WebSocket
  readonly clock: FakeClock
  readonly player: FakePlayer
  /** Every frame this client ever received, arrival order, arrival time. */
  readonly frames: FrameRecord[] = []
  estimate: OffsetEstimate = emptyEstimate()
  readonly selfId: string
  readonly welcome: WelcomeFrame

  /** Frames nobody has waited for yet; `next()` consumes from here first. */
  #inbox: FrameRecord[] = []
  #waiters: Waiter[] = []
  #timeoutMs: number
  #closed: Promise<void>
  /** §5's 3 s report beat, only while the last `playback` is playing. */
  #reportTimer: ReturnType<typeof setInterval> | null = null

  private constructor(socket: WebSocket, welcome: WelcomeFrame, options: ClientOptions) {
    this.socket = socket
    this.welcome = welcome
    this.selfId = welcome.selfId
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.clock = new FakeClock(options.clock ?? {})
    this.player = new FakePlayer({
      clock: this.clock,
      estimate: () => this.estimate,
      ...(options.duration === undefined ? {} : { duration: options.duration }),
    })
    // A join is not a command: `welcome` is the snapshot, so the player starts
    // where the room is (R7) without waiting for a `state` (T6b's Safety line).
    this.player.apply(welcome.room.playback)

    this.#closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  }

  /** Connects, sends `hello`, and resolves once `welcome` has arrived. */
  static async open(
    port: number,
    code: string,
    name?: string,
    options: ClientOptions = {},
  ): Promise<ScriptedClient> {
    const outcome = await ScriptedClient.attempt(port, code, name, options)
    if (!outcome.ok) throw new Error(`hello was refused: ${outcome.error.code}`)
    return outcome.client
  }

  /**
   * The same join, but a refusal is a result rather than an exception — §5's
   * `room_full` is a fact about the room the room_full check wants to read.
   * The refused socket is closed before this resolves.
   */
  static async attempt(
    port: number,
    code: string,
    name?: string,
    options: ClientOptions = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ ok: true; client: ScriptedClient } | { ok: false; error: ErrorFrame }> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.on('error', () => {
      // Surfaced through the wait's timeout; a dropped socket closes the test.
    })

    const pending: FrameRecord[] = []
    let live: ScriptedClient | null = null
    let announce: (frame: WelcomeFrame) => void = () => {}
    let refuse: (frame: ErrorFrame) => void = () => {}
    const welcomed = new Promise<WelcomeFrame>((resolve) => {
      announce = resolve
    })
    const refused = new Promise<ErrorFrame>((resolve) => {
      refuse = resolve
    })

    socket.on('message', (data: unknown) => {
      const frame = JSON.parse(String(data)) as ServerFrame
      const record: FrameRecord = { frame, at: Date.now() }
      // Before `welcome` has been handled only a refusal can resolve the join:
      // an `error` here is the authority saying no, not a later room error.
      if (frame.type === 'welcome') announce(frame)
      if (frame.type === 'error') refuse(frame)
      if (live === null) pending.push(record)
      else live.receive(record)
    })

    socket.send(
      JSON.stringify({
        type: 'hello',
        code,
        ...(name === undefined ? {} : { name }),
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.proof === undefined ? {} : { proof: options.proof }),
      }),
    )

    const outcome = await Promise.race([
      welcomed.then((welcome) => ({ kind: 'welcome' as const, welcome })),
      refused.then((error) => ({ kind: 'refused' as const, error })),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`no welcome or error in ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])

    if (outcome.kind === 'refused') {
      socket.close()
      return { ok: false, error: outcome.error }
    }

    const client = new ScriptedClient(socket, outcome.welcome, options)
    live = client
    for (const record of pending) client.receive(record)
    return { ok: true, client }
  }

  get name(): string {
    return this.welcome.members.find((member) => member.id === this.selfId)?.displayName ?? '?'
  }

  /** §5: every outbound frame goes through here, so nothing bypasses the client. */
  send(frame: ClientFrame | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame))
  }

  /** Waits for the next frame `match` accepts; a frame is delivered once. */
  next(match: (frame: ServerFrame) => boolean, timeoutMs = this.#timeoutMs): Promise<FrameRecord> {
    const index = this.#inbox.findIndex((record) => match(record.frame))
    if (index !== -1) return Promise.resolve(this.#inbox.splice(index, 1)[0] as FrameRecord)

    return new Promise<FrameRecord>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (record) => {
          clearTimeout(timer)
          resolve(record)
        },
      }
      const timer = setTimeout(() => {
        const at = this.#waiters.indexOf(waiter)
        if (at !== -1) this.#waiters.splice(at, 1)
        reject(
          new Error(
            `no matching frame in ${timeoutMs}ms; saw: ${JSON.stringify(this.frames.map((entry) => entry.frame))}`,
          ),
        )
      }, timeoutMs)
      // A pending wait must never keep the suite's process alive.
      timer.unref?.()
      this.#waiters.push(waiter)
    })
  }

  /** The convenience form: the next unconsumed frame of `type`. */
  nextOf(type: ServerFrame['type'], timeoutMs = this.#timeoutMs): Promise<FrameRecord> {
    return this.next((frame) => frame.type === type, timeoutMs)
  }

  /** A command from this member, and the `state` it produced (§5's echo). */
  async stateAfter(frame: ClientFrame, timeoutMs = this.#timeoutMs): Promise<FrameRecord<StateFrame>> {
    this.send(frame)
    return (await this.next((seen) => seen.type === 'state', timeoutMs)) as FrameRecord<StateFrame>
  }

  play(position: number): Promise<FrameRecord<StateFrame>> {
    return this.stateAfter({ type: 'play', position })
  }

  pause(position: number): Promise<FrameRecord<StateFrame>> {
    return this.stateAfter({ type: 'pause', position })
  }

  seek(position: number, wasPlaying = false): Promise<FrameRecord<StateFrame>> {
    return this.stateAfter({ type: 'seek', position, wasPlaying })
  }

  /** §4.6: one message, echoed to everyone including its sender. */
  async say(text: string): Promise<FrameRecord> {
    this.send({ type: 'chat', text })
    return this.next((frame) => frame.type === 'chat' && frame.kind === 'user')
  }

  /**
   * §6.1 read on one machine: `samples` pings, folded by the one estimator.
   * `t0`/`t3` are this clock's, `t1`/`t2` the authority's.
   */
  async sampleOffset(samples = 5): Promise<OffsetEstimate> {
    for (let index = 0; index < samples; index += 1) {
      const t0 = this.clock.now()
      this.send({ type: 'ping', t0 })
      const { frame } = await this.next((seen) => seen.type === 'pong')
      if (frame.type !== 'pong') continue
      const sample = sampleFrom(frame.t0, frame.t1, frame.t2, this.clock.now())
      if (sample !== null) this.estimate = estimateOffset(sample, this.estimate)
    }
    return this.estimate
  }

  /**
   * §5: one `report` now. It carries the player's own four numbers, the
   * duration/origin it knows, and this client's T5 `rtt` — the value the
   * authority's scheduled start needs (§6.4). A paused player sends nothing.
   */
  reportNow(): void {
    const playback = this.lastPlayback()
    if (playback === null || !playback.playing) return
    this.send({
      type: 'report',
      ...this.player.report(),
      origin: 'harness',
      rtt: Math.max(0, this.estimate.rtt),
    })
  }

  /** §5: every 3 s while playing, from every member. */
  startReporting(intervalMs = 3000): void {
    this.stopReporting()
    const timer = setInterval(() => this.reportNow(), intervalMs)
    timer.unref?.()
    this.#reportTimer = timer
  }

  stopReporting(): void {
    if (this.#reportTimer === null) return
    clearInterval(this.#reportTimer)
    this.#reportTimer = null
  }

  /** The last `playback` the authority has told this client about. */
  lastPlayback(): Playback | null {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const { frame } = this.frames[index]!
      if (frame.type === 'state') return frame.playback
    }
    return null
  }

  close(): Promise<void> {
    this.stopReporting()
    this.socket.close()
    return this.#closed
  }

  /** Every arrival passes through here: recorded, fed to the player, offered to waiters. */
  receive(record: FrameRecord): void {
    this.frames.push(record)
    const { frame } = record

    if (frame.type === 'state') {
      const apply = (): void => this.player.apply(frame.playback)
      if (this.clock.delayMs > 0) setTimeout(apply, this.clock.delayMs).unref?.()
      else apply()
    }
    // T7b1 stops at "the frame arrived": the page that *applies* a nudge is
    // T7b2. The player's `playbackRate` is recorded so a later report tells the
    // truth about what this member holds.
    if (frame.type === 'nudge') this.player.playbackRate = frame.rate

    const index = this.#waiters.findIndex((waiter) => waiter.match(frame))
    if (index !== -1) this.#waiters.splice(index, 1)[0]!.resolve(record)
    else this.#inbox.push(record)
  }
}
