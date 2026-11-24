/**
 * Ticket 03: §5's staged page, at the level where it is a fact about the room.
 *
 * Two rules are proved here and nothing else: the canonical form of an address
 * (§4.3 invariant 5, §10.3 — the security property, so the table below is the
 * test), and ADR-032's window (a pending entry, its expiry, its replacement, and
 * the commit that alone moves `page`). The wire half lives in
 * `tests/integration/page.test.ts`; the timer that expires a real entry belongs
 * to the socket, so nothing here waits on one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalPage, setPageFrame } from '../../src/shared/page.ts'
import type { Member } from '../../src/shared/protocol.ts'
import {
  PAGE_STAGE_MS,
  cancelPage,
  commitDuePage,
  createRoom,
  dropPendingPage,
  joinRoom,
  setMedia,
  snapshot,
  stagePage,
  type RoomState,
} from '../../src/server/room.ts'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(new URL('../fixtures/fixture.mp4', import.meta.url))

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

/** A room with `sam` holding control (the window's own page) and `alex` a guest. */
function roomWithTwo(): { room: RoomState; owner: string; guest: string } {
  const room = createRoom('PAGE01')
  joinRoom(room, member('sam', 1), { isLocal: true })
  joinRoom(room, member('alex', 2), { isLocal: false })
  return { room, owner: 'sam', guest: 'alex' }
}

// §4.3 invariant 5 / §10.3: "the room never stores a tokenised or private URL;
// `page` is stored with its query string stripped". A tokenised link must never
// travel to another member, so each row is a case and not a convenience.
const CANONICAL: Array<[string, string | null]> = [
  // A bare host is https, and canonical in is canonical out.
  ['example.com/watch/abc', 'https://example.com/watch/abc'],
  ['https://example.com/watch/abc', 'https://example.com/watch/abc'],
  // The host and the scheme are case-insensitive; the path is not.
  ['HTTPS://EXAMPLE.COM/Watch/Abc', 'https://example.com/Watch/Abc'],
  ['http://example.com/a/b', 'http://example.com/a/b'],
  // **Query and fragment dropped** — the one that must not regress.
  ['https://example.com/watch?token=secret123', 'https://example.com/watch'],
  ['https://example.com/watch/abc?t=30&sig=abc#t=42', 'https://example.com/watch/abc'],
  ['example.com/watch?token=secret123', 'https://example.com/watch'],
  ['https://example.com/watch#fragment', 'https://example.com/watch'],
  ['https://example.com/watch?#', 'https://example.com/watch'],
  // Anything in front of the host is a secret in a shared address too.
  ['https://user:pass@example.com/watch', 'https://example.com/watch'],
  // A port is part of where the page is, and a host written with one is not a scheme.
  ['https://example.com:8443/watch', 'https://example.com:8443/watch'],
  ['localhost:3000/watch', 'https://localhost:3000/watch'],
  // No path is the root, so the form is stable.
  ['example.com', 'https://example.com/'],
  // Spaces around what someone pasted are not part of the address.
  ['  https://example.com/watch  ', 'https://example.com/watch'],
  // Everything that is not a web page is refused, because every app in the room
  // would run it.
  ['ftp://example.com/watch', null],
  ['file:///C:/film.mp4', null],
  ['javascript:alert(1)', null],
  ['data:text/html,<p>hi</p>', null],
  ['ws://example.com/socket', null],
  ['', null],
  ['   ', null],
  ['not a url', null],
  ['https://', null],
]

test('T03: the canonical address table — https, lowercased host, no query, no fragment', () => {
  for (const [raw, expected] of CANONICAL) {
    assert.equal(canonicalPage(raw), expected, `canonicalPage(${JSON.stringify(raw)})`)
  }
})

test('T03: canonicalisation is idempotent, so a stored page equals a fresh one', () => {
  for (const [raw, expected] of CANONICAL) {
    if (expected === null) continue
    assert.equal(canonicalPage(expected), expected, `canonicalPage(${JSON.stringify(expected)})`)
  }
})

