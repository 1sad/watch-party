import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { get } from 'node:http'
import { fileURLToPath } from 'node:url'

import { createProbeServer } from '../fixtures/serve.ts'

const ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url))
const VIDEO = readFileSync(new URL('../fixtures/fixture.mp4', import.meta.url))

// testing-manual section 7 trap 3: a probe server that answers 200 with
// accept-ranges makes `video.seekable` read [0, 0], so every seek check lies.
// These cases are the server's own guarantee, not a live check's memory.

async function serve(run: (base: string, port: number) => Promise<void>): Promise<void> {
  const server = createProbeServer(ROOT)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`, address.port)
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}

/** The status of a request whose path is sent exactly as written, unnormalised. */
function rawStatus(port: number, path: string): Promise<number | undefined> {
  return new Promise((done, fail) => {
    get({ host: '127.0.0.1', port, path }, (response) => {
      response.resume()
      done(response.statusCode)
    }).on('error', fail)
  })
}

test('a range request is 206 with Content-Range and exactly those bytes', async () => {
  await serve(async (base) => {
    const response = await fetch(`${base}/fixture.mp4`, { headers: { range: 'bytes=0-99' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('content-range'), `bytes 0-99/${VIDEO.length}`)
    assert.equal(response.headers.get('content-length'), '100')
    const body = Buffer.from(await response.arrayBuffer())
    assert.equal(body.length, 100)
    assert.deepEqual(body, VIDEO.subarray(0, 100))
  })
})

test('an open-ended range runs to the last byte of the file', async () => {
  const start = VIDEO.length - 10
  await serve(async (base) => {
    const response = await fetch(`${base}/fixture.mp4`, { headers: { range: `bytes=${start}-` } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${VIDEO.length - 1}/${VIDEO.length}`)
    const body = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(body, VIDEO.subarray(start))
  })
})

test('no range is 200, and a range past the end is 416 rather than a trimmed 206', async () => {
  await serve(async (base) => {
    const whole = await fetch(`${base}/fixture.mp4`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.equal(whole.headers.get('content-length'), String(VIDEO.length))
    await whole.arrayBuffer()

    const beyond = await fetch(`${base}/fixture.mp4`, {
      headers: { range: `bytes=${VIDEO.length}-` },
    })
    assert.equal(beyond.status, 416)
    assert.equal(beyond.headers.get('content-range'), `bytes */${VIDEO.length}`)
    await beyond.arrayBuffer()
  })
})

test('the served directory holds the page, and a path outside it is refused', async () => {
  await serve(async (base, port) => {
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/)
    const html = await page.text()
    assert.match(html, /id="fullscreen"/)
    assert.match(html, /id="playpause"/)
    assert.match(html, /id="label"/)

    assert.equal(await rawStatus(port, '/../package.json'), 404)
    assert.equal(await rawStatus(port, '/%2e%2e/package.json'), 404)
  })
})
