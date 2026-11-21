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
  elect,
  mergeReports,
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
    seq: 3,
    candidates: [candidate({ id: 1, w: 0, h: 0 })],
    receivedAt: 1_000,
  }
  const playerFrame: FrameReport = {
    source: 'https://plyr.animex.one/embed/y',
    href: 'https://plyr.animex.one/embed/y?t=80',
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
    seq: 1,
    candidates: [candidate()],
    receivedAt: 1_000,
  }
  assert.equal(mergeReports([report], 1_000 + PLAYER_REPORT_TTL_MS).length, 1)
  assert.equal(mergeReports([report], 1_000 + PLAYER_REPORT_TTL_MS + 1).length, 0)
})