test('T03: a controller’s setPage is held, not applied — the room has not changed yet', () => {
  const { room, owner } = roomWithTwo()
  let clock = 10_000
  const now = (): number => clock

  const revisionBefore = room.revision
  const result = stagePage(room, owner, 'https://Example.com/watch?token=abc', room.authority.epoch, now)
  assert.equal(result.ok, true)
  assert.deepEqual(room.pendingPage, {
    page: 'https://example.com/watch',
    by: owner,
    expiresAt: 10_000 + PAGE_STAGE_MS,
  })
  assert.equal(room.page, null, 'nothing is the room’s page until the window ends')
  assert.equal(snapshot(room).page, null, 'no snapshot carries the pending page')
  assert.equal(room.revision, revisionBefore, 'a pending change is not a write (§4.3 invariant 2)')

  // One millisecond short of the window, and still nothing.
  clock = 11_999
  assert.equal(commitDuePage(room, now), null)
  assert.equal(room.page, null, 'the entry expires at 2 s, not before')

  clock = 12_000
  const commit = commitDuePage(room, now)
  assert.deepEqual(commit, { page: 'https://example.com/watch', by: owner, at: 12_000 })
  assert.equal(room.page, 'https://example.com/watch')
  assert.equal(room.pendingPage, null, 'a committed entry is gone from the room')
  assert.equal(room.revision, revisionBefore + 1, 'the commit is one write, and one only')
  // The window is the authority's own constant; the entry above is the proof it
  // is two seconds and not something a sender chose.
  assert.equal(PAGE_STAGE_MS, 2000)
})

test('T03: the commit clears media and puts playback at 0, paused — a new page is a new film', () => {
  const { room, owner } = roomWithTwo()
  const picked = setMedia(
    room,
    owner,
    { id: 'f1', title: 'Fixture', duration: 60, path: FIXTURE, epoch: room.authority.epoch },
    (path) => path === FIXTURE,
  )
  assert.equal(picked.ok, true)
  room.playback = { playing: true, position: 42, updatedAt: 1, rate: 1 }

  let clock = 0
  stagePage(room, owner, 'example.com/later', room.authority.epoch, () => clock)
  clock = PAGE_STAGE_MS
  assert.ok(commitDuePage(room, () => clock) !== null)

  assert.equal(room.media, null, '§4.2: the file and the page never coexist')
  assert.deepEqual(room.playback, { playing: false, position: 0, updatedAt: clock, rate: 1 })
})

test('T03: a second setPage replaces the first, and the window starts again from now', () => {
  const { room, owner } = roomWithTwo()
  let clock = 1000
  const now = (): number => clock

  stagePage(room, owner, 'example.com/first', room.authority.epoch, now)
  clock = 1500
  stagePage(room, owner, 'example.com/second', room.authority.epoch, now)
  assert.deepEqual(room.pendingPage, {
    page: 'https://example.com/second',
    by: owner,
    expiresAt: 1500 + PAGE_STAGE_MS,
  })

  // The first entry's deadline has passed (1000 + 2 s) and must not commit it;
  // the replacement's window is still open, because it started when it arrived.
  clock = 3000
  assert.equal(commitDuePage(room, now), null, 'the window restarted from the second request')
  clock = 3500
  assert.equal(commitDuePage(room, now)?.page, 'https://example.com/second')
})

test('T03: a disconnect discards the pending entry and nobody ever learns it existed', () => {
  const { room, owner, guest } = roomWithTwo()
  let clock = 0
  const now = (): number => clock
  stagePage(room, owner, 'example.com/later', room.authority.epoch, now)

  assert.equal(dropPendingPage(room, guest), false, 'another member’s window is not theirs to close')
  assert.notEqual(room.pendingPage, null)
  assert.equal(dropPendingPage(room, owner), true, 'the initiator leaving takes the entry with them')
  assert.equal(room.pendingPage, null)

  clock = 10_000
  assert.equal(commitDuePage(room, now), null, 'the expired entry cannot commit after it was discarded')
  assert.equal(room.page, null)
})

test('T03: cancelPage clears its own pending entry and nothing else', () => {
  const { room, owner } = roomWithTwo()
  const epoch = room.authority.epoch

  assert.deepEqual(cancelPage(room, owner, epoch), { ok: true, cancelled: false }, 'nothing to cancel yet')

  stagePage(room, owner, 'example.com/later', epoch)
  assert.deepEqual(cancelPage(room, owner, epoch), { ok: true, cancelled: true })
  assert.equal(room.pendingPage, null)
  assert.equal(room.page, null, 'a cancelled change leaves the room exactly as it was')
  // The window it closed is closed: no page arrives late.
  assert.equal(commitDuePage(room, () => Number.MAX_SAFE_INTEGER), null)
})

