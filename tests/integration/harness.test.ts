import test from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage, StateFrame } from '../../src/shared/protocol.ts'
import { ScriptedClient } from '../support/client.ts'
import {
  CODE,
  injectSkew,
  settle,
  startHarness,
  waitFor,
} from './harness.ts'

// T7a's own assertions, on the shared harness (phase spec §7 B). The tickets
// that follow add theirs here: T7b the drift ladder, T8 the scheduled start.
// Nothing in this file opens a window or a DOM — it drives §5's frames only.

const stateCount = (client: ScriptedClient): number =>
  client.frames.filter((record) => record.frame.type === 'state').length

test('R6: one owner play reaches all three within 300 ms as exactly one state, and the players are in step 2 s later', async () => {
  const harness = await startHarness({ clients: 3 })
  try {
    const sentAt = Date.now()
    harness.owner.send({ type: 'play', position: 30 })

    // §5: `state` goes to everyone, sender included.
    const seen = await Promise.all(
      harness.clients.map((client) => client.next((frame) => frame.type === 'state')),
    )
    for (const [index, record] of seen.entries()) {
      const client = harness.clients[index]!
      const latencyMs = record.at - sentAt
      assert.ok(latencyMs < 300, `${client.name} saw the play in ${latencyMs} ms (R6 allows 300)`)
      const state = record.frame as StateFrame
      assert.equal(state.reason, 'play')
      assert.equal(state.playback.playing, true)
      assert.equal(state.playback.position, 30)
    }

    // §5's idempotency rule and §4.3 invariant 8: one command, one `state`,
    // whichever end you count from.
    await settle(300)
    for (const client of harness.clients) {
      assert.equal(stateCount(client), 1, `${client.name} saw exactly one state for one play`)
    }

    // §6.2 says a playing room moves on. Each fake player is read against the
    // stopwatch, not against `expected()`: a player and a room that were both
    // wrong would otherwise agree with each other.
    // The gate only establishes that all three adopted the announcement; the
    // check below is the in-step one.
    await waitFor(
      () =>
        harness.clients.every(
          (client) => client.player.currentTime >= 29.5 && client.player.currentTime < 32,
        ),
      1000,
      'every player adopted the announced 30 s',
    )
    const before = harness.clients.map((client) => ({ at: Date.now(), position: client.player.currentTime }))
    await settle(2000)
    const after = harness.clients.map((client) => ({ at: Date.now(), position: client.player.currentTime }))

    for (const [index, client] of harness.clients.entries()) {
      const elapsedS = (after[index]!.at - before[index]!.at) / 1000
      const advancedS = after[index]!.position - before[index]!.position
      assert.ok(
        Math.abs(advancedS - elapsedS) <= 0.25,
        `${client.name} advanced ${advancedS.toFixed(3)} s in ${elapsedS.toFixed(3)} s of wall clock (R6 allows 250 ms)`,
      )
    }
    const positions = after.map((sample) => sample.position)
    const spread = Math.max(...positions) - Math.min(...positions)
    assert.ok(spread < 0.25, `the three players are ${(spread * 1000).toFixed(1)} ms apart (R6 allows 250)`)
  } finally {
    await harness.close()
  }
})

test('R6: a seek from the controller converges all three players within 2 s as exactly one state', async () => {
  const harness = await startHarness({ clients: 3 })
  try {
    const sentAt = Date.now()
    harness.owner.send({ type: 'seek', position: 45, wasPlaying: false })
    const seen = await Promise.all(
      harness.clients.map((client) => client.next((frame) => frame.type === 'state')),
    )

    for (const [index, record] of seen.entries()) {
      const client = harness.clients[index]!
      assert.ok(record.at - sentAt < 300, `${client.name} saw the seek in ${record.at - sentAt} ms`)
      const state = record.frame as StateFrame
      assert.equal(state.reason, 'seek')
      assert.equal(state.playback.playing, false)
    }

    // The assertion the ticket names: all three, within 2 s, at the one place
    // the controller asked for (§6.2, paused, so it does not drift while we look).
    await waitFor(
      () => harness.clients.every((client) => Math.abs(client.player.currentTime - 45) < 0.25),
      2000,
      'all three players converged on 45 s',
    )

    await settle(300)
    for (const client of harness.clients) {
      assert.equal(stateCount(client), 1, `${client.name} saw exactly one state for one seek`)
    }

    // A paused room does not move on its own, so a second later they are still
    // there — the convergence is a position, not a passing frame.
    await settle(1000)
    for (const client of harness.clients) {
      assert.ok(
        Math.abs(client.player.currentTime - 45) < 0.25,
        `${client.name} drifted to ${client.player.currentTime.toFixed(3)} s while paused`,
      )
    }
  } finally {
    await harness.close()
  }
})

