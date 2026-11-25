/**
 * T177 / R56: the sentence a browser that cannot run the page keeps.
 *
 * The sidecar writes it into the served markup itself, so it is readable with
 * no bundle at all; the page removes it when its own code takes over
 * (`App.svelte`). The fixture page below carries **no `<script>` element at
 * all**, so finding the sentence in the response body proves no bundle was
 * needed to read it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { createSidecarServer } from '../../src/server/app.ts'
import { BOOT_SENTENCE, BOOT_SENTENCE_ID } from '../../src/ui/boot-sentence.ts'

const CODE = 'ABC234'
const BUILT_PAGE =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <title>Watch Party</title>\n  </head>\n' +
  '  <body><div id="app"></div></body>\n</html>\n'

async function withDoor(
  run: (base: string) => Promise<void>,
  options: { loopback?: boolean } = {},
): Promise<void> {
  const distDir = await mkdtemp(join(tmpdir(), 'watch-party-boot-'))
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
    await run(`http://127.0.0.1:${port}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(distDir, { recursive: true, force: true })
  }
}

test('the served page carries R56\'s sentence in its own markup, before the bundle', async () => {
  await withDoor(async (base) => {
    const page = await fetch(`${base}/join?c=${CODE}`)
    assert.equal(page.status, 200)
    const body = await page.text()

    assert.ok(body.includes(`id="${BOOT_SENTENCE_ID}"`), 'the line has the id the page removes')
    assert.ok(
      body.includes(`>${BOOT_SENTENCE}</p>`),
      'the sentence is visible text in the served markup, not a script string',
    )
    assert.ok(!body.includes('<script'), 'the fixture page has no bundle at all')
    assert.ok(
      body.indexOf(BOOT_SENTENCE) > body.indexOf('<body'),
      'the line sits in the body, where a browser draws it',
    )
    assert.ok(
      body.indexOf(BOOT_SENTENCE) < body.indexOf('</body>'),
      'and the browser reaches it before the page ends',
    )
  })
})

test('a reload served by the cookie carries the same sentence', async () => {
  await withDoor(async (base) => {
    const page = await fetch(`${base}/`, { headers: { cookie: `wp_key=${CODE}` } })
    assert.equal(page.status, 200)
    assert.ok((await page.text()).includes(BOOT_SENTENCE))
  })
})
