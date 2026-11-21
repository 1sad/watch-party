/**
 * Ticket 05: the frame side of the bridge, run for real. Ticket 06 adds the
 * room's half: a posted command moves only its own element, and the element's
 * own play/pause/seeked are posted back for the app view to judge (§6.6).
 *
 * `src/shared/player-bridge.js` is injected into every frame of the site view as
 * text, so it cannot be imported; it is read here exactly as the sidecar serves
 * it and run against a fake document. What is proved: one report at DOM ready
 * carrying the scoring's fields and §5's report fields, the poll's two rates, a
 * change posting sooner than the poll, an `emptied`/`loadstart` posting the
 * element's own id, the command path (play, pause, a scheduled beat, a foreign
 * href), the five events the app view turns into commands or lines — and that
 * only the two kinds the relay accepts ever leave the frame.
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
  playbackRate: number
  buffered: { length: number; end(index: number): number }
  played: number
  pausedCalls: number
  /** T17: the DOM fact the bridge reads on a pause; absent means connected. */
  isConnected?: boolean
  listeners: Map<string, Listener[]>
  getBoundingClientRect(): { width: number; height: number }
  addEventListener(name: string, listener: Listener): void
  play(): Promise<void>
  pause(): void
}

function video(over: Partial<FakeVideo> = {}): FakeVideo {
  const element: FakeVideo = {
    w: 842,
    h: 474,
    readyState: 4,
    src: 'blob:https://plyr.animex.one/1',
    paused: false,
    ended: false,
    duration: 1420.0436,
    currentTime: 80.2,
    playbackRate: 1,
    buffered: { length: 1, end: () => 1400.5 },
    played: 0,
    pausedCalls: 0,
    listeners: new Map<string, Listener[]>(),
    getBoundingClientRect() {
      return { width: this.w, height: this.h }
    },
    addEventListener(name: string, listener: Listener) {
      const listeners = this.listeners.get(name) ?? []
      listeners.push(listener)
      this.listeners.set(name, listeners)
    },
    play() {
      this.played += 1
      this.paused = false
      return Promise.resolve()
    },
    pause() {
      this.pausedCalls += 1
      this.paused = true
    },
    ...over,
  }
  return element
}

/** One message the bridge posted, as the harness keeps it. */
type Posted = Record<string, unknown>

function harness(videos: FakeVideo[]) {
  const posted: Posted[] = []
  const intervals: Array<() => void> = []
  const timers: Array<{ id: number; run: () => void; live: boolean }> = []
  const hostListeners: Array<(event: { data?: unknown }) => void> = []
  let nextTimer = 1
  let clock = 1_000_000

  const document = {
    readyState: 'complete',
    querySelectorAll: (selector: string) => (selector === 'video' ? videos : []),
    addEventListener: () => {},
    // The fake page has no focus, which is the paused-rate case.
    hasFocus: () => false,
  }
  const window = {
    chrome: {
      webview: {
        postMessage: (message: Posted) => posted.push(message),
        addEventListener: (_name: string, listener: (event: { data?: unknown }) => void) => {
          hostListeners.push(listener)
        },
      },
    },
  }

  // The seven names the bridge reads from its surroundings are parameters, so a
  // fake document, a fake clock, a fake timer queue and its `clearTimeout`
  // replace the browser's own.
  const run = new Function(
    'window',
    'document',
    'location',
    'setInterval',
    'setTimeout',
    'clearTimeout',
    'Date',
    source,
  )
  run(
    window,
    document,
    { href: HREF },
    (tick: () => void) => intervals.push(tick),
    (timer: () => void) => {
      const id = nextTimer
      nextTimer += 1
      timers.push({ id, run: timer, live: true })
      return id
    },
    (id: number) => {
      for (const timer of timers) {
        if (timer.id === id) timer.live = false
      }
    },
    { now: () => clock },
  )

  return {
    posted,
    /** One `siteCommand` as the host posts it into the frame. */
    command(payload: Posted) {
      for (const listener of hostListeners) {
        listener({ data: { kind: 'siteCommand', payload } })
      }
    },
    tick() {
      for (const interval of intervals) interval()
    },
    /** Run the bridge's pending `setTimeout` beats; a cancelled one does not run. */
    flush() {
      while (timers.length > 0) {
        const timer = timers.shift()
        if (timer?.live) timer.run()
      }
    },
    advance(ms: number) {
      clock += ms
    },
  }
}

