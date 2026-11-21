// T8c's tool is a script, so its checks here are about the shell contract a
// later live check depends on: no endpoint means one line and an exit, never a
// hang, and a typo is a usage error rather than a missing window.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/cdp.mjs', import.meta.url))

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

function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.WP_DEBUG_PORT
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...env, ...overrides },
  })
}

test('targets says so in one line when no window is listening', async () => {
  const port = await closedPort()
  const result = run(['targets', '--port', String(port)])

  assert.equal(result.error, undefined, 'the script must finish, not hang')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')

  const lines = result.stderr.split(/\r?\n/).filter((line) => line !== '')
  assert.equal(lines.length, 1, `one line expected, got ${JSON.stringify(result.stderr)}`)
  assert.match(lines[0], new RegExp(`127\\.0\\.0\\.1:${port}`))
})

test('the port comes from WP_DEBUG_PORT unless --port overrides it', async () => {
  const fromEnvironment = await closedPort()
  const fromFlag = await closedPort()

  const viaEnvironment = run(['targets'], { WP_DEBUG_PORT: String(fromEnvironment) })
  assert.equal(viaEnvironment.status, 1)
  assert.match(viaEnvironment.stderr, new RegExp(`127\\.0\\.0\\.1:${fromEnvironment}`))

  const overridden = run(['targets', '--port', String(fromFlag)], {
    WP_DEBUG_PORT: String(fromEnvironment),
  })
  assert.equal(overridden.status, 1)
  assert.match(overridden.stderr, new RegExp(`127\\.0\\.0\\.1:${fromFlag}`))
})

test('a mistyped subcommand is a usage error, not a missing window', async () => {
  const port = await closedPort()
  const result = run(['screenshot', '0', 'page.png'], { WP_DEBUG_PORT: String(port) })

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /is not a subcommand/)
})
