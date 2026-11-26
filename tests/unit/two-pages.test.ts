// T188's tool is a script, so its checks here cover the two things a live run
// cannot make deterministic: the exact row a sample prints and how the worst
// gap is chosen. The refusal contract (a closed port is one line and exit 1)
// is also pinned, the way cdp.test.ts pins cdp.mjs's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import { fixed, formatRow, formatSummary, show, worstSample } from '../../scripts/two-pages-format.ts'

const script = fileURLToPath(new URL('../../scripts/two-pages.mjs', import.meta.url))

/** A loopback port nothing is listening on: opened for real, read, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port
  await new Promise<void>((closed) => server.close(() => closed()))
  return port
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env },
  })
}

test('a row is a.now a.state b.now b.state gap, four decimals, sign kept', () => {
  const row = formatRow({ index: 0, aNow: 10, aState: 'paused', bNow: 12.4, bState: 'playing', gap: 2.4 })
  assert.equal(row, '0 a.now=10.0000 a.state=paused b.now=12.4000 b.state=playing gap=2.4000')
})

test('the worst gap is the sample farthest from zero, not the most negative', () => {
  const samples = [
    { index: 0, aNow: 0, aState: null, bNow: 0, bState: null, gap: 0.5 },
    { index: 1, aNow: 0, aState: null, bNow: 0, bState: null, gap: -2.4 },
    { index: 2, aNow: 0, aState: null, bNow: 0, bState: null, gap: 0.1 },
  ]

  const worst = worstSample(samples)
  assert.equal(worst?.index, 1)
  assert.equal(worst?.gap, -2.4)
  assert.equal(formatSummary(worst), 'worst gap -2.4000 at sample 1')
  assert.equal(formatSummary(null), 'no samples')
})

test('a state prints as itself: string, number, boolean, object, nothing', () => {
  assert.equal(show('paused'), 'paused')
  assert.equal(show(1), '1')
  assert.equal(show(true), 'true')
  assert.equal(show({ x: 1 }), '{"x":1}')
  assert.equal(show(null), '')
})

test('numbers print with four decimals', () => {
  assert.equal(fixed(25.914925), '25.9149')
  assert.equal(fixed(0.009766), '0.0098')
  assert.equal(fixed(-2.4), '-2.4000')
})

test('a closed port is one line and exit 1, no stack trace', async () => {
  const a = await closedPort()
  const b = await closedPort()
  const result = run(['--port', String(a), '--port', String(b), '--eval', '({now: 1, state: 1})'])

  assert.equal(result.error, undefined, 'the script must finish, not hang')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')

  const lines = result.stderr.split(/\r?\n/).filter((line) => line !== '')
  assert.equal(lines.length, 1, `one line expected, got ${JSON.stringify(result.stderr)}`)
  assert.match(lines[0], /no DevTools endpoint on 127\.0\.0\.1:\d+/)
  assert.ok(lines[0].includes(`:${a}`) || lines[0].includes(`:${b}`), `the line should name a closed port, got ${lines[0]}`)
})

test('a missing --eval is a usage error, not a missing window', () => {
  const result = run([])

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--eval is required/)
})
