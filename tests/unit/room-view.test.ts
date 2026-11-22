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

import { pageSide, HIDE_SITE_MESSAGE } from '../../src/ui/room-view.ts'
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
