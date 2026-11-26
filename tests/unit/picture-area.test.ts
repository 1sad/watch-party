/**
 * Ticket 178 / R54, ADR-054 and ADR-006 as amended: the words a viewer with no
 * window host reads where the picture goes.
 *
 * One rule is proved here and nothing else: the picture area's content is chosen
 * in one place, by what the room is on and whether a window host is looking. A
 * file room is the player, a YouTube room with a host is the host's site view, a
 * YouTube room without one is the app-owned embed's branch - and the address that
 * branch carries is built by the same function the app's window uses (ticket 179;
 * the transport itself is `tests/unit/embed-site.test.ts`) - and a website room is
 * one plain sentence naming the app. The wiring that draws this lives in
 * `src/ui/App.svelte`, which has no DOM test; the rule was put in a module so that
 * this file can hold it (the same arrangement `tests/unit/room-view.test.ts`
 * keeps).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { BROWSER_SITE_SENTENCE, PRESS_PLAY_BUTTON, pictureFor, pressPlaySentence } from '../../src/ui/picture-area.ts'
import { siteViewAddress, isYouTubeEmbedAddress } from '../../src/shared/youtube.ts'
import type { Media } from '../../src/shared/protocol.ts'

/** The file the owner picked, as `welcome` and the `media` frame carry it (§4.2). */
const file: Media = {
  kind: 'file',
  id: 'm1',
  title: 'fixture',
  duration: 60,
  contentType: 'video/mp4',
}

/** A room on an ordinary website: both probes are ordinary pages (R54). */
const website = 'http://127.0.0.1:8123/probe.html'

/** A YouTube room's page, in the one watch form the room stores (ADR-051). */
const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

test('a file room is the player, whether a window host is looking or a plain browser', () => {
  // R53 / ticket 182: the guest's own <video> is fed the room's media address, so
  // the picture area holds the player and not words - in the app's window too.
  assert.deepEqual(pictureFor({ page: null, media: file, host: true }), { kind: 'player' })
  assert.deepEqual(pictureFor({ page: null, media: file, host: false }), { kind: 'player' })
  // §4.2: a pick clears the page, so an old page beside the file changes nothing.
  assert.deepEqual(pictureFor({ page: website, media: file, host: false }), { kind: 'player' })
})

test('a YouTube room with a window host is the site view, which carries the app embed', () => {
  // ADR-051: the app-owned embed is loaded into the window host's site view; the
  // page's picture area is not where that picture is drawn.
  assert.deepEqual(pictureFor({ page: youtube, media: null, host: true }), { kind: 'site' })
})

test('a YouTube room with no window host carries the app-owned embed', () => {
  // Ticket 179 fills the branch: the picture area holds the embed, so the choice
  // is not words at all, and the address it carries is the one the app's own
  // window builds for its site view (ADR-051, `siteViewAddress`).
  const choice = pictureFor({ page: youtube, media: null, host: false })
  assert.deepEqual(choice, { kind: 'youtube' })
  const origin = 'http://127.0.0.1:63144'
  assert.equal(siteViewAddress(youtube, origin), `${origin}/embed/youtube.html?id=dQw4w9WgXcQ`)
  // The address the page carries is one the app view already recognises as its own
  // embed, so the election's YouTube rule treats the browser's player like the
  // window's (ADR-051, ticket 157's `isYouTubeEmbedAddress`).
  assert.ok(isYouTubeEmbedAddress(siteViewAddress(youtube, origin)))
})

test('a room on an ordinary website is one plain sentence naming the app', () => {
  const choice = pictureFor({ page: website, media: null, host: false })
  assert.equal(choice.kind, 'words')
  if (choice.kind !== 'words') return
  // R54: one plain sentence naming the app as the way to watch that room.
  assert.equal(choice.text, BROWSER_SITE_SENTENCE)
  assert.ok(choice.text.includes('Watch Party'))
  // R54: never "waiting for the host" - the room is on a page, not on nothing.
  assert.ok(!/waiting for the host/i.test(choice.text))
  // Rules for working here 10: new sentences stay ASCII.
  assert.ok(/^[\x20-\x7e]+$/.test(choice.text), `not ASCII: ${choice.text}`)
})

test('the same website room in the app window is the host\'s site view, not words', () => {
  // ADR-006 as amended: the app's window works only because the window host
  // injects the bridge into its site view, so in that window the page is drawn.
  assert.deepEqual(pictureFor({ page: website, media: null, host: true }), { kind: 'site' })
})

test('a room on nothing yet keeps the player\'s own empty line, in either role', () => {
  // T150: before anything is picked the picture area says who picks; the player
  // draws that line (App.svelte's `emptyPictureLine`), so the branch is the player.
  assert.deepEqual(pictureFor({ page: null, media: null, host: false }), { kind: 'player' })
  assert.deepEqual(pictureFor({ page: null, media: null, host: true }), { kind: 'player' })
})

test('the refused-play line names who refused, once, for both pictures', () => {
  // Ticket 187 / T145: the file room's line (ticket 182) is now composed once and
  // carried by the browser guest's YouTube picture too. In a plain browser nothing
  // about the refusal is Windows - the browser's own autoplay rule is - so the
  // sentence says what is true where it is read (ticket 182's `NOT TESTED`).
  assert.equal(pressPlaySentence(true), 'Windows did not let the film start on its own.')
  assert.equal(pressPlaySentence(false), 'The browser did not let the film start on its own.')
  for (const line of [pressPlaySentence(true), pressPlaySentence(false)]) {
    // Rules for working here 10: sentences stay ASCII.
    assert.ok(/^[\x20-\x7e]+$/.test(line), `not ASCII: ${line}`)
  }
  // One button, one meaning: the press that answers the browser's rule.
  assert.equal(PRESS_PLAY_BUTTON, 'Click to join playback')
})
