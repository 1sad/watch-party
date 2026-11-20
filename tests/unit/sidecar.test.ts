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
  extra: Pick<Partial<SidecarOptions>, 'start' | 'retryDiscovery'> = {},
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
