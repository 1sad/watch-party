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

async function serve(
  run: (base: string, port: number) => Promise<void>,
  log?: (line: string) => void,
): Promise<void> {
  const server = createProbeServer(ROOT, log)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`, address.port)
  } finally {
    // Close the sockets the test opened rather than waiting out the client's
    // keep-alive timer: a small page can finish before the client marks the
    // socket idle, and close() would then sit on it for three seconds.
    server.closeAllConnections()
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

test('the loop page is served whole, and leaves again on every load', async () => {
  await serve(async (base) => {
    const page = await fetch(`${base}/probe-loop.html`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/)
    const html = await page.text()
    // The marker a live check reads, and the leaving itself: one
    // location.replace with this address and a larger n, so a page put back
    // leaves again (T144, T147).
    assert.match(html, /leaving/)
    assert.match(html, /location\.replace/)
    assert.match(html, /searchParams\.set\('n'/)

    const second = await fetch(`${base}/probe-loop.html?n=2`)
    assert.equal(second.status, 200)
  })
})

test('the swap page is served with its player, its swap button and its readout', async () => {
  await serve(async (base) => {
    const page = await fetch(`${base}/probe-swap.html`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/)
    const html = await page.text()
    // #swap is the marker; #now is what a check reads after the element is
    // replaced, and it sits outside the replaced element (T144, T145, T146).
    assert.match(html, /id="swap"/)
    assert.match(html, /id="now"/)
    assert.match(html, /fixture\.mp4/)
  })
})

test('the probe page carries the plays counter in both blockplay modes', async () => {
  await serve(async (base) => {
    for (const mode of ['1', 'all']) {
      const page = await fetch(`${base}/probe.html?blockplay=${mode}`)
      assert.equal(page.status, 200)
      const html = await page.text()
      assert.match(html, /id="plays"/, `blockplay=${mode} lost #plays`)
      assert.match(html, /NotAllowedError/, `blockplay=${mode} does not refuse a play`)
    }
    // No query string: the page is the one earlier checks point at.
    const plain = await fetch(`${base}/probe.html`)
    assert.equal(plain.status, 200)
    assert.match(await plain.text(), /id="fullscreen"/)
  })
})

test('every answer names the path it served, query included', async () => {
  const lines: string[] = []
  await serve(async (base, port) => {
    const page = await fetch(`${base}/probe-loop.html?n=2`)
    await page.arrayBuffer()
    // The loop page's own navigation is a request for itself with a larger n;
    // the app's requests are the ones without it (T144, item 4).
    assert.ok(
      lines.includes('probe: 200 GET /probe-loop.html?n=2'),
      `the log did not name that path:\n${lines.join('\n')}`,
    )

    const shorthand = await fetch(`${base}/`)
    await shorthand.arrayBuffer()
    assert.ok(
      lines.includes('probe: 200 GET /probe.html'),
      `the log named the shorthand rather than the file:\n${lines.join('\n')}`,
    )

    await rawStatus(port, '/nope.html')
    assert.ok(
      lines.includes('probe: 404 GET /nope.html'),
      `the log did not name the missing path:\n${lines.join('\n')}`,
    )
  }, (line) => lines.push(line))
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
