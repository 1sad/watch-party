/**
 * T176 / R52: the page a browser guest can reload.
 *
 * A guest who reloads `/` is let in by the `wp_key` cookie (HttpOnly), and
 * `/discovery` - the only route that hands out the room's code to the app's own
 * window - answers loopback only (ADR-044). So the page the sidecar serves a
 * non-loopback caller carries the code itself, in one `<meta>` the page's
 * bootstrap reads before it would ask `/discovery` (`src/ui/served-code.ts`).
 *
 * These are the four cases the ticket names: the link's page, the cookie-only
 * reload, a bare request (which must get the gate page and no code), and this
 * machine's own window (which must get the built page byte for byte). The tag's
 * name is asserted through the page's own `ROOM_CODE_META`, so a rename on
 * either side fails here rather than in a browser.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { createSidecarServer } from '../../src/server/app.ts'
import { ROOM_CODE_META, servedRoomCode } from '../../src/ui/served-code.ts'

const CODE = 'ABC234'
const BUILT_PAGE =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <title>Watch Party</title>\n  </head>\n' +
  '  <body><div id="app"></div></body>\n</html>\n'

interface Door {
  base: string
}

/**
 * A sidecar with a built page, and a gate that treats the caller as a stranger
 * by default: a test always arrives from 127.0.0.1, which the gate would
 * otherwise read as the host's own window.
 */
async function withDoor(
  run: (door: Door) => Promise<void>,
  options: { loopback?: boolean } = {},
): Promise<void> {
  const distDir = await mkdtemp(join(tmpdir(), 'watch-party-code-'))
  await writeFile(join(distDir, 'index.html'), BUILT_PAGE)

  const server: Server = createSidecarServer({
    distDir,
    version: '9.9.9',
    start: () => ({ status: 'ready', roomCode: CODE }),
    isLocal: () => options.loopback === true,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  try {
    await run({ base: `http://127.0.0.1:${port}` })
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(distDir, { recursive: true, force: true })
  }
}

test('the page says the room code to a caller that arrived by the link', async () => {
  await withDoor(async ({ base }) => {
    const page = await fetch(`${base}/join?c=${CODE}`)
    assert.equal(page.status, 200, 'the invite link opens the gate')
    assert.match(page.headers.get('set-cookie') ?? '', new RegExp(`wp_key=${CODE}`))

    const body = await page.text()
    assert.ok(
      body.includes(`<meta name="${ROOM_CODE_META}" content="${CODE}">`),
      'the served page carries the room code in the tag the page reads',
    )
    assert.equal(
      Number(page.headers.get('content-length')),
      Buffer.byteLength(body),
      'the length is the substituted page\'s, not the built file\'s',
    )
    assert.equal(page.headers.get('cache-control'), 'no-store', 'nothing caches the substituted page')
  })
})

test('the page says the room code to a cookie-only reload', async () => {
  await withDoor(async ({ base }) => {
    const page = await fetch(`${base}/`, { headers: { cookie: `wp_key=${CODE}` } })
    assert.equal(page.status, 200, 'the key cookie opens the gate')
    assert.equal(page.headers.get('set-cookie'), null, 'a reload sets no second cookie')

    const body = await page.text()
    assert.ok(
      body.includes(`<meta name="${ROOM_CODE_META}" content="${CODE}">`),
      'the reloaded page carries the room code',
    )
  })
})

test('a bare request gets the gate page, and its body carries no room code', async () => {
  await withDoor(async ({ base }) => {
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 403)
    const body = await page.text()
    assert.match(body, /Enter the room code/)
    assert.ok(!body.includes(CODE), 'the gate page carries no room code')
    assert.ok(!body.includes(ROOM_CODE_META), 'and no tag the page would read')
  })
})

test('the app\'s own window gets the built page, byte for byte', async () => {
  await withDoor(
    async ({ base }) => {
      const page = await fetch(`${base}/`)
      assert.equal(page.status, 200, 'loopback is the host, and the gate lets it in')
      const body = await page.text()
      assert.equal(body, BUILT_PAGE, 'no substitution for this machine\'s own window')
      assert.ok(!body.includes(CODE), 'the loopback page carries no room code')
    },
    { loopback: true },
  )
})

test('the page reads only a real room code out of the tag', () => {
  assert.equal(servedRoomCode(CODE), CODE)
  assert.equal(servedRoomCode(` ${CODE.toLowerCase()} `), CODE)
  assert.equal(servedRoomCode(null), null, 'no tag, no code')
  assert.equal(servedRoomCode(''), null)
  assert.equal(servedRoomCode('AAA111'), null, 'not the room-code alphabet')
  assert.equal(servedRoomCode('ABC2345'), null, 'not the room-code length')
})
