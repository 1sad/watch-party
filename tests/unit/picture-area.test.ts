/**
 * Ticket 178 / R54, ADR-054 and ADR-006 as amended: the words a viewer with no
 * window host reads where the picture goes.
 *
 * One rule is proved here and nothing else: the picture area's content is chosen
 * in one place, by what the room is on and whether a window host is looking. A
 * file room is the player, a YouTube room with a host is the host's site view, a
 * YouTube room without one is ticket 179's picture (this case holds only that the
 * branch is chosen, not what 179 draws there), and a website room is one plain
 * sentence naming the app. The wiring that draws this lives in `src/ui/App.svelte`,
 * which has no DOM test; the rule was put in a module so that this file can hold
 * it (the same arrangement `tests/unit/room-view.test.ts` keeps).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BROWSER_SITE_SENTENCE,
  BROWSER_YOUTUBE_SENTENCE,
  pictureFor,
} from '../../src/ui/picture-area.ts'
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

test('a YouTube room with no window host is ticket 179\'s branch, chosen here', () => {
  // Ticket 179 puts the app-owned embed in the picture area; this ticket only
  // holds that the branch is the YouTube one - distinct from the website words.
  const choice = pictureFor({ page: youtube, media: null, host: false })
  assert.deepEqual(choice, { kind: 'youtube' })
  // The branch stands in as an app-naming sentence until 179 fills it (not tested
  // on screen here; the unit case holds the branch, not 179's picture).
  assert.ok(BROWSER_YOUTUBE_SENTENCE.includes('Watch Party'))
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
