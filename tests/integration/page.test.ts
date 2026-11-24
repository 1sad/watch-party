/**
 * Ticket 03: §5's staged page on real sockets, with no window in the way.
 *
 * ADR-032's shape is what these cases are for, and it is a fact about **when**
 * frames arrive: the authority owns the two-second window, so nothing reaches
 * any other client before it ends, exactly one `pageCommitted` arrives after it,
 * and a cancel leaves no trace at all. A client holds no timer here — nothing in
 * this file waits on a page to make the design work; it waits only to watch the
 * authority do it.
 *
 * The canonicalisation table is a unit test (`tests/unit/page.test.ts`); the one
 * case here is the one that could only be proved over the wire: a tokenised
 * address is stored without its query string.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  ERROR_SENTENCES,
  type ErrorFrame,
  type PageCommittedFrame,
  type ServerFrame,
} from '../../src/shared/protocol.ts'
import { PAGE_STAGE_MS } from '../../src/server/room.ts'
import type { ScriptedClient } from '../support/client.ts'
import { settle, startHarness, waitFor } from './harness.ts'

const FIXTURE = fileURLToPath(new URL('../fixtures/fixture.mp4', import.meta.url))
const TOKENISED = 'https://Example.com/watch/abc?token=secret123#t=42'
const CANONICAL = 'https://example.com/watch/abc'

const pageCommits = (client: ScriptedClient): Array<{ frame: PageCommittedFrame; at: number }> =>
  client.frames.filter(
    (record): record is { frame: PageCommittedFrame; at: number } =>
      record.frame.type === 'pageCommitted',
  )

test('T03: a staged page is silent for the whole window, then exactly one pageCommitted arrives', async () => {
  const harness = await startHarness({ clients: 2 })
  try {
    const owner = harness.owner
    const guest = harness.guests[0] as ScriptedClient
    const revisionBefore = harness.room.revision
    assert.equal(owner.welcome.room.page, null, 'the room opens with no page')

    const sentAt = Date.now()
    owner.send({ type: 'setPage', page: TOKENISED, epoch: owner.welcome.epoch })

    // The window is still open: held, invisible, and not a write.
    await settle(1000)
    assert.equal(harness.room.page, null, 'the room’s page has not moved after 1 s')
    assert.equal(harness.room.pendingPage?.page, CANONICAL, 'the address was canonicalised when it was staged')
    assert.equal(harness.room.revision, revisionBefore, 'a pending page is not a write (§4.3 invariant 2)')
    assert.deepEqual(pageCommits(guest), [], 'no pageCommitted reached the guest in the first second')
    assert.deepEqual(pageCommits(owner), [], 'not even the sender is told yet — the window is not over')

    // "The initiating member's own snapshot never carries the pending page": a
    // snapshot is what `welcome` is, so a window that arrives mid-window reads
    // the room as it still is.
    const late = await harness.join('late')
    assert.equal(late.welcome.room.page, null, 'a joiner during the window sees no page at all')
    assert.equal(
      Object.keys(late.welcome.room).includes('pendingPage'),
      false,
      'the pending entry is not a wire field',
    )
    // The join itself is a write (§4.3 invariant 2), so the commit is counted
    // from here rather than from the start of the window.
    const revisionAfterJoin = harness.room.revision

    // ...and exactly one commit, after the window and never before it.
    const arrival = await guest.next((frame) => frame.type === 'pageCommitted', PAGE_STAGE_MS + 2000)
    assert.ok(
      arrival.at - sentAt >= PAGE_STAGE_MS,
      `the first pageCommitted arrived ${arrival.at - sentAt} ms after the setPage, before the 5 s window ended`,
    )

    await settle(400)
    for (const client of [owner, guest, late]) {
      const commits = pageCommits(client)
      assert.equal(commits.length, 1, `${client.name} was told exactly once`)
      assert.ok(
        commits[0]!.at - sentAt >= PAGE_STAGE_MS,
        `${client.name}'s pageCommitted was not early`,
      )
    }

    const commit = pageCommits(guest)[0]!.frame
    assert.equal(commit.page, CANONICAL, 'the commit carries the canonical address')
    assert.equal(commit.by, owner.selfId, 'the commit names whoever staged it')
    assert.equal(typeof commit.at, 'number')
    assert.equal(
      JSON.stringify(commit).includes('secret'),
      false,
      'a tokenised address never reaches another member',
    )

    assert.equal(harness.room.page, CANONICAL, 'the room stores the address without its query string')
    assert.equal(harness.room.pendingPage, null)
    assert.equal(harness.room.revision, revisionAfterJoin + 1, 'the commit is exactly one write')
  } finally {
    await harness.close()
  }
})

test('T03: a guest’s setPage is refused `not_controller`, in the sentence already shipped', async () => {
  const harness = await startHarness({ clients: 2 })
  try {
    const guest = harness.guests[0] as ScriptedClient
    guest.send({ type: 'setPage', page: 'example.com/x', epoch: guest.welcome.epoch })

    const refusal = (await guest.next((frame) => frame.type === 'error')).frame as ErrorFrame
    assert.equal(refusal.code, 'not_controller')
    assert.equal(refusal.message, ERROR_SENTENCES.not_controller, '§5: a refusal is explicit, in one sentence')
    assert.equal(harness.room.pendingPage, null, 'a refused setPage stages nothing')

    await settle(300)
    assert.deepEqual(pageCommits(harness.owner), [], 'and nobody is told anything')
  } finally {
    await harness.close()
  }
})

test('T03: cancelPage inside the window leaves no pageCommitted and the old page in place', async () => {
  const harness = await startHarness({ clients: 2 })
  try {
    const owner = harness.owner
    const guest = harness.guests[0] as ScriptedClient
    owner.send({ type: 'setPage', page: 'example.com/later', epoch: owner.welcome.epoch })
    await settle(500)
    assert.notEqual(harness.room.pendingPage, null, 'the entry is pending when cancel arrives')
    owner.send({ type: 'cancelPage', epoch: owner.welcome.epoch })
    await waitFor(() => harness.room.pendingPage === null, 1000, 'the pending page was cleared')

    // 2.5 s after the setPage: the window has been and gone with nothing to commit.
    await settle(2500)
    assert.deepEqual(pageCommits(guest), [], 'the other client never heard of the cancelled page')
    assert.deepEqual(pageCommits(owner), [], 'and neither did the sender: a cancel is not a commit')
    assert.equal(harness.room.page, null, 'the room’s page is still the old value')
    assert.equal(harness.room.pendingPage, null)
    const mentions = (client: ScriptedClient): ServerFrame[] =>
      client.frames
        .map((record) => record.frame)
        .filter((frame) => JSON.stringify(frame).includes('later'))
    assert.deepEqual(mentions(guest), [], 'not a flicker, not a chat line: nothing at all')
  } finally {
    await harness.close()
  }
})

test('T03: the commit clears the file and resets playback to 0, paused', async () => {
  const harness = await startHarness({ clients: 2, duration: 60 })
  try {
    const owner = harness.owner
    const guest = harness.guests[0] as ScriptedClient

    owner.send({
      type: 'setMedia',
      id: 'f1',
      title: 'Fixture',
      duration: 60,
      path: FIXTURE,
      epoch: owner.welcome.epoch,
    })
    await waitFor(() => harness.room.media !== null, 2000, 'the room holds the fixture')

    const playing = harness.clients.map((client) => client.next((frame) => frame.type === 'state'))
    owner.send({ type: 'play', position: 10 })
    await Promise.all(playing)
    assert.equal(harness.room.playback.playing, true)
    assert.equal(harness.room.playback.position, 10)

    owner.send({ type: 'setPage', page: 'example.com/next-film', epoch: owner.welcome.epoch })
    await guest.next((frame) => frame.type === 'pageCommitted', PAGE_STAGE_MS + 2000)

    assert.equal(harness.room.page, 'https://example.com/next-film')
    assert.equal(harness.room.media, null, '§4.2: the file and the page never coexist')
    assert.deepEqual(harness.room.playback, {
      playing: false,
      position: 0,
      updatedAt: harness.room.playback.updatedAt,
      rate: 1,
    })

    // A window arriving after the commit reads the same two facts from `welcome`.
    const late = await harness.join('late')
    assert.equal(late.welcome.room.page, 'https://example.com/next-film')
    assert.equal(late.welcome.room.media, null)
    assert.equal(late.welcome.room.playback.playing, false)
    assert.equal(late.welcome.room.playback.position, 0)
  } finally {
    await harness.close()
  }
})

test('T03: an address that cannot be shared is dropped, never turned into a page or an error', async () => {
  const harness = await startHarness({ clients: 2 })
  try {
    const owner = harness.owner
    // §4.3 invariant 5: every app in the room would run this. §5 has no code for
    // it, so it is dropped the way an unreadable frame is.
    owner.send({ type: 'setPage', page: 'javascript:alert(1)', epoch: owner.welcome.epoch })
    owner.send({ type: 'setPage', page: 'ftp://example.com/file', epoch: owner.welcome.epoch })

    await settle(300)
    assert.equal(harness.room.pendingPage, null, 'nothing was staged')
    assert.equal(harness.room.page, null)
    assert.deepEqual(
      owner.frames.map((record) => record.frame).filter((frame) => frame.type === 'error'),
      [],
      'no invented refusal code was sent',
    )
    assert.deepEqual(pageCommits(harness.guests[0] as ScriptedClient), [])
  } finally {
    await harness.close()
  }
})
