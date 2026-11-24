/**
 * Ticket 149: a notice has an end.
 *
 * The owner's chat ended one evening with three lines that never went away, so a
 * notice that never ends read as a new message every time the eye came back. The
 * lifetime decision lives in `src/ui/notices.ts` (the page has no DOM test) and is
 * proved here: a timer, a condition, and the person's own dismiss.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dismissNotice, raiseNotice, reapNotices, type Notice } from '../../src/ui/notices.ts'

/** Raised at 1_000 with ten seconds to run, as the mute is. */
const MUTE: Notice = { id: 'mute', text: 'chat is muted for 10 seconds', until: 11_000 }

test('a notice with a ten-second end is there at 9.9 s and absent at 10.1 s', () => {
  const raised = raiseNotice([], MUTE)
  assert.equal(raised.length, 1)

  const before = reapNotices(raised, 10_900)
  assert.deepEqual(
    before.map((entry) => entry.id),
    ['mute'],
  )

  const after = reapNotices(before, 11_100)
  assert.deepEqual(after, [])
})

test('a notice whose condition turns false is absent at the next tick', () => {
  let waiting = true
  const raised = raiseNotice([], { id: 'align', text: 'not caught up yet', when: () => waiting })

  const still = reapNotices(raised, 5_000)
  assert.deepEqual(
    still.map((entry) => entry.id),
    ['align'],
  )

  waiting = false
  assert.deepEqual(reapNotices(still, 5_250), [])
})

test('dismiss removes the notice at once, and only it', () => {
  const raised = raiseNotice(raiseNotice([], MUTE), {
    id: 'flood',
    text: 'too many messages in a row',
  })

  const dismissed = dismissNotice(raised, 'mute')
  assert.deepEqual(
    dismissed.map((entry) => entry.id),
    ['flood'],
  )
  // Well before either end, so only the dismiss could have removed it.
  assert.deepEqual(
    reapNotices(dismissed, 0).map((entry) => entry.id),
    ['flood'],
  )
})

test('raising the same id again replaces its line instead of stacking a second', () => {
  const first = raiseNotice([], MUTE)
  const second = raiseNotice(first, { ...MUTE, until: 12_000, text: 'chat is muted for 10 seconds' })

  assert.equal(second.length, 1)
  assert.equal(second[0].until, 12_000)
  assert.deepEqual(
    reapNotices(second, 11_100).map((entry) => entry.id),
    ['mute'],
  )
})