/** The one message of this event name, or a failed assertion naming what arrived. */
function eventOf(posted: Posted[], name: string): Posted {
  const found = posted.find((message) => message.kind === 'playerEvent' && message.event === name)
  assert.ok(found, `no ${name} event arrived; posted ${JSON.stringify(posted)}`)
  return found
}

test('a frame with one playing video posts one report, with the fields the scoring reads', () => {
  const bridge = harness([video()])
  assert.equal(bridge.posted.length, 1)

  const report = bridge.posted[0]
  assert.equal(report?.kind, 'playerReport')
  assert.equal(report?.href, HREF)
  assert.equal(report?.seq, 1)
  assert.deepEqual(report?.candidates, [
    {
      id: 1,
      w: 842,
      h: 474,
      readyState: 4,
      hasSrc: true,
      playing: true,
      duration: 1420.0436,
      t: 80.2,
      // T06: §5's `report` fields, measured on the element itself.
      paused: false,
      buffered: 1400.5,
      rate: 1,
    },
  ])
})

test('a frame with no videos still reports: an empty candidate list', () => {
  const bridge = harness([])
  assert.equal(bridge.posted.length, 1)
  assert.deepEqual(bridge.posted[0]?.candidates, [])
})

test('a playing candidate is reported twice a second; a paused, unfocused one once', () => {
  const element = video()
  const bridge = harness([element])
  const before = bridge.posted.length

  bridge.advance(500)
  bridge.tick()
  assert.equal(bridge.posted.length, before + 1, 'while playing, half a second is a report')

  bridge.advance(500)
  bridge.tick()
  assert.equal(bridge.posted.length, before + 2, 'and the next one')

  element.paused = true
  bridge.advance(300)
  bridge.tick()
  assert.equal(bridge.posted.length, before + 3, 'a change does not wait for the poll')
  assert.equal(
    ((bridge.posted[before + 2]?.candidates as Array<{ playing: boolean }>) ?? [])[0]?.playing,
    false,
  )

  bridge.advance(500)
  bridge.tick()
  assert.equal(bridge.posted.length, before + 3, 'paused and unfocused, half a second is not')
  bridge.advance(500)
  bridge.tick()
  assert.equal(bridge.posted.length, before + 4, 'a full second is')
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
  bridge.command({ kind: 'playerCommand', href: HREF, id: 1, action: 'pause', reason: 'pause', revision: 2 })
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

test('a play command puts the playhead where the room says, then plays, and says where it was', () => {
  const element = video({ paused: true, currentTime: 10 })
  const bridge = harness([element])
  bridge.posted.length = 0

  bridge.command({
    kind: 'playerCommand',
    source: HREF,
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    target: 600.5,
    revision: 7,
  })

  assert.equal(element.currentTime, 600.5, 'the playhead moved before play()')
  assert.equal(element.played, 1, 'and then it played')
  const applied = eventOf(bridge.posted, 'applied')
  assert.equal(applied.action, 'play')
  assert.equal(applied.reason, 'play')
  assert.equal(applied.target, 600.5)
  assert.equal(applied.from, 10, 'the pre-command position, measured here')
})

test('a pause command pauses the element and reports the position it was at', () => {
  const element = video({ paused: false, currentTime: 84.01 })
  const bridge = harness([element])
  bridge.posted.length = 0

  bridge.command({ kind: 'playerCommand', href: HREF, id: 1, reason: 'pause', action: 'pause', revision: 8 })

  assert.equal(element.paused, true)
  assert.equal(element.pausedCalls, 1)
  const applied = eventOf(bridge.posted, 'applied')
  assert.equal(applied.action, 'pause')
  assert.equal(applied.from, 84.01)
})

test('a scheduled play seeks now and plays at the beat the room named', () => {
  const element = video({ paused: true, currentTime: 0 })
  const bridge = harness([element])
  bridge.posted.length = 0

  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    target: 300,
    leadMs: 1500,
    revision: 9,
  })

  assert.equal(element.currentTime, 300, 'the playhead is placed before the wait')
  assert.equal(element.played, 0, 'and play() waits for the beat')
  bridge.flush()
  assert.equal(element.played, 1)
})

