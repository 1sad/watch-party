/**
 * Ticket 26 / ADR-038: a page-to-file switch must hide the site view.
 *
 * One rule is proved here and nothing else: a room that holds a file has no page
 * side at all, so a `media` frame (a pick in an existing room) and a `welcome`
 * that already carries a file both leave this window with no page and nothing
 * staged, and the app view tells the host to hide the pane. A room on a page is
 * still a site, and a room with neither still hides nothing. The wiring that
 * calls this predicate lives in `src/ui/App.svelte`, which has no DOM test; the
 * decision was put in a module so that this file can hold it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  pageSide,
  pageCommitFields,
  pageFollowOutcome,
  pageFollowStep,
  screenFor,
  siteAfterPreview,
  closeOutcome,
  HIDE_SITE_MESSAGE,
  NO_PUT_BACKS,
} from '../../src/ui/room-view.ts'
import type { Media } from '../../src/shared/protocol.ts'

/** The file the owner picked, as `welcome` and the `media` frame carry it (§4.2). */
const file: Media = {
  kind: 'file',
  id: 'm1',
  title: 'fixture',
  duration: 60,
  contentType: 'video/mp4',
}

test('a media frame leaves the room a file: no page, no preview, hide the site view', () => {
  // The frame carries only `media`; the sidecar cleared `page` when it took the
  // file (§4.2), so this is the room the media frame describes.
  assert.deepEqual(pageSide({ page: null, media: file }), { kind: 'file' })
  // And the window asks the host to take the pane away, by the one name the host
  // answers (`MainForm.OnWebMessageReceived`'s `hideSite` case).
  assert.deepEqual(HIDE_SITE_MESSAGE, { kind: 'hideSite' })
})

test('a welcome that carries a file is the same room, so a reconnect takes the pane away too', () => {
  // A window already showing a site view can reconnect into this snapshot, and
  // that window has a visible pane no `media` frame is coming to hide.
  assert.deepEqual(pageSide({ page: null, media: file }), { kind: 'file' })
})

test('a welcome on a page is still a site, and names the page the view shows', () => {
  const side = pageSide({ page: 'https://example.com/watch', media: null })
  assert.deepEqual(side, { kind: 'site', page: 'https://example.com/watch' })
})

test('a fresh room with neither a page nor a file has nothing to show and nothing to hide', () => {
  assert.deepEqual(pageSide({ page: null, media: null }), { kind: 'none' })
})

test('a room that somehow carried both is a file, so a stale address keeps no site view up', () => {
  assert.deepEqual(pageSide({ page: 'https://example.com/watch', media: file }), { kind: 'file' })
})

/**
 * T27 / ADR-032's amendment: a preview that ends without a commit. The address
 * the bar sent lives only in `pendingPreview` until `pageCommitted` writes it to
 * `roomPage` (§5), so the page handed back here is always the room's committed
 * one — the preview can never be what the site view is left showing.
 */
test('a preview that ended without a commit goes back to the committed page, never the preview', () => {
  assert.deepEqual(siteAfterPreview('https://example.com/film'), {
    kind: 'show',
    page: 'https://example.com/film',
  })
})

test('a preview cancelled in a room whose page was never set leaves no site view at all', () => {
  assert.deepEqual(siteAfterPreview(null), { kind: 'hide' })
})

/**
 * T37 / ADR-038's 2026-11-22 amendment, §4.2: a room that held a file may take a
 * page, and the page commit clears the file in every window. The case starts
 * from the window's own fields while it holds the file, so what it proves is the
 * rule `pageCommitted` runs: that window ends with `media === null` and the
 * committed page set.
 */
test('a page commit in a room that held a file drops the file and sets the page', () => {
  const window = { page: null, media: file }
  const committed = pageCommitFields(window, 'https://example.com/watch')
  assert.equal(committed.media, null)
  assert.equal(committed.page, 'https://example.com/watch')
})

/**
 * T95 / ADR-047: the window shows one of two screens. The room is live from the
 * sidecar's boot, so the first screen is its front door and the window leaves it
 * only by **entering** the room; an ended room puts it back there. Four cases,
 * because each one is a different fact the page can hold.
 */
test('a window that has not entered its room is on the first screen', () => {
  assert.equal(screenFor({ entered: false, roomEnded: false }), 'first')
})

test('a window that has entered its room is on the watching screen', () => {
  assert.equal(screenFor({ entered: true, roomEnded: false }), 'watching')
})

test('a room that ended puts an entered window back on the first screen', () => {
  assert.equal(screenFor({ entered: true, roomEnded: true }), 'first')
})

test('a window that never entered and whose room never ended is still on the first screen', () => {
  assert.equal(screenFor({ entered: false, roomEnded: true }), 'first')
})

/**
 * T98 / ADR-047 and `spec.md` §6's "connection drops": only the room's own
 * `roomOver` frame ends a room. The sidecar sends that frame and then closes
 * every socket (§14, `socket.ts`), so a close that follows it is the room's end;
 * a bare close is a dropped connection and must not clear the room (rejoining
 * is M3's, section 13). Three cases, one per fact a socket can hold.
 */
test("the room's own word ends the room, even as the socket closes", () => {
  assert.equal(closeOutcome({ sawRoomOver: true, closed: true }), 'ended')
})

test('a close with no roomOver frame is a lost connection, not an ending', () => {
  assert.equal(closeOutcome({ sawRoomOver: false, closed: true }), 'lost')
})

