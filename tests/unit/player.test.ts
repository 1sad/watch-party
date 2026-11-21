/**
 * Ticket 05: `spec.md` §10.1's scoring and election, as a table.
 *
 * The ticket's five facts and nothing else: a big playing candidate beats a
 * small ready one, a hidden candidate never wins, a tie keeps the incumbent, an
 * empty set elects nothing, and each of the four reasons is produced by the
 * condition that causes it. The wiring that feeds these functions (one report
 * per frame, from `player-bridge.js`) is `App.svelte`'s and is proven live; the
 * decision was put in a module so that this file can hold it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PLAYER_REPORT_TTL_MS,
  documentsLeft,
  elect,
  mergeReports,
  reportIsNewer,
  scoreCandidate,
  type FrameReport,
  type PlayerCandidate,
} from '../../src/shared/player.ts'

/** A plausible player: 842x474, ready, with a source, playing, 1420 s long. */
function candidate(over: Partial<PlayerCandidate> = {}): PlayerCandidate {
  return {
    source: 'https://plyr.example/embed/1',
    href: 'https://plyr.example/embed/1?t=80',
    id: 1,
    w: 842,
    h: 474,
    readyState: 4,
    hasSrc: true,
    playing: true,
    duration: 1420.0436,
    t: 80.2,
    ...over,
  }
}

test('the scoring order is area, then readyState, then a source, then playing', () => {
  const large = candidate({ w: 842, h: 474, readyState: 1, hasSrc: false, playing: false })
  const small = candidate({ w: 320, h: 180, readyState: 4, hasSrc: true, playing: true })
  assert.ok(scoreCandidate(large) > scoreCandidate(small), 'area comes before everything below it')

  const ready = candidate({ readyState: 4, hasSrc: false, playing: false })
  const sourced = candidate({ readyState: 0, hasSrc: true, playing: true })
  assert.ok(scoreCandidate(ready) > scoreCandidate(sourced), 'readyState comes before having a source')

  const sourcedOnly = candidate({ readyState: 0, hasSrc: true, playing: false })
  const playingOnly = candidate({ readyState: 0, hasSrc: false, playing: true })
  assert.ok(scoreCandidate(sourcedOnly) > scoreCandidate(playingOnly), 'a source comes before playing')
})

test('a big playing candidate beats a small ready one', () => {
  const big = candidate({ id: 1 })
  const small = candidate({ id: 2, w: 320, h: 180, playing: false })
  const result = elect(null, [small, big])
  assert.equal(result.elected?.id, 1)
  assert.equal(result.reason, 'appeared')
})

test('a hidden candidate (w=0) never wins', () => {
  const hidden = candidate({ id: 9, w: 0, h: 0 })
  assert.equal(scoreCandidate(hidden), 0)
  assert.equal(elect(null, [hidden]).elected, null, 'a page with only hidden videos elects nothing')

  const small = candidate({ id: 10, w: 64, h: 36, playing: false })
  assert.equal(elect(null, [hidden, small]).elected?.id, 10, 'a visible candidate beats a hidden one')
})

test('a tie keeps the incumbent, whichever order the candidates arrive in', () => {
  const first = candidate({ id: 1 })
  const twin = candidate({ id: 2 })
  assert.equal(elect(first, [first, twin]).elected?.id, 1, 'the incumbent arrives first')
  assert.equal(elect(first, [twin, first]).elected?.id, 1, 'the incumbent arrives second')
  assert.equal(elect(first, [twin, first]).reason, null, 'and a tie is not an election')
})

test('an empty set elects nothing', () => {
  assert.deepEqual(elect(null, []), { elected: null, reason: null, score: 0 })
  assert.equal(elect(candidate(), []).elected, null)
})

test('appeared: the first candidate that can be a player is elected', () => {
  const result = elect(null, [candidate()])
  assert.equal(result.elected?.href, 'https://plyr.example/embed/1?t=80')
  assert.equal(result.reason, 'appeared')
})

test('removed: the incumbent gone from its frame elects the next best and says so', () => {
  const incumbent = candidate({ id: 1 })
  const other = candidate({ id: 2, w: 640, h: 360 })
  const result = elect(incumbent, [other])
  assert.equal(result.elected?.id, 2)
  assert.equal(result.reason, 'removed')
  assert.equal(elect(incumbent, []).reason, 'removed', 'and losing the player is a line too')
})