test('a scheduled play holds an element that is already playing, then plays at the beat', () => {
  const element = video({ paused: false, currentTime: 300 })
  const bridge = harness([element])
  bridge.posted.length = 0

  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    leadMs: 1500,
    revision: 10,
  })

  assert.equal(element.paused, true, 'never "play now": the playing window is held')
  assert.equal(element.played, 0)
  bridge.flush()
  assert.equal(element.played, 1, 'and started at the beat')
})

test('a command for another frame\'s href, or an id this frame does not have, changes nothing', () => {
  const element = video({ paused: false, currentTime: 12 })
  const bridge = harness([element])
  bridge.posted.length = 0

  bridge.command({ kind: 'playerCommand', href: 'https://other.example/e/1', id: 1, action: 'pause', revision: 3 })
  bridge.command({ kind: 'playerCommand', href: HREF, id: 99, action: 'pause', revision: 4 })

  assert.equal(element.pausedCalls, 0)
  assert.equal(bridge.posted.length, 0)
})

test('play, pause and seeked are posted with the element id, and seeked says what it was doing', () => {
  const element = video({ paused: false, currentTime: 41.5 })
  const bridge = harness([element])
  bridge.posted.length = 0

  element.listeners.get('play')?.[0]?.({ type: 'play' })
  element.listeners.get('pause')?.[0]?.({ type: 'pause' })
  element.listeners.get('seeking')?.[0]?.({ type: 'seeking' })
  element.currentTime = 50
  element.listeners.get('seeked')?.[0]?.({ type: 'seeked' })

  const play = eventOf(bridge.posted, 'play')
  assert.equal(play.id, 1)
  assert.equal(play.t, 41.5)
  const pause = eventOf(bridge.posted, 'pause')
  assert.equal(pause.id, 1)
  const seeked = eventOf(bridge.posted, 'seeked')
  assert.equal(seeked.t, 50)
  assert.equal(seeked.wasPlaying, true, 'the element was playing when the seek began (§5)')
})

// ---- T15: provenance, and a hold a later command can cancel ----

test('a hold\'s pause says the bridge caused it, and a person\'s pause says it did not', () => {
  const held = video({ paused: false, currentTime: 300 })
  const bridge = harness([held])
  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    leadMs: 1500,
    revision: 20,
  })
  assert.equal(held.paused, true, 'the scheduled start holds a playing element')
  held.listeners.get('pause')?.[0]?.({ type: 'pause' })
  assert.equal(eventOf(bridge.posted, 'pause').caused, true, 'ours: the app must not read it as a person')

  // The same event on an element nothing here touched is a person's, untagged
  // by this frame, so §6.6's rule still sees it.
  const pressed = video({ paused: false })
  const person = harness([pressed])
  pressed.listeners.get('pause')?.[0]?.({ type: 'pause' })
  assert.equal(eventOf(person.posted, 'pause').caused, false)
})

test('a play the bridge started, and a seek it made, both say they were caused', () => {
  const started = video({ paused: true, currentTime: 10 })
  const playBridge = harness([started])
  playBridge.command({ kind: 'playerCommand', href: HREF, id: 1, reason: 'play', action: 'play', revision: 21 })
  started.listeners.get('play')?.[0]?.({ type: 'play' })
  assert.equal(eventOf(playBridge.posted, 'play').caused, true)

  const moved = video({ paused: true, currentTime: 10 })
  const seekBridge = harness([moved])
  seekBridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'seek',
    action: 'seek',
    target: 50,
    revision: 22,
  })
  moved.listeners.get('seeked')?.[0]?.({ type: 'seeked' })
  assert.equal(eventOf(seekBridge.posted, 'seeked').caused, true)
})

