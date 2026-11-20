import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The number-one integration fact of M1's first ticket: the sidecar is startable
// as its own process and its first stdout line is a port the page answers on.
const root = fileURLToPath(new URL('../..', import.meta.url))

test('the sidecar process prints PORT <n> and serves /healthz on that port', async () => {
  const child = spawn(process.execPath, ['src/server/main.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => reject(new Error(`no PORT line; saw ${JSON.stringify(buffered)}`)), 10_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        const end = buffered.indexOf('\n')
        if (end !== -1) {
          clearTimeout(timer)
          resolve(buffered.slice(0, end))
        }
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    const match = /^PORT (\d+)$/.exec(line)
    assert.ok(match, `first line was ${JSON.stringify(line)}`)
    const port = Number(match[1])

    const response = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /^\d+\.\d+\.\d+/)
  } finally {
    child.kill()
  }
})
