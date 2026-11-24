/**
 * Ticket 03c: ADR-032 as amended 2026-11-21 — a pending preview is not a
 * follower.
 *
 * One rule is proved here and nothing else: while the initiator's own five
 * seconds are open, a `state` frame is not applied and a `report` is not sent,
 * and every other frame still crosses (chat and the roster are about the room,
 * `pageCommitted` is the frame that ends the preview). The wiring that calls
 * this predicate lives in `src/ui/App.svelte`, which has no DOM test; the
 * decision was put in a module so that this file can hold it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { previewHolds, type PendingPreview } from '../../src/ui/preview.ts'
import { PAGE_STAGE_MS } from '../../src/shared/page.ts'

/** A preview as `submitPage` makes one: the canonical address, the era, the moment. */
const pending: PendingPreview = {
  page: 'https://example.com/watch',
  epoch: 4,
  sentAt: 10_000,
}

test('a pending preview applies no state frame and sends no report', () => {
  assert.equal(previewHolds(pending, 'state'), true)
  assert.equal(previewHolds(pending, 'report'), true)
})

test('with no preview pending, both of those frames cross as before', () => {
  assert.equal(previewHolds(null, 'state'), false)
  assert.equal(previewHolds(null, 'report'), false)
})

test('a preview holds only those two: chat, the roster and the commit still arrive', () => {
  for (const type of ['chat', 'members', 'pageCommitted', 'nudge', 'pong', 'error']) {
    assert.equal(previewHolds(pending, type), false, `${type} must cross a preview`)
  }
})

test('the window the bar counts down is the authority\'s own five seconds', () => {
  assert.equal(PAGE_STAGE_MS, 5000)
})