test('replaced: emptied or loadstart on a playing incumbent re-elects; before playing it does not', () => {
  const incumbent = candidate({ id: 1 })
  const other = candidate({ id: 2, w: 320, h: 180 })
  const reloaded = candidate({ id: 1, readyState: 1, hasSrc: false, playing: false, t: 0 })

  for (const kind of ['emptied', 'loadstart'] as const) {
    const result = elect(incumbent, [reloaded, other], [
      { source: incumbent.source, id: 1, event: kind, t: 0 },
    ])
    assert.equal(result.elected?.id, 2, kind)
    assert.equal(result.reason, 'replaced', kind)
  }

  // The same element loading before it ever played is a preload, not a new
  // player: it keeps the election it already had.
  const loading = candidate({ id: 1, readyState: 1, hasSrc: false, playing: false })
  const untouched = elect(loading, [loading, other], [{ source: loading.source, id: 1, event: 'loadstart', t: 0 }])
  assert.equal(untouched.elected?.id, 1)
  assert.equal(untouched.reason, null)
})

test('the winner is the element as it is now, so a player that starts playing is still replaceable', () => {
  // Measured on `bingebang.sx` (05b): the election lands on the page's placeholder
  // `<video>` half a second after the navigation, before it has a source, so the
  // first snapshot says playing=false and duration=0. Keeping that snapshot
  // frozen made `emptied` after 100 s of playback mean nothing, and left every
  // later reading (size, duration) at the value from that instant.
  const placeholder = candidate({ id: 1, readyState: 0, hasSrc: false, playing: false, duration: 0, t: 0 })
  const first = elect(null, [placeholder])
  assert.equal(first.reason, 'appeared')

  const playing = candidate({ id: 1 })
  const steady = elect(first.elected, [playing])
  assert.equal(steady.reason, null, 'the same element is not a new election')
  assert.equal(steady.elected?.playing, true, 'the winner is the element as it is now')
  assert.equal(steady.elected?.duration, 1420.0436, 'and carries the duration the page has by now')

  const switched = elect(
    steady.elected,
    [candidate({ id: 1, readyState: 0, hasSrc: false, playing: false, duration: 0, t: 0 })],
    [{ source: playing.source, id: 1, event: 'emptied', t: 90 }],
  )
  assert.equal(switched.reason, 'replaced', 'a reload of the playing element is a replacement')
})

test('outscored: a bigger candidate outranks a healthy incumbent', () => {
  const incumbent = candidate({ id: 1, w: 320, h: 180 })
  const bigger = candidate({ id: 2, w: 842, h: 474 })
  const result = elect(incumbent, [incumbent, bigger])
  assert.equal(result.elected?.id, 2)
  assert.equal(result.reason, 'outscored')
})

test('two frames merge into one list, and identity is the frame plus the element', () => {
  // The live shape: a top page with a hidden copy, and the cross-origin player
  // frame whose element happens to be number 1 too.
  const top: FrameReport = {
    source: 'https://animex.one/watch/x',
    href: 'https://animex.one/watch/x',
    doc: 'document-top',
    seq: 3,
    candidates: [candidate({ id: 1, w: 0, h: 0 })],
    receivedAt: 1_000,
  }
  const playerFrame: FrameReport = {
    source: 'https://plyr.animex.one/embed/y',
    href: 'https://plyr.animex.one/embed/y?t=80',
    doc: 'document-player',
    seq: 4,
    candidates: [candidate({ id: 1 })],
    receivedAt: 1_000,
  }

  const merged = mergeReports([top, playerFrame], 1_100)
  assert.equal(merged.length, 2)
  const result = elect(null, merged)
  assert.equal(result.elected?.href, 'https://plyr.animex.one/embed/y?t=80')
  assert.equal(result.elected?.source, 'https://plyr.animex.one/embed/y')
})

test('a frame that stops reporting stops contributing', () => {
  const report: FrameReport = {
    source: 'https://plyr.example/embed/1',
    href: 'https://plyr.example/embed/1?t=80',
    doc: 'document-one',
    seq: 1,
    candidates: [candidate()],
    receivedAt: 1_000,
  }
  assert.equal(mergeReports([report], 1_000 + PLAYER_REPORT_TTL_MS).length, 1)
  assert.equal(mergeReports([report], 1_000 + PLAYER_REPORT_TTL_MS + 1).length, 0)
})

test('a reloaded document is news again even though its count restarted (T07, 06b)', () => {
  // 06b's live run: reloading the site view left both windows at
  // `player: none reason=replaced` with no later `appeared`, because the new
  // document's first report said `seq=1` against the old one's thousands and
  // was thrown away as older news. The document token is what tells them apart.
  const before: FrameReport = {
    source: 'https://animex.one/watch/x',
    href: 'https://animex.one/watch/x',
    doc: 'document-before',
    seq: 4_000,
    candidates: [candidate()],
    receivedAt: 1_000,
  }

  assert.equal(reportIsNewer(undefined, { doc: 'document-before', seq: 1 }), true, 'a first report')
  assert.equal(reportIsNewer(before, { doc: 'document-before', seq: 4_001 }), true, 'the next in order')
  assert.equal(reportIsNewer(before, { doc: 'document-before', seq: 3_999 }), false, 'older news')
  assert.equal(reportIsNewer(before, { doc: 'document-before', seq: 4_000 }), false, 'the same report twice')
  assert.equal(
    reportIsNewer(before, { doc: 'document-after', seq: 1 }),
    true,
    'a new document counts from 1 and is still news',
  )
})