test('a socket that has not closed is still connected, whatever it has seen', () => {
  assert.equal(closeOutcome({ sawRoomOver: false, closed: false }), 'connected')
  assert.equal(closeOutcome({ sawRoomOver: true, closed: false }), 'ended')
})

/**
 * T105 / ADR-048: a site's own navigation is a page change like one typed into
 * the address bar. The decision compares through `canonicalPage` (ADR-032), so
 * only a genuinely different address can stage or be put back. Seven facts a
 * window can hold, one test each, plus the two "no address at all" cases.
 */
const followedRoom = 'https://example.com/watch/1'

test('a site that lands on the address the room is already on is not a change', () => {
  assert.equal(
    pageFollowOutcome({
      address: followedRoom,
      roomPage: followedRoom,
      previewPage: null,
      controller: true,
    }),
    'ignore',
  )
})

test('a reload or route change to the same canonical address is not a change', () => {
  // The query string is dropped by `canonicalPage` (ADR-032), so a reload with
  // a fresh cache-buster or a route that canonicalises back is the same page.
  assert.equal(
    pageFollowOutcome({
      address: 'https://example.com/watch/1?reload=2',
      roomPage: followedRoom,
      previewPage: null,
      controller: true,
    }),
    'ignore',
  )
})

test('a fragment on the room page is not a change', () => {
  assert.equal(
    pageFollowOutcome({
      address: 'https://example.com/watch/1#t=90',
      roomPage: followedRoom,
      previewPage: null,
      controller: true,
    }),
    'ignore',
  )
  // Neither is the same address written in another case.
  assert.equal(
    pageFollowOutcome({
      address: 'https://Example.COM/watch/1',
      roomPage: followedRoom,
      previewPage: null,
      controller: true,
    }),
    'ignore',
  )
})

test('a controller that lands on a new path stages it for the ordinary two seconds', () => {
  assert.equal(
    pageFollowOutcome({
      address: 'https://example.com/watch/2',
      roomPage: followedRoom,
      previewPage: null,
      controller: true,
    }),
    'stage',
  )
})

test('a guest that lands on a new path is put back on the room page', () => {
  assert.equal(
    pageFollowOutcome({
      address: 'https://example.com/watch/2',
      roomPage: followedRoom,
      previewPage: null,
      controller: false,
    }),
    'return',
  )
})

test("the navigation this window's own preview caused is not a second stage", () => {
  const previewPage = 'https://example.com/watch/2'
  assert.equal(
    pageFollowOutcome({
      address: previewPage,
      roomPage: followedRoom,
      previewPage,
      controller: true,
    }),
    'ignore',
  )
  // A fragment on the preview's address is still that same staged page.
  assert.equal(
    pageFollowOutcome({
      address: 'https://example.com/watch/2#resume',
      roomPage: followedRoom,
      previewPage,
      controller: true,
    }),
    'ignore',
  )
})

test('a guest in a room with no page yet is put back too, and the view is hidden', () => {
  assert.equal(
    pageFollowOutcome({
      address: 'https://example.com/watch/2',
      roomPage: null,
      previewPage: null,
      controller: false,
    }),
    'return',
  )
})

test('a controller in a room with no page yet stages the address it landed on', () => {
  assert.equal(
    pageFollowOutcome({
      address: 'https://example.com/watch/2',
      roomPage: null,
      previewPage: null,
      controller: true,
    }),
    'stage',
  )
})

/**
 * T147 / ADR-050: the put-back is bounded per window, per stray address and per
 * room page. Three put-backs, then a stop that is said once; the record a
 * `pageCommitted` clears puts the guest back once more, so a real page change is
 * still followed. The test holds the whole decision as the app calls it.
 */
test('one stray address is put back three times, then stopped, and a commit clears it', () => {
  const stray = 'https://example.com/redirect'
  const fields = {
    address: stray,
    roomPage: followedRoom,
    previewPage: null,
    controller: false,
  }
  const kinds: string[] = []
  const announces: boolean[] = []
  let record = NO_PUT_BACKS
  for (let tryNumber = 0; tryNumber < 4; tryNumber += 1) {
    const step = pageFollowStep(fields, record)
    record = step.record
    kinds.push(step.kind)
    if (step.kind === 'stop') announces.push(step.announce)
  }
  assert.deepEqual(kinds, ['putBack', 'putBack', 'putBack', 'stop'])
  // The stop is said once; a fifth try for the same pair is silent.
  assert.deepEqual(announces, [true])
  const again = pageFollowStep(fields, record)
  assert.equal(again.kind, 'stop')
  assert.equal(again.kind === 'stop' ? again.announce : null, false)

  // The clear a `pageCommitted` makes: the same pair is put back once more.
  assert.equal(pageFollowStep(fields, NO_PUT_BACKS).kind, 'putBack')

  // Another stray address is another pair and starts its own count.
  const other = { ...fields, address: 'https://example.com/other' }
  assert.equal(pageFollowStep(other, record).kind, 'putBack')

  // An ignored address and a staged one leave the record exactly as it was.
  assert.equal(pageFollowStep({ ...fields, address: followedRoom }, record).record, record)
  assert.equal(pageFollowStep({ ...fields, controller: true }, record).record, record)
})

test('no address, or one that cannot be shared, is ignored rather than staged', () => {
  assert.equal(
    pageFollowOutcome({
      address: null,
      roomPage: followedRoom,
      previewPage: null,
      controller: true,
    }),
    'ignore',
  )
  assert.equal(
    pageFollowOutcome({
      address: 'javascript:alert(1)',
      roomPage: followedRoom,
      previewPage: null,
      controller: true,
    }),
    'ignore',
  )
})
