import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { createSidecarServer } from '../../src/server/app.ts'
import type { SidecarOptions } from '../../src/server/app.ts'

async function withBuiltPage(
  run: (base: string, distDir: string) => Promise<void>,
  extra: Partial<SidecarOptions> = {},
): Promise<void> {
  const distDir = await mkdtemp(join(tmpdir(), 'watch-party-dist-'))
  await mkdir(join(distDir, 'assets'))
  await writeFile(join(distDir, 'index.html'), '<!doctype html><h1>Watch Party</h1>')
  await writeFile(join(distDir, 'assets', 'app.js'), 'export const ok = true\n')

  const server: Server = createSidecarServer({ distDir, version: '9.9.9', ...extra })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  try {
    await run(`http://127.0.0.1:${port}`, distDir)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(distDir, { recursive: true, force: true })
  }
}

test('/healthz answers with the version string and nothing else', async () => {
  await withBuiltPage(async (base) => {
    const response = await fetch(`${base}/healthz`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '9.9.9')
  })
})

test('/ serves the built page, and its assets are served too', async () => {
  await withBuiltPage(async (base) => {
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await page.text(), /Watch Party/)

    const asset = await fetch(`${base}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') ?? '', /^text\/javascript/)
  })
})

test('an unknown path is a 404, and so is a path trying to leave dist/', async () => {
  await withBuiltPage(async (base) => {
    const missing = await fetch(`${base}/nope.js`)
    assert.equal(missing.status, 404)

    // Encoded so the request reaches the server as one path segment.
    const escape = await fetch(`${base}/..%2f..%2fpackage.json`)
    assert.equal(escape.status, 404)
  })
})

test('/join?c=<code> serves the page itself, so the LAN address is a real door', async () => {
  await withBuiltPage(async (base) => {
    const page = await fetch(`${base}/join?c=ABC234`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await page.text(), /Watch Party/)
  })
})

test('/discovery hands the page its start state, and retry is a POST', async () => {
  let retried = 0
  await withBuiltPage(
    async (base) => {
      const state = await fetch(`${base}/discovery`)
      assert.equal(state.status, 200)
      assert.match(state.headers.get('content-type') ?? '', /^application\/json/)
      assert.deepEqual(await state.json(), { status: 'pending', roomCode: 'ABC234' })

      const wrongMethod = await fetch(`${base}/discovery/retry`)
      assert.equal(wrongMethod.status, 405)

      const retry = await fetch(`${base}/discovery/retry`, { method: 'POST' })
      assert.equal(retry.status, 202)
      assert.equal(retried, 1)
    },
    {
      start: () => ({ status: 'pending', roomCode: 'ABC234' }),
      retryDiscovery: () => {
        retried += 1
      },
    },
  )
})

test('/media/<id> streams the one registered file in ranges, and refuses every other id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-party-media-'))
  const mediaPath = join(dir, 'clip.mp4')
  const bytes = Buffer.alloc(1000)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
  await writeFile(mediaPath, bytes)

  const log: string[] = []
  const registered = { id: 'f1', path: mediaPath, contentType: 'video/mp4' }

  try {
    await withBuiltPage(
      async (base) => {
        const ranged = await fetch(`${base}/media/f1`, { headers: { range: 'bytes=100-200' } })
        assert.equal(ranged.status, 206)
        assert.equal(ranged.headers.get('content-range'), 'bytes 100-200/1000')
        assert.equal(ranged.headers.get('content-length'), '101')
        assert.equal(ranged.headers.get('accept-ranges'), 'bytes')
        assert.equal(ranged.headers.get('content-type'), 'video/mp4')
        assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(100, 201))

        // `bytes=0-` is a satisfiable range, so it is answered as one: 206
        // covering the whole file, never a 200 (RFC 9110 §14.4).
        const fromStart = await fetch(`${base}/media/f1`, { headers: { range: 'bytes=0-' } })
        assert.equal(fromStart.status, 206)
        assert.equal(fromStart.headers.get('content-range'), 'bytes 0-999/1000')

        const noRange = await fetch(`${base}/media/f1`)
        assert.equal(noRange.status, 200)
        assert.equal(noRange.headers.get('content-length'), '1000')

        const unreadable = await fetch(`${base}/media/f1`, { headers: { range: 'bytes=nonsense' } })
        assert.equal(unreadable.status, 200)
        assert.equal(unreadable.headers.get('content-length'), '1000')

        const pastEnd = await fetch(`${base}/media/f1`, { headers: { range: 'bytes=1000-' } })
        assert.equal(pastEnd.status, 416)
        assert.equal(pastEnd.headers.get('content-range'), 'bytes */1000')

        // The URL names an id, never a path: another id is simply not there.
        const other = await fetch(`${base}/media/not-registered`)
        assert.equal(other.status, 404)
        const traversal = await fetch(`${base}/media/..%2f..%2fpackage.json`)
        assert.equal(traversal.status, 404)
      },
      { media: () => registered, log: (line) => log.push(line) },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  assert.deepEqual(log, [
    '[media] id=f1 status=206 range=bytes=100-200',
    '[media] id=f1 status=206 range=bytes=0-',
    '[media] id=f1 status=200 range=-',
    '[media] id=f1 status=200 range=bytes=nonsense',
    '[media] id=f1 status=416 range=bytes=1000-',
    '[media] id=not-registered status=404 range=-',
    '[media] id=../../package.json status=404 range=-',
  ])
})