test('T03: a guest cannot stage a page, and a refusal writes nothing', () => {
  const { room, guest } = roomWithTwo()
  const revisionBefore = room.revision
  assert.deepEqual(stagePage(room, guest, 'example.com/x', room.authority.epoch), {
    ok: false,
    code: 'not_controller',
  })
  assert.equal(room.pendingPage, null)
  assert.equal(room.revision, revisionBefore)

  // §5: authority-bearing frames carry the epoch; a stale one is refused.
  assert.deepEqual(stagePage(room, 'sam', 'example.com/x', room.authority.epoch + 1), {
    ok: false,
    code: 'stale_host',
  })
  assert.equal(room.pendingPage, null)

  // An address that cannot be shared is a `bad_page` refusal, which the socket
  // drops rather than sending: §5 has no code for it.
  assert.deepEqual(stagePage(room, 'sam', 'javascript:alert(1)', room.authority.epoch), {
    ok: false,
    code: 'bad_page',
  })
  assert.equal(room.pendingPage, null)
})

test('T03: a file pick replaces a pending page instead of being wiped by it', () => {
  const { room, owner } = roomWithTwo()
  let clock = 0
  const now = (): number => clock
  stagePage(room, owner, 'example.com/later', room.authority.epoch, now)

  const picked = setMedia(
    room,
    owner,
    { id: 'f1', title: 'Fixture', duration: 60, path: FIXTURE, epoch: room.authority.epoch },
    (path) => path === FIXTURE,
  )
  assert.equal(picked.ok, true)
  assert.equal(room.pendingPage, null, '§4.2: a file pick and a page change never coexist')

  clock = 10_000
  assert.equal(commitDuePage(room, now), null)
  assert.equal(room.page, null)
  assert.notEqual(room.media, null, 'the file the owner picked is still the room’s')
})

test('T146: a pick of a new film resets the room to 0, paused — ADR-050', () => {
  const { room, owner } = roomWithTwo()
  let clock = 1
  const now = (): number => clock
  const first = setMedia(
    room,
    owner,
    { id: 'f1', title: 'Long film', duration: 720, path: FIXTURE, epoch: room.authority.epoch },
    (path) => path === FIXTURE,
    now,
  )
  assert.equal(first.ok, true)
  // The room played the first film to 50 s, as the owner's report had it.
  room.playback = { playing: true, position: 50, updatedAt: clock, rate: 1 }
  const revisionBefore = room.revision

  clock = 5000
  const picked = setMedia(
    room,
    owner,
    { id: 'f2', title: 'Next film', duration: 60, path: FIXTURE, epoch: room.authority.epoch },
    (path) => path === FIXTURE,
    now,
  )
  assert.equal(picked.ok, true)
  assert.equal(room.playback.position, 0, 'the old film’s 50 s is not the new film’s position')
  assert.equal(room.playback.playing, false, 'a picked file starts paused')
  assert.deepEqual(room.playback, { playing: false, position: 0, updatedAt: 5000, rate: 1 })
  assert.equal(room.revision, revisionBefore + 1, 'the reset is part of the one pick write')
  assert.equal(room.media?.id, 'f2')
})

// ---- 03b: what Enter in the address bar may send -------------------------------

test('T03b: an unusable address sends no setPage', () => {
  // The authority drops such an address silently (ticket 03), so a page that
  // sent one would leave the person with no sentence and the room unchanged.
  for (const raw of ['not a url', 'ftp://example.com/watch', 'javascript:alert(1)']) {
    assert.equal(setPageFrame(raw, 4), null, `setPageFrame(${JSON.stringify(raw)})`)
  }
})

// The live check found this one: Chromium's parser accepts a space in the host
// and percent-encodes it, while Node's throws, so the page used to send a
// setPage the authority dropped silently. The rule is in `canonicalPage`, so
// both halves refuse it; this case is here to keep the rule from being removed.
test('T03b: whitespace is refused before either URL parser sees it', () => {
  for (const raw of ['not a url', 'https://not a url', 'exa mple.com/watch', 'example.com/a b']) {
    assert.equal(canonicalPage(raw), null, `canonicalPage(${JSON.stringify(raw)})`)
    assert.equal(setPageFrame(raw, 4), null, `setPageFrame(${JSON.stringify(raw)})`)
  }
})

test('T03b: Enter with an empty field sends nothing', () => {
  assert.equal(setPageFrame('', 4), null)
  assert.equal(setPageFrame('   ', 4), null)
})

test('T03b: a usable address sends one canonical setPage carrying the room’s epoch', () => {
  const frame = setPageFrame('  EXAMPLE.com/watch?token=secret  ', 7)
  assert.deepEqual(frame, {
    type: 'setPage',
    page: 'https://example.com/watch',
    epoch: 7,
  })
})
