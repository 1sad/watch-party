/**
 * T71: a wrong code over the HTTP gate is no longer free.
 *
 * T68 built the refusal book beside the socket door; the invite link, though,
 * lands on `/join?c=` and that door was charged nothing. These tests drive the
 * HTTP door the way the live check does - from an address that is not this
 * machine's loopback - with the book handed in, so the numbers are the same
 * `SOCKET_REFUSAL_LIMIT` / `ADDRESS_REFUSAL_LIMIT` / `ADDRESS_BLOCK_MS` the
 * socket path uses.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { createSidecarServer } from '../../src/server/app.ts'
import { createRoom } from '../../src/server/room.ts'
import {
  ADDRESS_BLOCK_MS,
  ADDRESS_REFUSAL_LIMIT,
  attachRoomSocket,
  createRefusalBook,
  type RefusalBook,
} from '../../src/server/socket.ts'
import { ScriptedClient } from '../support/client.ts'

const CODE = 'ABC234'
const WRONG = 'AAAAAA'

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

interface Door {
  base: string
  port: number
  book: RefusalBook
  clock: ReturnType<typeof fakeClock>
  log: string[]
}

/**
 * A sidecar with a built page and, by default, the gate treating this test's
 * caller as a stranger (a test always arrives from 127.0.0.1, which would
 * otherwise be the host's own window). The room socket can share the listener
 * so one test can prove the book is common to both doors.
 */
async function withDoor(
  run: (door: Door) => Promise<void>,
  options: { sharedSocket?: boolean; isLocal?: (remoteAddress: string | undefined) => boolean } = {},
): Promise<void> {
  const distDir = await mkdtemp(join(tmpdir(), 'watch-party-gate-'))
  await writeFile(join(distDir, 'index.html'), '<!doctype html><h1>Watch Party</h1>')
  await writeFile(join(distDir, 'app.js'), 'export const ok = true\n')

  const clock = fakeClock()
  const book = createRefusalBook(clock.now)
  const log: string[] = []

  const server: Server = createSidecarServer({
    distDir,
    version: '9.9.9',
    start: () => ({ status: 'ready', roomCode: CODE }),
    refusals: book,
    isLocal: options.isLocal ?? (() => false),
    log: (line) => log.push(line),
  })
  const room = createRoom(CODE, clock.now)
  if (options.sharedSocket === true) {
    attachRoomSocket(server, room, { refusals: book, log: (line) => log.push(line) })
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  try {
    await run({ base: `http://127.0.0.1:${port}`, port, book, clock, log })
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(distDir, { recursive: true, force: true })
  }
}

test('a wrong code at /join is billed, and a barred address stays refused even for the real code', async () => {
  await withDoor(async ({ base, book, clock, log }) => {
    for (let attempt = 1; attempt < ADDRESS_REFUSAL_LIMIT; attempt += 1) {
      const response = await fetch(`${base}/join?c=${WRONG}`)
      assert.equal(response.status, 403, `wrong attempt ${attempt} is the gate page`)
      assert.match(await response.text(), /Enter the room code/)
    }
    assert.deepEqual(log, [], 'nineteen wrong codes are not yet a block')

    // A request that presents no code at all is free: it neither answers nor
    // bills differently from any other gate page.
    const noCode = await fetch(`${base}/`)
    assert.equal(noCode.status, 403)
    assert.match(await noCode.text(), /Enter the room code/)
    assert.deepEqual(log, [], 'a code-less request added no refusal')

    const twentieth = await fetch(`${base}/join?c=${WRONG}`)
    assert.equal(twentieth.status, 403)
    assert.equal(log.length, 1, 'the twentieth wrong code is the first bill, so the code-less call was free')
    const line = log[0] ?? ''
    assert.match(line, /^\[gate\] address refused for 60s refusals=20 addr=\S+$/)
    assert.ok(/^[\x20-\x7e]+$/.test(line), 'the gate line is ASCII')
    const address = /addr=(\S+)$/.exec(line)?.[1] ?? ''
    assert.equal(book.blocked(address), true, 'the shared book bars this address')

    // Already barred: the attempt is answered without a second bill.
    const twentyFirst = await fetch(`${base}/join?c=${WRONG}`)
    assert.equal(twentyFirst.status, 403)
    assert.equal(log.length, 1, 'a barred address is not billed again')

    // The real code does not open the door while the bar is up.
    const real = await fetch(`${base}/join?c=${CODE}`)
    assert.equal(real.status, 403, 'the real code is refused while the address is barred')
    assert.match(await real.text(), /Enter the room code/)
    assert.equal(real.headers.get('set-cookie'), null, 'a barred address gets no key cookie')

    // The bar is a minute, and then the same link works again.
    clock.advance(ADDRESS_BLOCK_MS)
    const later = await fetch(`${base}/join?c=${CODE}`)
    assert.equal(later.status, 200)
    assert.match(later.headers.get('set-cookie') ?? '', new RegExp(`wp_key=${CODE}`))
  })
})

test('the host\'s own loopback window is never billed, whatever code it carries', async () => {
  await withDoor(
    async ({ base, book, log }) => {
      for (let attempt = 0; attempt <= ADDRESS_REFUSAL_LIMIT; attempt += 1) {
        const response = await fetch(`${base}/join?c=${WRONG}`)
        assert.equal(response.status, 200, 'loopback is the host, and the gate lets it in')
      }
      assert.deepEqual(log, [], 'the host window wrote no refusal line')
      assert.equal(book.blocked('127.0.0.1'), false, 'the host address is not barred')
    },
    { isLocal: (remoteAddress) => (remoteAddress ?? '').startsWith('127.') },
  )
})

test('a bar set over the HTTP door also holds the socket door', async () => {
  await withDoor(
    async ({ base, port, book }) => {
      for (let attempt = 0; attempt < ADDRESS_REFUSAL_LIMIT; attempt += 1) {
        await fetch(`${base}/join?c=${WRONG}`)
      }
      const refused = await ScriptedClient.attempt(port, CODE, 'late guest')
      assert.equal(refused.ok, false, 'the socket door sees the HTTP door\'s bar')
      if (!refused.ok) assert.equal(refused.error.code, 'bad_room')
      assert.equal(book.blocked('127.0.0.1'), true)
    },
    { sharedSocket: true },
  )
})