test('a pause on an element the page removed says the element is gone, and a press does not (T17)', () => {
  // Blink pauses an element the page took out of the document, and only then:
  // at that instant the element is disconnected. That is the fact the app view
  // cannot see from its own reports, and the one that tells it from a press.
  const removed = video({ paused: false, isConnected: false })
  const bridge = harness([removed])
  bridge.posted.length = 0
  removed.listeners.get('pause')?.[0]?.({ type: 'pause' })

  const pause = eventOf(bridge.posted, 'pause')
  assert.equal(pause.detached, true, 'the element was already out of the document')

  // A person's press is on a connected element, and the message keeps the shape
  // every other event has: no field, not `detached: false`.
  const connected = video({ paused: false, isConnected: true })
  const person = harness([connected])
  connected.listeners.get('pause')?.[0]?.({ type: 'pause' })
  const pressed = eventOf(person.posted, 'pause')
  assert.equal('detached' in pressed, false, 'a press adds nothing to the message')
  assert.equal(pressed.caused, false, 'and it is still not ours')
})

test('a rate the bridge did not make is posted, and says it was not caused', () => {
  const element = video()
  const bridge = harness([element])
  element.listeners.get('ratechange')?.[0]?.({ type: 'ratechange' })

  const rate = eventOf(bridge.posted, 'rate')
  assert.equal(rate.id, 1)
  assert.equal(rate.caused, false, 'no write of ours, so no provenance to claim')
})

test('a pause arriving during the hold is applied and the hold is cancelled', () => {
  const element = video({ paused: false, currentTime: 300 })
  const bridge = harness([element])
  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    leadMs: 1500,
    revision: 23,
  })
  assert.equal(element.played, 0, 'the beat has not come yet')

  bridge.command({ kind: 'playerCommand', href: HREF, id: 1, reason: 'pause', action: 'pause', revision: 24 })

  assert.equal(element.paused, true, 'a room pause inside the lead still reaches the element')
  bridge.flush()
  assert.equal(element.played, 0, 'and the cancelled beat does not start it again')
  assert.equal(element.paused, true, 'the window stays where the room is (§6.4 already paid for the beat)')
})

test('a seek arriving during the hold is applied and the hold is cancelled', () => {
  const element = video({ paused: false, currentTime: 300 })
  const bridge = harness([element])
  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    leadMs: 1500,
    revision: 25,
  })

  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'seek',
    action: 'seek',
    target: 42,
    revision: 26,
  })

  assert.equal(element.currentTime, 42, 'the paused snap moved the playhead')
  bridge.flush()
  assert.equal(element.played, 0, 'the old beat cannot play the element behind the seek')
})

test('a second scheduled play replaces the first beat: one play, at the newer one', () => {
  const element = video({ paused: true, currentTime: 0 })
  const bridge = harness([element])
  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    target: 100,
    leadMs: 1500,
    revision: 27,
  })
  bridge.command({
    kind: 'playerCommand',
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    target: 200,
    leadMs: 900,
    revision: 28,
  })

  assert.equal(element.currentTime, 200, 'the newer room position wins')
  bridge.flush()
  assert.equal(element.played, 1, 'the superseded beat did not play it a second time')
})

test('every message names its document, so a reload is news and not old news (T07)', () => {
  const bridge = harness([video()])
  bridge.advance(1_000)
  bridge.tick()

  const docs = bridge.posted.map((message) => message.doc)
  assert.equal(bridge.posted.length, 2, 'one report at ready and one at the poll')
  assert.equal(typeof docs[0], 'string')
  assert.ok(String(docs[0]).length > 0, 'the token is not empty')
  assert.equal(docs[0], docs[1], 'one bridge is one document')

  // A second run is a second document — the reload 06b measured, whose `seq`
  // starts again at 1 while the old document's had reached thousands.
  const reloaded = harness([video()])
  assert.equal(reloaded.posted[0]?.seq, 1, 'the new document counts from 1')
  assert.notEqual(reloaded.posted[0]?.doc, docs[0], 'and says it is a different document')
})


