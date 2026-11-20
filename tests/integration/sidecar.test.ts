import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The number-one integration fact of M1's first ticket: the sidecar is startable
// as its own process and its first stdout line is a port the page answers on.
// T6b adds the fixture: the page cannot play what the sidecar does not serve.
const root = fileURLToPath(new URL('../..', import.meta.url))

async function startSidecar(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['src/server/main.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const line = await new Promise<string>((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error(`no PORT line; saw ${JSON.stringify(buffered)}`)), 10_000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
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
  return { child, port: Number(match[1]) }
}

test('the sidecar process prints PORT <n> and serves /healthz on that port', async () => {
  const { child, port } = await startSidecar()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /^\d+\.\d+\.\d+/)
  } finally {
    child.kill()
  }
})

// T6b item 1: "served by the sidecar at /fixture". A `<video>` seeks by asking
// for a byte range from a keyframe, so the range response is the ticket's proof
// that a seek to 30 s is a seek and not a full download.
test('the sidecar serves the committed fixture at /fixture, with byte ranges', async () => {
  const { child, port } = await startSidecar()
  try {
    const head = await fetch(`http://127.0.0.1:${port}/fixture`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'video/mp4')
    assert.equal(head.headers.get('accept-ranges'), 'bytes')
    const size = Number(head.headers.get('content-length'))
    assert.ok(size > 0, 'the fixture file is there and has bytes')

    const range = await fetch(`http://127.0.0.1:${port}/fixture`, { headers: { range: 'bytes=0-99' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 0-99/${size}`)
    const body = new Uint8Array(await range.arrayBuffer())
    assert.equal(body.length, 100)
    assert.equal(String.fromCharCode(...body.slice(4, 8)), 'ftyp', 'these are the mp4’s own bytes')

    // A suffix range is not something the player sends; it is refused rather
    // than answered with a 200 the browser would mis-seek.
    const suffix = await fetch(`http://127.0.0.1:${port}/fixture`, { headers: { range: 'bytes=-500' } })
    assert.equal(suffix.status, 416)
  } finally {
    child.kill()
  }
})
