/**
 * Ticket 156, ADR-051 / R46: a YouTube address names a film, and the room stores
 * that film in one form.
 *
 * Two rules are proved here: the id parser (`youtubeVideoId`), which the sidecar
 * also uses so it can never build an embed for something it did not read the
 * same way, and the one exception to ADR-052 that `canonicalPage` makes - a
 * YouTube video address reaches the room as `https://www.youtube.com/watch?v=<id>`
 * and a stored `youtu.be` link with `&t=30` is the same page. Every other
 * address is untouched, which the table below says out loud.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalPage } from '../../src/shared/page.ts'
import {
  YOUTUBE_EMBED_PATH,
  YOUTUBE_PAGE,
  isYouTubeEmbedAddress,
  isYouTubeVideoId,
  siteViewAddress,
  youtubeVideoId,
} from '../../src/shared/youtube.ts'
import type { Member } from '../../src/shared/protocol.ts'
import { createRoom, joinRoom, stagePage } from '../../src/server/room.ts'

/** A real, embeddable id; the live check uses the same one. */
const ID = 'aqz-KE-bpKQ'

function member(id: string, joinedAt: number): Member {
  return {
    id,
    name: id,
    joinedAt,
    transport: 'app',
    status: 'online',
    lastSeen: joinedAt,
    rtt: 0,
    timelineOffset: 0,
    source: null,
    driftStrikes: 0,
    ready: false,
    address: null,
  }
}

function roomWithTwo() {
  const room = createRoom('YT1560')
  joinRoom(room, member('sam', 1), { isLocal: true })
  joinRoom(room, member('alex', 2), { isLocal: false })
  return room
}

// The addresses a person actually pastes, and the id each names - or null for
// everything that is not one of YouTube's video addresses.
const IDS: Array<[string, string | null]> = [
  [`https://www.youtube.com/watch?v=${ID}`, ID],
  [`youtube.com/watch?v=${ID}`, ID],
  [`http://youtube.com/watch?v=${ID}`, ID],
  // The suffix is where the URL parser holds `t=30` - the ticket's own case.
  [`https://www.youtube.com/watch?v=${ID}&t=30`, ID],
  [`https://youtu.be/${ID}`, ID],
  [`https://www.youtube.com/shorts/${ID}`, ID],
  [`https://www.youtube.com/embed/${ID}`, ID],
  [`https://www.youtube.com/embed/${ID}?autoplay=1`, ID],
  // Not a film: another site, YouTube's front page, a channel, a playlist.
  ['https://example.com/watch?v=aqz-KE-bpKQ', null],
  ['https://www.youtube.com/', null],
  ['https://www.youtube.com/@someone', null],
  ['https://www.youtube.com/playlist?list=PL123', null],
  ['https://www.youtube.com/watch?t=30', null],
  ['https://notyoutube.com/watch?v=aqz-KE-bpKQ', null],
  ['https://not youtube.com/watch', null],
  ['', null],
]

test('youtubeVideoId reads the four video address forms and refuses everything else', () => {
  for (const [address, expected] of IDS) {
    assert.equal(youtubeVideoId(address), expected, `youtubeVideoId(${JSON.stringify(address)})`)
  }
  assert.equal(isYouTubeVideoId(ID), true)
  assert.equal(isYouTubeVideoId('aqz-KE-bpK'), false)
})

test('isYouTubeVideoId accepts exactly eleven id characters', () => {
  assert.equal(isYouTubeVideoId('aqz-KE-bpKQ'), true)
  assert.equal(isYouTubeVideoId('aqz-KE-bpKQX'), false)
  assert.equal(isYouTubeVideoId('aqz KE bpKQ'), false)
  assert.equal(isYouTubeVideoId(''), false)
})

