/**
 * T7a item 3: one authority, real sockets, N scripted clients on loopback.
 *
 * The authority is the sidecar **in-library** — `createRoom()` plus
 * `attachRoomSocket()` on an ephemeral port — not a spawned app, so a test can
 * read `room` directly and every listener is released in `close()`. Nothing
 * here opens a window or a DOM: this harness drives §5's protocol, and only
 * that (T7a's Method notes).
 *
 * Later tickets add their assertions here rather than starting a second
 * harness (T7a item 5, phase spec §7 B).
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createRoom, type RoomState } from '../../src/server/room.ts'
import { attachRoomSocket } from '../../src/server/socket.ts'
import { ScriptedClient, type ClientOptions } from '../support/client.ts'

/** A room code for the harness; nothing about it is special, it just must match. */
export const CODE = 'T7A001'

export interface HarnessOptions {
  /** Scripted members to seat immediately; the first one owns the room. */
  clients?: number
  names?: string[]
  /** The authority's clock, for a test that must move it (the chat-burst limit). */
  now?: () => number
  /** Media duration the fake players believe in. */
  duration?: number
}

export interface Harness {
  room: RoomState
  port: number
  /** The seated members, join order; `clients[0]` is the owner. */
  clients: ScriptedClient[]
  owner: ScriptedClient
  /** Everyone but the owner — the `not_controller` half of ADR-030. */
  guests: ScriptedClient[]
  /** One more member on the same listener (a late joiner, or the sixth). */
  join(name?: string, options?: ClientOptions): Promise<ScriptedClient>
  close(): Promise<void>
}

const DEFAULT_NAMES = ['sam', 'alex', 'robin', 'kit', 'jo']

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const now = options.now
  const room = createRoom(CODE, now)
  const server = createServer()
  const wss = attachRoomSocket(server, room, now === undefined ? {} : { now })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  const clients: ScriptedClient[] = []
  const clientOptions: ClientOptions = options.duration === undefined ? {} : { duration: options.duration }

  const join = async (name?: string, joinOptions: ClientOptions = {}): Promise<ScriptedClient> => {
    const client = await ScriptedClient.open(port, CODE, name ?? `member ${clients.length + 1}`, {
      ...clientOptions,
      ...joinOptions,
    })
    clients.push(client)
    return client
  }

  for (let index = 0; index < (options.clients ?? 3); index += 1) {
    await join(options.names?.[index] ?? DEFAULT_NAMES[index] ?? `member ${index + 1}`)
  }

  return {
    room,
    port,
    clients,
    get owner() {
      return clients[0] as ScriptedClient
    },
    get guests() {
      return clients.slice(1)
    },
    join,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()))
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())))
    },
  }
}

/**
 * Waits until `probe` returns something truthy, polling that value rather than
 * a frame: the harness never guesses what a player is looking at.
 */
export async function waitFor<T>(
  probe: () => T | null | undefined | false,
  timeoutMs = 2000,
  label = 'condition',
  stepMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() >= deadline) throw new Error(`${label} did not happen within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** A short quiet spell, for "and then nothing else happened". */
export const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Millis every frame this client is told about lands late (network lag). */
export function injectDelay(client: ScriptedClient, ms: number): void {
  client.clock.delayMs = ms
}

/** Makes this client's clock read `ms` behind the authority (T5's sign). */
export function injectSkew(client: ScriptedClient, ms: number): void {
  client.clock.skewMs = ms
}

/** Freezes this client's playhead for `seconds`, the way a buffering `<video>` does. */
export function injectStall(client: ScriptedClient, seconds: number): void {
  client.player.injectStall(seconds)
}
