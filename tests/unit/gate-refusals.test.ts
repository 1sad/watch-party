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

import { createSidecarServer, type RegisteredMedia } from '../../src/server/app.ts'
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
  options: {
    sharedSocket?: boolean
    isLocal?: (remoteAddress: string | undefined) => boolean
    media?: () => RegisteredMedia | null
  } = {},
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
    ...(options.media === undefined ? {} : { media: options.media }),
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

/**
 * T85: a packaged guest loads the page from its own sidecar, so it holds no
 * `wp_key` cookie for the owner's origin - the code must travel on the media
 * request itself (the link's `c`, exactly as `/join?c=` already carries it).
 * The door is unchanged for everyone else: no code is still the gate page and
 * is still free; a wrong one is refused and billed.
 */
test('a joined guest can fetch the room file, and the door still refuses everyone else', async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), 'watch-party-media-'))
  const mediaPath = join(mediaDir, 'clip.mp4')
  await writeFile(mediaPath, 'clip-bytes')

  try {
    await withDoor(
      async ({ base, log }) => {
        // Address only: the gate page, on the page route and on the media
        // route alike, and neither file bytes nor a refusal charge.
        const root = await fetch(`${base}/`)
        assert.equal(root.status, 403, 'GET / without the code is the gate')
        assert.match(await root.text(), /Enter the room code/)

        const bareMedia = await fetch(`${base}/media/f1`)
        assert.equal(bareMedia.status, 403, 'GET /media/<id> without the code is refused')
        const gateBody = await bareMedia.text()
        assert.match(gateBody, /Enter the room code/)
        assert.ok(!gateBody.includes('clip-bytes'), 'no file bytes reach a caller with no code')
        assert.equal(log.length, 0, 'a code-less media request is free, like a code-less page request')

        // The invite link still opens: 200, and the cookie it sets is the key
        // the page's own asset requests carry.
        const join = await fetch(`${base}/join?c=${CODE}`)
        assert.equal(join.status, 200, '/join?c=<code> still answers the page')
        assert.match(join.headers.get('set-cookie') ?? '', new RegExp(`wp_key=${CODE}`))

        // The guest's page asks for the file itself: no cookie on this origin,
        // the code on the URL. A `<video>`'s range request must be honoured.
        const guestMedia = await fetch(`${base}/media/f1?c=${CODE}`, {
          headers: { range: 'bytes=0-3' },
        })
        assert.equal(guestMedia.status, 206, 'the guest\'s media request is answered')
        assert.equal(await guestMedia.text(), 'clip')

        // A browser that did visit the owner's page still gets the cookie path.
        const cookieMedia = await fetch(`${base}/media/f1`, {
          headers: { cookie: `wp_key=${CODE}`, range: 'bytes=0-3' },
        })
        assert.equal(cookieMedia.status, 206, 'the cookie is still a key on the media route')

        // A wrong code is still refused, on the media route as on the door.
        const wrongMedia = await fetch(`${base}/media/f1?c=${WRONG}`)
        assert.equal(wrongMedia.status, 403, 'a wrong code on a media request is refused')
        assert.ok(!(await wrongMedia.text()).includes('clip-bytes'), 'a wrong code gets no bytes')

        // And a wrong code is still billed: twenty of them bar the address.
        for (let attempt = 1; attempt < ADDRESS_REFUSAL_LIMIT; attempt += 1) {
          await fetch(`${base}/media/f1?c=${WRONG}`)
        }
        assert.equal(log.filter((line) => line.startsWith('[gate]')).length, 1, 'the address was barred')
      },
      { media: () => ({ id: 'f1', path: mediaPath, contentType: 'video/mp4' }) },
    )
  } finally {
    await rm(mediaDir, { recursive: true, force: true })
  }
})
