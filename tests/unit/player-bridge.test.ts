/**
 * Ticket 05: the frame side of the bridge, run for real.
 *
 * `src/shared/player-bridge.js` is injected into every frame of the site view as
 * text, so it cannot be imported; it is read here exactly as the sidecar serves
 * it and run against a fake document. What is proved: one report at DOM ready
 * carrying the fields the scoring reads, the once-a-second poll, a change posting
 * sooner than the poll, an `emptied`/`loadstart` posting the element's own id —
 * and that only the two kinds the relay accepts ever leave the frame.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PLAYER_MESSAGE_KINDS } from '../../src/shared/player.ts'

const source = readFileSync(new URL('../../src/shared/player-bridge.js', import.meta.url), 'utf8')
const HREF = 'https://plyr.animex.one/embed/G1x?t=80'

type Listener = (event: { type: string }) => void

interface FakeVideo {
  w: number
  h: number
  readyState: number
  src: string
  paused: boolean
  ended: boolean
  duration: number
  currentTime: number
  listeners: Map<string, Listener[]>
  getBoundingClientRect(): { width: number; height: number }
  addEventListener(name: string, listener: Listener): void
}

function video(over: Partial<FakeVideo> = {}): FakeVideo {
  return {
    w: 842,
    h: 474,
    readyState: 4,
    src: 'blob:https://plyr.animex.one/1',
    paused: false,
    ended: false,
    duration: 1420.0436,
    currentTime: 80.2,
    listeners: new Map<string, Listener[]>(),
    getBoundingClientRect() {
      return { width: this.w, height: this.h }
    },
    addEventListener(name: string, listener: Listener) {
      const listeners = this.listeners.get(name) ?? []
      listeners.push(listener)
      this.listeners.set(name, listeners)
    },
    ...over,
  }
}

function harness(videos: FakeVideo[]) {
  const posted: Array<Record<string, unknown>> = []
  const intervals: Array<() => void> = []
  let clock = 1_000_000

  const document = {
    readyState: 'complete',
    querySelectorAll: (selector: string) => (selector === 'video' ? videos : []),
    addEventListener: () => {},
  }
  const window = {
    chrome: { webview: { postMessage: (message: Record<string, unknown>) => posted.push(message) } },
  }

  // The five names the bridge reads from its surroundings are parameters, so a
  // fake document and a fake clock replace the browser's own.
  const run = new Function('window', 'document', 'location', 'setInterval', 'Date', source)
  run(window, document, { href: HREF }, (tick: () => void) => intervals.push(tick), {
    now: () => clock,
  })

  return {
    posted,
    tick() {
      for (const interval of intervals) interval()
    },
    advance(ms: number) {
      clock += ms
    },
  }
}

test('a frame with one playing video posts one report, with the fields the scoring reads', () => {
  const bridge = harness([video()])
  assert.equal(bridge.posted.length, 1)

  const report = bridge.posted[0]
  assert.equal(report?.kind, 'playerReport')
  assert.equal(report?.href, HREF)
  assert.equal(report?.seq, 1)
  assert.deepEqual(report?.candidates, [
    { id: 1, w: 842, h: 474, readyState: 4, hasSrc: true, playing: true, duration: 1420.0436, t: 80.2 },
  ])
})

test('a frame with no videos still reports: an empty candidate list', () => {
  const bridge = harness([])
  assert.equal(bridge.posted.length, 1)
  assert.deepEqual(bridge.posted[0]?.candidates, [])
})

test('the poll posts once a second; a changed set posts sooner', () => {
  const element = video()
  const bridge = harness([element])
  const before = bridge.posted.length

  bridge.advance(500)
  bridge.tick()
  assert.equal(bridge.posted.length, before, 'the same set inside the second is not a second message')

  bridge.advance(500)
  bridge.tick()
  assert.equal(bridge.posted.length, before + 1, 'one second later it is')

  element.paused = true
  bridge.advance(300)
  bridge.tick()
  assert.equal(bridge.posted.length, before + 2, 'a change does not wait for the poll')
  assert.equal((bridge.posted[before + 1]?.candidates as Array<{ playing: boolean }>)[0]?.playing, false)
})

test('emptied and loadstart post the element\'s own id, once between the two', () => {
  const element = video()
  const bridge = harness([element])
  element.listeners.get('emptied')?.[0]?.({ type: 'emptied' })
  element.listeners.get('loadstart')?.[0]?.({ type: 'loadstart' })

  assert.equal(bridge.posted.length, 2, 'the pair is one reload, and one message')
  const event = bridge.posted[1]
  assert.equal(event?.kind, 'playerEvent')
  assert.equal(event?.event, 'emptied')
  assert.equal(event?.id, 1)
  assert.equal(event?.href, HREF)
})

test('only the two kinds the relay accepts ever leave the frame', () => {
  const element = video()
  const bridge = harness([element])
  element.listeners.get('emptied')?.[0]?.({ type: 'emptied' })
  element.paused = true
  bridge.advance(1_000)
  bridge.tick()

  assert.ok(bridge.posted.length >= 3)
  for (const message of bridge.posted) {
    assert.ok(
      (PLAYER_MESSAGE_KINDS as readonly string[]).includes(String(message.kind)),
      `the frame posted ${String(message.kind)}`,
    )
  }
})
