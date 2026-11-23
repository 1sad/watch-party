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

import { ECHO_EXPIRY_MS } from '../../src/shared/echo.ts'
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

function harness(videos: FakeVideo[], options: { top?: boolean } = {}) {
  const posted: Posted[] = []
  const intervals: Array<() => void> = []
  const timers: Array<{ id: number; run: () => void; live: boolean }> = []
  const hostListeners: Array<(event: { data?: unknown }) => void> = []
  const windowListeners = new Map<string, Array<(event: { type: string }) => void>>()
  let nextTimer = 1
  let clock = 1_000_000

  // T104: the top document's address and the two history methods a page uses to
  // change it without a load. The fake methods write the address the browser
  // would show and return their own value, so the wrapper's pass-through and
  // its dedupe are both visible here.
  const location = { href: HREF }
  const historyCalls: Array<{ name: string; url: string }> = []
  const historyAnswer = { kept: 'the page\'s own return value' }
  const history = {
    pushState(_state: unknown, _title: string, url: string) {
      historyCalls.push({ name: 'pushState', url })
      location.href = url
      return historyAnswer
    },
    replaceState(_state: unknown, _title: string, url: string) {
      historyCalls.push({ name: 'replaceState', url })
      location.href = url
      return historyAnswer
    },
  }

  // T08: the two prototypes the fullscreen wrapper installs itself on. A frame
  // has one of each, so the fake document is made from `Document`'s and the fake
  // element is `Element`'s, and the wrapper and the page call the same method.
  const fullscreenCalls: string[] = []
  let fullscreenAnswer: Promise<void> = Promise.resolve()
  const elementPrototype = {
    requestFullscreen(): Promise<void> {
      fullscreenCalls.push('request')
      return fullscreenAnswer
    },
  }
  const documentPrototype = {
    exitFullscreen(): Promise<void> {
      fullscreenCalls.push('exit')
      return fullscreenAnswer
    },
  }

  const document = Object.assign(Object.create(documentPrototype), {
    readyState: 'complete',
    querySelectorAll: (selector: string) => (selector === 'video' ? videos : []),
    addEventListener: () => {},
    // The fake page has no focus, which is the paused-rate case.
    hasFocus: () => false,
  })
  const window: Record<string, unknown> = {
    Element: { prototype: elementPrototype },
    Document: { prototype: documentPrototype },
    history,
    addEventListener: (name: string, listener: (event: { type: string }) => void) => {
      const listeners = windowListeners.get(name) ?? []
      listeners.push(listener)
      windowListeners.set(name, listeners)
    },
    chrome: {
      webview: {
        postMessage: (message: Posted) => posted.push(message),
        addEventListener: (_name: string, listener: (event: { data?: unknown }) => void) => {
          hostListeners.push(listener)
        },
      },
    },
  }
  // T104: a top document is its own `window.top`. Every harness but T104's
  // is a frame, which is exactly the document that must not name the page.
  if (options.top === true) window.top = window

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
    location,
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
    /** T104: the two history methods, as the bridge left them (wrapped). */
    history,
    /** T104: what the fake history methods return, so pass-through is provable. */
    historyReturn: historyAnswer,
    /** T104: fire a window event the address listeners hear (popstate/hashchange). */
    windowEvent(name: string) {
      for (const listener of windowListeners.get(name) ?? []) listener({ type: name })
    },
    /** T104: the browser moves the address with no history call, as a back press does. */
    moveTo(href: string) {
      location.href = href
    },
    /** T08: the page's two calls, and the promise the engine would answer with. */
    fullscreen: {
      request: () => elementPrototype.requestFullscreen(),
      exit: () => (document as { exitFullscreen(): Promise<void> }).exitFullscreen(),
      calls: fullscreenCalls,
      /** The engine's answer to both calls from now on. */
      answer(promise: Promise<void>) {
        fullscreenAnswer = promise
      },
    },
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

/** T104: every address the top document announced, in order. */
function addresses(posted: Posted[]): Posted[] {
  return posted.filter((message) => message.kind === 'pageAddress')
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

test('a rate command writes playbackRate and nothing else, and the beat still waits (T14)', () => {
  const element = video({ paused: true, currentTime: 42, playbackRate: 1 })
  const bridge = harness([element])
  bridge.posted.length = 0

  // A scheduled play is waiting for its beat...
  bridge.command({
    kind: 'playerCommand',
    source: HREF,
    href: HREF,
    id: 1,
    reason: 'play',
    action: 'play',
    target: 42,
    leadMs: 1500,
    revision: 9,
  })
  // ...and the nudge's rate must not move the playhead, start the element, or
  // cancel the beat. A rate is about how fast, not when.
  bridge.command({ kind: 'playerCommand', href: HREF, id: 1, action: 'rate', rate: 1.05 })
  assert.equal(element.playbackRate, 1.05, 'the rate was written')
  assert.equal(element.currentTime, 42, 'the playhead did not move')
  assert.equal(element.paused, true, 'the element was not started')
  assert.equal(element.played, 0, 'and the waiting beat is still waiting')

  bridge.flush()
  assert.equal(element.played, 1, 'the beat still fired')
  assert.equal(element.playbackRate, 1.05, 'the beat did not undo the rate')

  // The restore is the same command with the other number: exactly 1.
  bridge.command({ kind: 'playerCommand', href: HREF, id: 1, action: 'rate', rate: 1 })
  assert.equal(element.playbackRate, 1)
  assert.equal(
    bridge.posted.filter((message) => message.kind === 'playerEvent' && message.event === 'applied').length,
    1,
    'a rate writes no `applied` line: the room gave it no reason and no target',
  )
})

// ---- T08: the page's fullscreen intent, posted before the call runs ----

test('requestFullscreen posts one enter and still calls the page\'s own method (T08)', () => {
  const bridge = harness([video()])
  bridge.posted.length = 0

  bridge.fullscreen.request()

  const intents = bridge.posted.filter((message) => message.kind === 'fullscreen')
  assert.equal(intents.length, 1, 'one call, one message: no repeat, no pair')
  assert.equal(intents[0]?.state, 'enter')
  assert.equal(typeof intents[0]?.doc, 'string', 'it carries the document token every message has')
  assert.ok(String(intents[0]?.doc).length > 0)
  assert.deepEqual(bridge.fullscreen.calls, ['request'], 'the engine still received the call')
})

test('exitFullscreen posts exit, and only the one message (T08)', () => {
  const bridge = harness([video()])
  bridge.posted.length = 0

  bridge.fullscreen.exit()

  const intents = bridge.posted.filter((message) => message.kind === 'fullscreen')
  assert.equal(intents.length, 1)
  assert.equal(intents[0]?.state, 'exit')
  assert.equal(intents[0]?.href, HREF)
  assert.deepEqual(bridge.fullscreen.calls, ['exit'])
})

test('an engine refusal is swallowed: an ignored promise is not an unhandled rejection (T08)', async () => {
  const bridge = harness([video()])
  bridge.posted.length = 0
  bridge.fullscreen.answer(Promise.reject(new TypeError('not granted')))

  const escaped: unknown[] = []
  const record = (reason: unknown) => escaped.push(reason)
  process.on('unhandledRejection', record)
  try {
    // The site's own code ignores what the call returned, as most players do.
    bridge.fullscreen.request()
    // Two turns of the microtask queue: the point at which a rejection with no
    // handler is reported.
    await new Promise((settle) => setImmediate(settle))
    await new Promise((settle) => setImmediate(settle))
  } finally {
    process.off('unhandledRejection', record)
  }

  assert.deepEqual(escaped, [], 'the refusal did not surface as an unhandled rejection')
  assert.equal(bridge.posted.filter((message) => message.kind === 'fullscreen').length, 1,
    'and the intent was still sent, which is the whole point: the layout follows the wish, not the grant')
})

test('a player that watches the promise still sees the engine\'s refusal (T08)', async () => {
  const bridge = harness([video()])
  bridge.posted.length = 0
  bridge.fullscreen.answer(Promise.reject(new TypeError('not granted')))

  // The wrapper is not allowed to turn a refusal into a success: a site that
  // reads its own promise must be able to tell, or it paints an icon that lies.
  await assert.rejects(bridge.fullscreen.request(), /not granted/)
})

test('the bridge believes a caused event for exactly as long as the echo set does (T33)', () => {
  // The bridge is injected as text and cannot import the TS constant, so its
  // `CAUSED_EXPIRY_MS` is a second copy of `ECHO_EXPIRY_MS` (its own comment
  // says "the same second `echo.ts` allows"). Two windows for one event: the
  // echo set drops our command's event, the bridge's `caused` flag says it was
  // ours. Let them drift and a caused event is judged a person's, or an echo is
  // dropped late - either way a pause becomes a no-op (spec.md §6.6).
  const declared = /var CAUSED_EXPIRY_MS = (\d+)/.exec(source)
  assert.ok(declared, 'player-bridge.js still declares a numeric CAUSED_EXPIRY_MS')
  assert.equal(
    Number(declared[1]),
    ECHO_EXPIRY_MS,
    'CAUSED_EXPIRY_MS in src/shared/player-bridge.js must equal ECHO_EXPIRY_MS in src/shared/echo.ts',
  )
})

// ---- T104: the top document says where it is (ADR-048) ----

test('the top document posts one pageAddress at start, and its messages say they are the top (T104)', () => {
  const bridge = harness([video()], { top: true })
  const sent = addresses(bridge.posted)
  assert.equal(sent.length, 1, 'one pageAddress for the document it started on')
  assert.equal(sent[0]?.href, HREF)
  assert.equal(sent[0]?.top, true, 'and it says the top document sent it')

  // A frame never names the page: its address is its own (6 of 11 sites). Every
  // message it does send says it is not the top document.
  const frame = harness([video()])
  assert.equal(addresses(frame.posted).length, 0, 'a frame posts no pageAddress')
  assert.equal(frame.posted[0]?.kind, 'playerReport', 'the frame still reports its video')
  assert.equal(frame.posted[0]?.top, false)
})

test('a pushState to a new address posts exactly one more, and the same address posts none (T104)', () => {
  const bridge = harness([video()], { top: true })
  assert.equal(addresses(bridge.posted).length, 1)

  const next = 'https://plyr.animex.one/embed/G2'
  const answer = bridge.history.pushState(null, '', next)
  assert.equal(answer, bridge.historyReturn, 'the page still gets the method\'s own return value')

  const sent = addresses(bridge.posted)
  assert.equal(sent.length, 2, 'exactly one more after a new path')
  assert.equal(sent[1]?.href, next)
  assert.equal(sent[1]?.top, true)

  bridge.history.pushState(null, '', next)
  assert.equal(addresses(bridge.posted).length, 2, 'the same address is not a change')
})

test('replaceState, popstate and hashchange each announce the address they land on (T104)', () => {
  const bridge = harness([video()], { top: true })
  const sent = () => addresses(bridge.posted)

  bridge.history.replaceState(null, '', 'https://plyr.animex.one/embed/G3')
  assert.equal(sent().length, 2, 'replaceState is a route change too')
  assert.equal(sent().at(-1)?.href, 'https://plyr.animex.one/embed/G3')

  bridge.moveTo('https://plyr.animex.one/embed/G4')
  bridge.windowEvent('popstate')
  assert.equal(sent().length, 3, 'a back press moves the address without a history call')
  assert.equal(sent().at(-1)?.href, 'https://plyr.animex.one/embed/G4')

  bridge.moveTo('https://plyr.animex.one/embed/G4#t=30')
  bridge.windowEvent('hashchange')
  assert.equal(sent().length, 4, 'a fragment change is an address change')
  assert.equal(sent().at(-1)?.href, 'https://plyr.animex.one/embed/G4#t=30')
})


