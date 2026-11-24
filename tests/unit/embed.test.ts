/**
 * Ticket 156, ADR-051: the sidecar serves the embed page for a YouTube room page
 * (`/embed/youtube.html?id=<id>`), and the page is built by the sidecar rather
 * than read from `dist/`, so the development copy and the packaged copy serve the
 * same bytes.
 *
 * What a browser proves is the live check; this is the cheap half: the url, the
 * id reaching `YT.Player`, the origin being the sidecar's own, the two player
 * flags, and the object a check and 156b's bridge call.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { createSidecarServer } from '../../src/server/app.ts'

const ID = 'aqz-KE-bpKQ'

async function fetchEmbed(path: string): Promise<{ status: number; type: string; body: string }> {
  const server = createSidecarServer({ distDir: process.cwd(), version: '9.9.9' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: await response.text(),
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('/embed/youtube.html?id=<id> serves a page that builds a YT.Player for that id', async () => {
  const page = await fetchEmbed(`/embed/youtube.html?id=${ID}`)
  assert.equal(page.status, 200)
  assert.match(page.type, /^text\/html/)
  // The API script, and the player built from the id.
  assert.match(page.body, /https:\/\/www\.youtube\.com\/iframe_api/)
  assert.match(page.body, /new YT\.Player\('player'/)
  assert.match(page.body, /var videoId = "aqz-KE-bpKQ"/)
  assert.match(page.body, /videoId: videoId/)
  // The API needs an http(s) origin and it must be this sidecar's own.
  assert.match(page.body, /origin: window\.location\.origin/)
  assert.match(page.body, /enablejsapi: 1/)
  assert.match(page.body, /playsinline: 1/)
})

test('the embed page carries window.__wpYouTube on its own document', async () => {
  const page = await fetchEmbed(`/embed/youtube.html?id=${ID}`)
  assert.match(page.body, /window\.__wpYouTube = \{/)
  for (const method of ['play', 'pause', 'seek', 'now', 'state', 'duration', 'setVolume']) {
    assert.match(page.body, new RegExp(`${method}: function \\(`), method)
  }
})

test('an id that is not eleven characters gets a page with no player', async () => {
  const page = await fetchEmbed('/embed/youtube.html?id=not-an-id')
  assert.equal(page.status, 200)
  assert.match(page.body, /var videoId = ""/)
  assert.match(page.body, /No video\./)
})

test('a non-GET method on the embed path is refused, not served', async () => {
  const server = createSidecarServer({ distDir: process.cwd(), version: '9.9.9' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${port}/embed/youtube.html?id=${ID}`, { method: 'POST' })
    assert.equal(response.status, 405)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
