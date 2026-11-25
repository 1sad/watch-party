/**
 * Ticket 179 / R54, ADR-054 and ADR-006 as amended: the message path between the
 * page and the app-owned YouTube embed it carries, both ways.
 *
 * The transport is `src/shared/embed-site.ts`: the API's numbers become the same
 * bridge-shaped messages the window host's site view posts (`playerReport`, and
 * `playerEvent` for play/pause/seek/applied), and the room's `playerCommand`
 * payloads become `play`/`pause`/`seek`/`setRate` on the API's own object. The
 * app view's half - the election, the follower rule, the report to the room - is
 * the one the app's own window already uses, so what is proved here is only that
 * this driver speaks that shape faithfully, including T15's `caused` provenance.
 *
 * There is no DOM in this project's tests, so the embed is a stand-in with the
 * API's methods and the API's state table (ADR-051): `1` playing, `2` paused,
 * `3` buffering, `5` cued.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMBED_PLAYER_ID,
  createEmbedSite,
  embedFrameOf,
  type EmbedPlayerApi,
} from '../../src/shared/embed-site.ts'

/** The embed address the page builds for the room's page, exactly as the app's window does. */
const address = 'http://127.0.0.1:63144/embed/youtube.html?id=dQw4w9WgXcQ'

/** A second room's embed: a command for it is not this page's. */
const otherAddress = 'http://127.0.0.1:63144/embed/youtube.html?id=aqz-KE-bpKQ'

interface FakePlayer {
  /** Every method this page called on the API, in order. */
  calls: string[]
  t: number
  duration: number
  rate: number
  state: number
  api: EmbedPlayerApi
  /** The API's own state change, as YouTube fires it after `playVideo()`/`pauseVideo()`. */
  setState(state: number): void
  /** The window the page reads the API off (`window.__wpYouTube` and its viewport). */
  window: { __wpYouTube: EmbedPlayerApi; innerWidth: number; innerHeight: number }
}

function fakePlayer(state = 5, t = 12.5, duration = 300): FakePlayer {
  const player: FakePlayer = {
    calls: [],
    t,
    duration,
    rate: 1,
    state,
    api: null as unknown as EmbedPlayerApi,
    setState(next: number) {
      player.state = next
      for (const listener of listeners) listener(next)
    },
    window: { __wpYouTube: null as unknown as EmbedPlayerApi, innerWidth: 800, innerHeight: 450 },
  }
  const listeners: Array<(state: number) => void> = []
  player.api = {
    play() {
      player.calls.push('play')
      player.setState(1)
    },
    pause() {
      player.calls.push('pause')
      player.setState(2)
    },
    seek(seconds: number) {
      player.calls.push(`seek ${seconds}`)
      player.t = seconds
    },
    now: () => player.t,
    state: () => player.state,
    duration: () => player.duration,
    setVolume: (level: number) => player.calls.push(`volume ${level}`),
    volume: () => 1,
    muted: () => false,
    rate: () => player.rate,
    setRate: (next: number) => {
      player.calls.push(`rate ${next}`)
      player.rate = next
    },
    onStateChange: (listener: (state: number) => void) => {
      listeners.push(listener)
    },
  }
  player.window.__wpYouTube = player.api
  return player
}

/** One page's transport, its clock, and every message it has posted. */
function page(player: FakePlayer, frame: () => unknown = () => embedFrameOf(player.window)) {
  const at = { ms: 10_000 }
  const messages: Array<Record<string, unknown>> = []
  const site = createEmbedSite({
    source: address,
    frame: () => frame() as ReturnType<typeof embedFrameOf>,
    post: (message) => messages.push(message),
    now: () => at.ms,
  })
  return { site, messages, at }
}

/** The first message of one kind, or a failure that names what was posted instead. */
function messageOf(
  messages: ReadonlyArray<Record<string, unknown>>,
  kind: string,
  event?: string,
): Record<string, unknown> {
  const found = messages.find((one) => one.kind === kind && (event === undefined || one.event === event))
  assert.ok(
    found !== undefined,
    `no ${kind}${event === undefined ? '' : ` ${event}`} in ${JSON.stringify(messages)}`,
  )
  return found
}

test('the embed API is read off the frame window, and only when it is the published shape', () => {
  const player = fakePlayer()
  const frame = embedFrameOf(player.window)
  assert.ok(frame !== null)
  assert.equal(frame.api, player.api)
  // The frame's own viewport is §10.1's area: a 0x0 player could never be elected.
  assert.equal(frame.w, 800)
  assert.equal(frame.h, 450)
  // A frame that has not navigated, one with no API yet, and one that is not ours:
  // no player, never a thrown page.
  assert.equal(embedFrameOf(null), null)
  assert.equal(embedFrameOf(undefined), null)
  assert.equal(embedFrameOf({}), null)
  assert.equal(embedFrameOf({ __wpYouTube: { now: () => 1 } }), null)
})

test('one beat reports the API numbers in the bridge report shape, no faster than the poll', () => {
  const player = fakePlayer()
  const { site, messages, at } = page(player)
  site.poll()

  const report = messageOf(messages, 'playerReport')
  assert.equal(report.href, address)
  assert.equal(report.top, true)
  assert.equal(report.seq, 1)
  assert.equal(typeof report.doc, 'string')

  const candidates = report.candidates as Array<Record<string, unknown>>
  assert.equal(candidates.length, 1)
  const candidate = candidates[0] as Record<string, unknown>
  // T157's one id for the API player: no <video> element can have it.
  assert.equal(candidate.id, EMBED_PLAYER_ID)
  // The position is the API's own number, not a calculation of this page's.
  assert.equal(candidate.t, 12.5)
  assert.equal(candidate.duration, 300)
  assert.equal(candidate.readyState, 4)
  assert.equal(candidate.hasSrc, true)
  assert.equal(candidate.paused, true)
  assert.equal(candidate.playing, false)
  assert.equal(candidate.w, 800)
  assert.equal(candidate.h, 450)
  assert.equal(candidate.buffered, 12.5)
  assert.equal(candidate.rate, 1)

  // Nothing changed and less than a second has passed: a poll is not a report.
  at.ms += 300
  site.poll()
  assert.equal(messages.length, 1, JSON.stringify(messages))

  at.ms += 700
  site.poll()
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.kind, 'playerReport')
  assert.equal(messages[1]?.seq, 2)
})

