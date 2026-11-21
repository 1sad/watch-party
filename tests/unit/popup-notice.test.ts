/**
 * Ticket 04b: R37's one line, once.
 *
 * The host cancels a page's `window.open` and posts one `popupCancelled` to this
 * page; the page turns that into the top row's single line. The wiring is in
 * `src/ui/App.svelte`, which has no DOM test, so the "how many notices" decision
 * was put in `src/ui/popup-notice.ts` and is proved here: one notice per host per
 * navigation, no second one for a repeat, and the line clearing itself on time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  POPUP_NOTICE_MS,
  expirePopup,
  noPopups,
  notePopup,
  popupSentence,
} from '../../src/ui/popup-notice.ts'

test('one popup event becomes one notice naming its host', () => {
  const state = notePopup(noPopups(), { host: 'ads.example', nav: 3 }, 1_000)

  assert.notEqual(state.notice, null)
  assert.equal(state.notice?.host, 'ads.example')
  assert.equal(state.notice?.at, 1_000)
  assert.deepEqual(state.announced, ['ads.example'])
})

test('a second popup from the same host in the same navigation is not a second notice', () => {
  const first = notePopup(noPopups(), { host: 'ads.example', nav: 3 }, 1_000)
  const second = notePopup(first, { host: 'ads.example', nav: 3 }, 1_400)

  // The same state object, so the caller leaves the line and its timer alone.
  assert.equal(second, first)
  assert.equal(second.notice?.at, 1_000)
  assert.deepEqual(second.announced, ['ads.example'])
})

test('the same host on a new navigation is news again, and the list starts over', () => {
  const first = notePopup(noPopups(), { host: 'ads.example', nav: 3 }, 1_000)
  const second = notePopup(first, { host: 'ads.example', nav: 4 }, 2_000)

  assert.notEqual(second, first)
  assert.equal(second.notice?.nav, 4)
  assert.deepEqual(second.announced, ['ads.example'])
})

test('a different host in the same navigation replaces the line and is remembered', () => {
  const first = notePopup(noPopups(), { host: 'ads.example', nav: 3 }, 1_000)
  const second = notePopup(first, { host: 'tracker.example', nav: 3 }, 1_200)

  assert.equal(second.notice?.host, 'tracker.example')
  assert.deepEqual(second.announced, ['ads.example', 'tracker.example'])
})

test('the line clears itself after its ten seconds and not a moment sooner', () => {
  const shown = notePopup(noPopups(), { host: 'ads.example', nav: 3 }, 1_000)

  assert.equal(expirePopup(shown, 1_000 + POPUP_NOTICE_MS - 1), shown)
  const cleared = expirePopup(shown, 1_000 + POPUP_NOTICE_MS)
  assert.equal(cleared.notice, null)
})

test('after the line has cleared, the same host on the same navigation still says nothing new', () => {
  const shown = notePopup(noPopups(), { host: 'ads.example', nav: 3 }, 1_000)
  const cleared = expirePopup(shown, 1_000 + POPUP_NOTICE_MS)
  const again = notePopup(cleared, { host: 'ads.example', nav: 3 }, 30_000)

  assert.equal(again, cleared)
  assert.equal(again.notice, null)
})

test('the sentence names the host the page asked for and says a window did not open', () => {
  const sentence = popupSentence('ads.example')

  assert.match(sentence, /ads\.example/)
  assert.match(sentence, /window/)
  assert.doesNotMatch(sentence, /blocked/i)
})