test('a report naming the previous page after a commit is dropped', () => {
  // 07b, 2026-11-21: the room committed the next episode, every window cleared
  // its frames and reset to 0 paused, and the old page's report — already in
  // flight — landed 32 ms later (`site: bridge report ... ep1 seq=67`) and
  // re-added the old candidate. A score tie then held it until the 5 s expiry,
  // so the first new-page election came about six seconds late.
  const oldPage: FrameReport = {
    source: 'https://plyr.animex.one/embed/ep1',
    href: 'https://plyr.animex.one/embed/ep1?t=1320',
    doc: 'document-ep1',
    seq: 66,
    candidates: [candidate()],
    receivedAt: 1_000,
  }
  const left = documentsLeft([oldPage])
  assert.deepEqual([...left], ['document-ep1'], 'the documents held at the commit are the page being left')

  // The frames are cleared at the commit; the in-flight report lands after it.
  const inFlight: FrameReport = { ...oldPage, seq: 67, receivedAt: 1_032 }
  const merged = mergeReports([inFlight], 1_032, left)
  assert.equal(merged.length, 0, 'the old page is not a candidate after the commit')
  assert.equal(elect(null, merged, [], left).elected, null, 'so nothing is elected from it')

  // No commit, the same report: a candidate as it has always been.
  assert.equal(mergeReports([inFlight], 1_032).length, 1, 'a normal election still holds it')

  // The new page's own document is a candidate, and is elected at once.
  const newPage: FrameReport = {
    ...oldPage,
    source: 'https://plyr.animex.one/embed/ep2',
    href: 'https://plyr.animex.one/embed/ep2?t=0',
    doc: 'document-ep2',
    seq: 1,
    receivedAt: 1_040,
  }
  const both = mergeReports([inFlight, newPage], 1_040, left)
  assert.equal(both.length, 1)
  assert.equal(both[0]?.doc, 'document-ep2', 'the report carries its document, for the tie rule')
  assert.equal(elect(null, both, [], left).elected?.doc, 'document-ep2')
})

test('a tie between the current page and another favours the current page', () => {
  // The guard behind the drop: a candidate that cannot be told apart by its
  // document (a bridge too old to send one) still must not outlive the commit.
  const old = candidate({ id: 1, doc: 'document-ep1' })
  const current = candidate({ id: 2, doc: 'document-ep2' })
  const left = new Set(['document-ep1'])

  assert.equal(elect(null, [old, current], [], left).elected?.id, 2, 'the old page arrives first')
  assert.equal(elect(null, [current, old], [], left).elected?.id, 2, 'the old page arrives second')

  const unnamed = candidate({ id: 3, doc: '' })
  assert.equal(elect(null, [unnamed, current], [], left).elected?.id, 2, 'an unnamed document loses the tie')
  assert.equal(elect(null, [current, unnamed], [], left).elected?.id, 2, 'from either side of it')
  assert.equal(
    elect(unnamed, [unnamed, current], [], left).elected?.id,
    2,
    'and not even being the incumbent holds it',
  )
})

test('a normal election with no commit behaves as today', () => {
  // Two documents of one page tie: the incumbent is kept, whichever document it
  // belongs to, exactly as "a tie keeps the incumbent" has always said.
  const incumbent = candidate({ id: 1, doc: 'document-one' })
  const twin = candidate({ id: 2, doc: 'document-two' })
  assert.equal(elect(incumbent, [incumbent, twin]).elected?.id, 1)
  assert.equal(elect(incumbent, [twin, incumbent]).elected?.id, 1, 'in either order')
  assert.equal(elect(incumbent, [twin, incumbent]).reason, null, 'and a tie is not an election')

  // An empty commit set is the same as none: nothing has been left behind.
  assert.equal(elect(incumbent, [incumbent, twin], [], new Set()).elected?.id, 1)

  // And the merge is the list it always was.
  const report: FrameReport = {
    source: 'https://plyr.example/embed/1',
    href: 'https://plyr.example/embed/1?t=80',
    doc: 'document-one',
    seq: 1,
    candidates: [candidate()],
    receivedAt: 1_000,
  }
  assert.equal(mergeReports([report], 1_100).length, 1)
  assert.equal(elect(null, mergeReports([report], 1_100)).reason, 'appeared')
})