// ADR-051: "one form for one film". The room's page is the watch address built
// from the id, so a share link, a short link and a start offset all collapse to
// the page the other four windows load.
test('the room page for a YouTube address is the one watch form, with t= dropped', () => {
  const expected = `${YOUTUBE_PAGE}${ID}`
  assert.equal(expected, `https://www.youtube.com/watch?v=${ID}`)

  for (const address of [
    `https://www.youtube.com/watch?v=${ID}&t=30`,
    `https://youtu.be/${ID}?t=30`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `youtube.com/watch?v=${ID}`,
  ]) {
    assert.equal(canonicalPage(address), expected, address)
  }

  // Canonical in, the same canonical out (the parser's idempotence).
  assert.equal(canonicalPage(expected), expected)
})

// The exception is one host wide. Everything else keeps exactly the address it
// had before ticket 156 - ADR-052's query and fragment included.
test('a page that is not a YouTube video keeps exactly the address it has today', () => {
  assert.equal(
    canonicalPage('https://example.com/watch?v=aqz-KE-bpKQ&t=30'),
    'https://example.com/watch?v=aqz-KE-bpKQ&t=30',
  )
  assert.equal(canonicalPage('https://www.youtube.com/@someone?x=1'), 'https://www.youtube.com/@someone?x=1')
  assert.equal(canonicalPage('https://www.youtube.com/playlist?list=PL123'), 'https://www.youtube.com/playlist?list=PL123')
})

// The ticket's second half of item 2: what `stagePage` stores is the normalised
// address, because it goes through `canonicalPage` before it becomes pending.
test('stagePage stores a youtu.be link as the one watch form', () => {
  const room = roomWithTwo()
  const outcome = stagePage(room, 'sam', `https://youtu.be/${ID}?t=30`, room.authority.epoch)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok ? outcome.pending.page : null, `https://www.youtube.com/watch?v=${ID}`)
})

// Ticket 156b, ADR-051: the room keeps the one watch form, and the site view is
// pointed at the app's own embed for that film. The origin is the window's own,
// so the sidecar that serves the embed is the one that served the page.
const ORIGIN = 'http://127.0.0.1:51234'

test('a room on the normalised YouTube address loads the app embed in the site view', () => {
  const embed = `${ORIGIN}${YOUTUBE_EMBED_PATH}?id=${ID}`
  assert.equal(YOUTUBE_EMBED_PATH, '/embed/youtube.html')
  assert.equal(siteViewAddress(`https://www.youtube.com/watch?v=${ID}`, ORIGIN), embed)
  // Whatever YouTube form reached the room, the picture is the same film's embed.
  for (const address of [
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `youtube.com/watch?v=${ID}&t=30`,
  ]) {
    assert.equal(siteViewAddress(address, ORIGIN), embed, address)
  }
  // An origin written with its trailing slash is the same origin.
  assert.equal(siteViewAddress(`https://www.youtube.com/watch?v=${ID}`, `${ORIGIN}/`), embed)
})

test('every other page is loaded in the site view exactly as the room stores it', () => {
  const address = 'https://example.com/watch/1?ep=2#t=90'
  assert.equal(siteViewAddress(address, ORIGIN), address)
  // YouTube's front page is not a film, so it keeps its own address too.
  const front = 'https://www.youtube.com/@someone'
  assert.equal(siteViewAddress(front, ORIGIN), front)
})

test("the app's own embed is recognised by its path, whatever the id or origin", () => {
  assert.equal(isYouTubeEmbedAddress(`${ORIGIN}${YOUTUBE_EMBED_PATH}?id=${ID}`), true)
  assert.equal(isYouTubeEmbedAddress(`${ORIGIN}${YOUTUBE_EMBED_PATH}`), true)
  // The room's page and YouTube's own embed page are not the app's embed.
  assert.equal(isYouTubeEmbedAddress(`https://www.youtube.com/watch?v=${ID}`), false)
  assert.equal(isYouTubeEmbedAddress(`https://www.youtube.com/embed/${ID}`), false)
  assert.equal(isYouTubeEmbedAddress('not an address'), false)
})