test('the room\'s play reaches the player, and its own state event comes back caused', () => {
  const player = fakePlayer()
  const { site, messages } = page(player)
  site.poll()
  const before = messages.length

  site.apply({
    kind: 'playerCommand',
    href: address,
    id: EMBED_PLAYER_ID,
    action: 'play',
    reason: 'play',
    revision: 7,
  })

  assert.deepEqual(player.calls, ['play'])
  // The API's own state change is the event, and this page's write is why (T15).
  const play = messageOf(messages.slice(before), 'playerEvent', 'play')
  assert.equal(play.id, EMBED_PLAYER_ID)
  assert.equal(play.caused, true)
  assert.equal(play.t, 12.5)
  // T06's one line per applied command, in the element bridge's shape.
  const applied = messageOf(messages.slice(before), 'playerEvent', 'applied')
  assert.equal(applied.action, 'play')
  assert.equal(applied.reason, 'play')
  assert.equal(applied.target, 12.5)

  // A person's own pause afterwards is nobody's write but theirs.
  player.setState(2)
  const pause = messageOf(messages, 'playerEvent', 'pause')
  assert.equal(pause.caused, false)
})

test('the room\'s pause reaches the player and the seek writes the room\'s position', () => {
  const player = fakePlayer(1, 20)
  const { site, messages } = page(player)
  site.poll()

  site.apply({ kind: 'playerCommand', href: address, id: EMBED_PLAYER_ID, action: 'pause', reason: 'pause' })
  assert.ok(player.calls.includes('pause'))
  const pause = messageOf(messages, 'playerEvent', 'pause')
  assert.equal(pause.caused, true)

  site.apply({
    kind: 'playerCommand',
    href: address,
    id: EMBED_PLAYER_ID,
    action: 'seek',
    target: 42.5,
    resume: true,
    reason: 'state',
  })
  assert.ok(player.calls.includes('seek 42.5'), player.calls.join(','))
  assert.equal(player.t, 42.5)
  // The last applied line is the seek's: the pause wrote the playhead it found.
  const applied = messages.filter((one) => one.event === 'applied').pop()
  assert.ok(applied !== undefined)
  assert.equal(applied.action, 'seek')
  assert.equal(applied.target, 42.5)
})

test('a seek the room asked for is reported as a seeked, and a person\'s is not caused', () => {
  const player = fakePlayer(1, 20)
  const { site, messages, at } = page(player)
  site.poll()

  // A person seeks forward in the guest's own player: no write of this page's
  // explains a jump of 40 s, so the poll reports it.
  at.ms += 500
  player.t = 60
  site.poll()
  const person = messageOf(messages, 'playerEvent', 'seeked')
  assert.equal(person.caused, false)
  assert.equal(person.wasPlaying, true)
  assert.equal(person.t, 60)

  // Now the room's own seek: the same jump, but this page made it, so it is an echo.
  const before = messages.length
  site.apply({ kind: 'playerCommand', href: address, id: EMBED_PLAYER_ID, action: 'seek', target: 20, resume: true })
  at.ms += 500
  site.poll()
  const ours = messageOf(messages.slice(before), 'playerEvent', 'seeked')
  assert.equal(ours.caused, true)
  assert.equal(ours.t, 20)
})

test('a command for another address, another id or no API at all is ignored', () => {
  const player = fakePlayer()
  const { site } = page(player)
  site.poll()

  site.apply({ kind: 'playerCommand', href: otherAddress, id: EMBED_PLAYER_ID, action: 'play' })
  site.apply({ kind: 'playerCommand', href: address, id: 7, action: 'play' })
  site.apply({ kind: 'siteCommand', href: address, id: EMBED_PLAYER_ID, action: 'play' })
  assert.deepEqual(player.calls, [])

  // The room's word before the embed's player exists is dropped, not thrown.
  const early = page(player, () => null)
  early.site.apply({ kind: 'playerCommand', href: address, id: EMBED_PLAYER_ID, action: 'play' })
  early.site.poll()
  assert.deepEqual(player.calls, [])
  assert.deepEqual(early.messages, [])
})

test('the ladder\'s rate is one API write and no applied line, and a lost seek is written once it can be', () => {
  const player = fakePlayer()
  const { site, messages } = page(player)
  site.poll()
  const before = messages.length

  site.apply({ kind: 'playerCommand', href: address, id: EMBED_PLAYER_ID, action: 'rate', rate: 0.95 })
  assert.ok(player.calls.includes('rate 0.95'))
  assert.equal(
    messages.slice(before).filter((one) => one.event === 'applied').length,
    0,
    'a rate is the ladder\'s own and has no applied line',
  )

  // T146, ADR-050: a position asked for before the duration is known is kept and
  // written once the player can take it, not dropped.
  player.duration = 0
  site.apply({ kind: 'playerCommand', href: address, id: EMBED_PLAYER_ID, action: 'seek', target: 30 })
  assert.ok(!player.calls.includes('seek 30'), player.calls.join(','))
  player.duration = 300
  site.poll()
  assert.ok(player.calls.includes('seek 30'), player.calls.join(','))
})