test('R4: one chat message reaches all three members, sender included, with one identity', async () => {
  const harness = await startHarness({ clients: 3 })
  try {
    harness.owner.send({ type: 'chat', text: 'hello room' })
    const seen = await Promise.all(
      harness.clients.map((client) => client.next((frame) => frame.type === 'chat' && frame.kind === 'user')),
    )

    for (const [index, record] of seen.entries()) {
      const client = harness.clients[index]!
      const message = record.frame as ChatMessage & { type: 'chat' }
      assert.equal(message.text, 'hello room', `${client.name} received the message`)
      // §4.6: the authority assigns the id, so every window shows the same line.
      assert.equal(message.id, (seen[0]!.frame as ChatMessage).id, 'one message, one id everywhere')
      assert.equal(typeof message.ts, 'number')
      assert.equal(message.memberId, harness.owner.selfId, 'the line carries its sender')
    }
  } finally {
    await harness.close()
  }
})

test('R5: a 120-message burst leaves exactly the last 100 in a late joiner’s tail', async () => {
  // §4.6's rate limit is 5 per 10 s, so the burst is spaced on the authority's
  // own clock rather than by waiting two minutes of wall clock. Nothing else in
  // this test reads that clock.
  let authorityClock = 1_000_000
  const harness = await startHarness({ clients: 1, now: () => authorityClock })
  try {
    for (let index = 1; index <= 120; index += 1) {
      authorityClock += 11_000
      const echo = await harness.owner.say(`burst ${index}`)
      assert.equal(echo.frame.type === 'chat' ? echo.frame.text : '', `burst ${index}`)
    }

    const late = await harness.join('late')
    const tail = late.welcome.chatTail
    assert.equal(tail.length, 100, 'the ring buffer is 100 (§4.6)')
    assert.equal(tail[0]!.text, 'burst 21', 'the oldest 21 fell out of the front')
    assert.equal(tail[99]!.text, 'burst 120', 'the newest is the newest message')
    assert.equal(tail.filter((entry) => entry.kind === 'user').length, 100)
  } finally {
    await harness.close()
  }
})

test('§12: five members is the ceiling, so a sixth hello is refused and the room still holds five', async () => {
  // The ticket's bullet says "a fourth client is refused"; §12 and
  // `MAX_MEMBERS` say five is the ceiling, so what is refused is the sixth.
  const harness = await startHarness({ clients: 5 })
  try {
    // The five seated members were told about each other, not about a sixth.
    const five = await waitFor(
      () => {
        const latest = harness.clients[4]!.frames.filter((record) => record.frame.type === 'members').pop()
        const members = latest?.frame.type === 'members' ? latest.frame.members : []
        return members.length === 5 ? members : null
      },
      2000,
      'the fifth member sees a full roster',
    )
    assert.equal(five.length, 5)

    const outcome = await ScriptedClient.attempt(harness.port, CODE, 'sixth')
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.error.code, 'room_full')

    assert.equal(harness.room.members.size, 5, 'the refusal changed no membership')
    await settle(150)
    for (const client of harness.clients) {
      assert.equal(
        client.frames.some((record) => record.frame.type === 'members' && record.frame.members.length > 5),
        false,
        'nobody was ever shown a sixth member',
      )
    }
  } finally {
    await harness.close()
  }
})

test('T5: a client whose clock is 137 ms slow estimates the offset within ±20 ms', async () => {
  const harness = await startHarness({ clients: 2 })
  try {
    const skewed = harness.guests[0]!
    injectSkew(skewed, 137)

    const estimate = await skewed.sampleOffset(5)
    assert.ok(estimate.samples >= 1, 'the estimator folded the samples')
    assert.ok(
      Math.abs(estimate.offset - 137) <= 20,
      `estimated offset ${estimate.offset.toFixed(1)} ms for a 137 ms slow clock (§6.1 allows ±20)`,
    )
    assert.ok(estimate.rtt < 100, `loopback rtt ${estimate.rtt.toFixed(1)} ms`)

    // The control: the same arithmetic on a clock that is not skewed says so.
    const control = await harness.owner.sampleOffset(3)
    assert.ok(
      Math.abs(control.offset) <= 20,
      `an unskewed clock estimated ${control.offset.toFixed(1)} ms (§6.1 allows ±20)`,
    )
  } finally {
    await harness.close()
  }
})
