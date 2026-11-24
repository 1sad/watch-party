import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

import type {
  ChatMessage,
  ErrorFrame,
  NudgeFrame,
  RoomOverFrame,
  StateFrame,
} from '../../src/shared/protocol.ts'
import { discardRoom } from '../../src/server/room.ts'
import { SEAT_REUSED_CLOSE_CODE, SEAT_REUSED_CLOSE_REASON } from '../../src/server/socket.ts'
import { expected } from '../../src/shared/timing.ts'
import { ScriptedClient } from '../support/client.ts'
import {
  CODE,
  connectSilently,
  injectSkew,
  injectStall,
  settle,
  startHarness,
  waitFor,
  type Harness,
} from './harness.ts'

// T7a's own assertions, on the shared harness (phase spec §7 B). The tickets
// that follow add theirs here: T7b the drift ladder, T8 the scheduled start.
// Nothing in this file opens a window or a DOM — it drives §5's frames only.

const stateCount = (client: ScriptedClient): number =>
  client.frames.filter((record) => record.frame.type === 'state').length

/** ADR-049's "N online": the same `status !== 'offline'` the chat column counts. */
const onlineCount = (harness: Harness): number =>
  [...harness.room.members.values()].filter((member) => member.status !== 'offline').length

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
    // §6.4: the play is a *scheduled* start, so "in step 2 s later" is measured
    // from the beat, not from the packet. Waiting for it is not a weakened
    // check — the film has not begun before `startAt`, which the next test proves.
    const startAt = (seen[0]!.frame as StateFrame).playback.startAt
    assert.equal(typeof startAt, 'number')
    if (typeof startAt !== 'number') return
    await waitFor(() => Date.now() >= startAt + 50, 2500, 'the scheduled start instant')

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

test('§12: ten members is the ceiling, so an eleventh hello is refused and the room still holds ten', async () => {
  // ADR-044 raised the cap from five to ten; `MAX_MEMBERS` is the one reader, so
  // what is refused is the eleventh.
  const harness = await startHarness({ clients: 10 })
  try {
    // The ten seated members were told about each other, not about an eleventh.
    const ten = await waitFor(
      () => {
        const latest = harness.clients[9]!.frames.filter((record) => record.frame.type === 'members').pop()
        const members = latest?.frame.type === 'members' ? latest.frame.members : []
        return members.length === 10 ? members : null
      },
      2000,
      'the tenth member sees a full roster',
    )
    assert.equal(ten.length, 10)

    const outcome = await ScriptedClient.attempt(harness.port, CODE, 'eleventh')
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.error.code, 'room_full')

    assert.equal(harness.room.members.size, 10, 'the refusal changed no membership')
    await settle(150)
    for (const client of harness.clients) {
      assert.equal(
        client.frames.some((record) => record.frame.type === 'members' && record.frame.members.length > 10),
        false,
        'nobody was ever shown an eleventh member',
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

// T7b1 item 5, R8 and R9 on the wire: one window is slowed (its frames land
// 400 ms late, so it runs ahead of the room) and stalled for 5 s; the ladder
// nudges it, then hard-seeks it, and the other two windows are never touched.
// The page does not apply a nudge yet (T7b2) — the frame arriving is the
// assertion this half of the split owns.

test('§6.4/T8: every client starts within 100 ms of the one scheduled instant, and a later joiner cannot move it', async () => {
  const harness = await startHarness({ clients: 3 })
  try {
    // §6.1's own measurement first, so the reports below carry a real `rtt`
    // (the authority's `maxRtt` input) rather than 0.
    await Promise.all(harness.clients.map((client) => client.sampleOffset(1)))

    const pressedAt = Date.now()
    harness.owner.send({ type: 'play', position: 30 })
    const seen = await Promise.all(
      harness.clients.map((client) => client.next((frame) => frame.type === 'state')),
    )
    const state = seen[0]!.frame as StateFrame
    const startAt = state.playback.startAt
    assert.equal(typeof startAt, 'number', 'a play carries §6.4’s scheduled instant')
    if (typeof startAt !== 'number') return

    // The 1.5 s floor (§6.4): loopback rtt is milliseconds, so 2 × maxRtt
    // cannot beat it. The instant is fixed at press time and travels unchanged.
    assert.ok(
      startAt >= pressedAt + 1490 && startAt < pressedAt + 3000,
      `startAt is ${startAt - pressedAt} ms after the press (the floor is 1500)`,
    )
    assert.equal(state.playback.updatedAt, startAt, 'position is valid at the scheduled instant')
    assert.equal(state.playback.position, 30, 'the film waits at the pressed position')
    for (const [index, record] of seen.entries()) {
      assert.equal(
        (record.frame as StateFrame).playback.startAt,
        startAt,
        `${harness.clients[index]!.name} was told the same instant`,
      )
    }

    // T8's Safety line: a member joining after the broadcast gets the same
    // instant in `welcome`, and the room's own copy is not rewritten for it.
    const late = await harness.join('late')
    assert.equal(
      late.welcome.room.playback.startAt,
      startAt,
      'a later joiner cannot move the beat the others are counting down to',
    )

    // A report arriving before the beat must not recompute it either.
    for (const client of harness.clients) client.reportNow()
    await settle(150)
    assert.equal(harness.room.playback.startAt, startAt, 'reports cannot move the beat')

    // Item 4: no early start, even for a client with fewer than three offset
    // samples. `waitFor` would hide this by firing late, so it is checked now.
    for (const client of [...harness.clients, late]) {
      assert.equal(client.player.startFiredAt, null, `${client.name} has not played yet`)
      assert.ok(
        client.player.currentTime <= 30.05,
        `${client.name} is holding the pressed position (${client.player.currentTime.toFixed(3)} s)`,
      )
    }

    // Item 5: the one assertion this ticket adds to the harness — every player
    // fires its `playing` move within 100 ms of the scheduled instant.
    const fires = await waitFor(
      () =>
        [...harness.clients, late].every((client) => client.player.startFiredAt !== null)
          ? [...harness.clients, late].map((client) => ({
              client,
              at: client.player.startFiredAt as number,
            }))
          : null,
      4000,
      'every client reached the scheduled start',
    )
    for (const { client, at } of fires) {
      const difference = at - startAt
      assert.ok(
        Math.abs(difference) <= 100,
        `${client.name} started ${difference.toFixed(1)} ms from startAt (100 allowed)`,
      )
    }

    // Item 2's other half: pause clears the instant, and a seek that resumes
    // playback schedules a fresh one — the same one-timer rule as a play.
    harness.owner.send({ type: 'pause', position: 35 })
    const paused = (
      await harness.owner.next((frame) => frame.type === 'state' && frame.reason === 'pause')
    ).frame as StateFrame
    assert.equal(paused.playback.startAt, undefined, 'pause clears the pending instant')

    const resumedAt = Date.now()
    harness.owner.send({ type: 'seek', position: 40, wasPlaying: true })
    const resumed = (
      await harness.owner.next((frame) => frame.type === 'state' && frame.reason === 'seek')
    ).frame as StateFrame
    const resumedStart = resumed.playback.startAt
    assert.equal(typeof resumedStart, 'number', 'a resuming seek schedules a start')
    if (typeof resumedStart !== 'number') return
    assert.ok(resumedStart >= resumedAt + 1400, 'the resumed beat gets the full lead too')
    const resumedFires = await waitFor(
      () => {
        const values = harness.clients.map((client) => client.player.startFiredAt)
        return values.every((value) => value !== null && value >= resumedAt) ? values : null
      },
      4000,
      'every client resumed on the new beat',
    )
    for (const [index, at] of resumedFires.entries()) {
      const difference = (at as number) - resumedStart
      assert.ok(
        Math.abs(difference) <= 100,
        `${harness.clients[index]!.name} resumed ${difference.toFixed(1)} ms from the new startAt`,
      )
    }
  } finally {
    await harness.close()
  }
})

// T7b1 item 5, R8 and R9 on the wire: one window is slowed (its frames land
// 400 ms late, so it runs ahead of the room) and stalled for 5 s; the ladder
// nudges it, then hard-seeks it, and the other two windows are never touched.
// The page does not apply a nudge yet (T7b2) — the frame arriving is the
// assertion this half of the split owns.

test('R8/R9: a slowed, stalled client is nudged before a seek and converges under 250 ms; the healthy clients are untouched', async () => {
  const decisions: string[] = []
  const harness = await startHarness({ clients: 3, debug: (line) => decisions.push(line) })
  try {
    const [owner, lagging, healthy] = harness.clients as [
      ScriptedClient,
      ScriptedClient,
      ScriptedClient,
    ]

    // §6.1's own measurement first, so the reports carry a real `rtt` (T8 reads
    // it) rather than 0.
    await Promise.all(harness.clients.map((client) => client.sampleOffset(1)))

    // A clock this member reads 400 ms slow, injected **after** its T5 sample so
    // it believes the offset is still 0: `authorityNow()` then puts its playhead
    // 0.4 s behind the room on every report. That is the "slowed by 400 ms"
    // member; `injectDelay` alone only delays one apply and `expected()`
    // re-derives the right position, so it produces no steady drift.
    injectSkew(lagging, 400)
    owner.send({ type: 'play', position: 30 })
    // The 1.5 s scheduled lead (§6.4) plus this member's 400 ms clock error is
    // why the wait is longer than the 300 ms R6 line: the lead is intended.
    await waitFor(
      () => harness.clients.every((client) => client.player.currentTime > 30.2),
      4000,
      'every player adopted the owner’s play',
    )

    // §5: one report each every 3 s, from every member.
    for (const client of harness.clients) client.startReporting(3000)

    // The guards make the first bad report silent and the second one act; the
    // lagging member is behind, so §6.3 says speed up to 1.05.
    const nudge = await waitFor(
      () => lagging.frames.find((record) => record.frame.type === 'nudge') ?? null,
      9000,
      'the lagging member is nudged',
    )
    const nudgeFrame = nudge.frame as NudgeFrame
    assert.equal(nudgeFrame.rate, 1.05, 'behind the room means speed up')
    assert.ok(nudgeFrame.target > 30, 'the nudge carries where the room is going')
    assert.ok(
      Number.isFinite(nudgeFrame.untilAuthorityMs) && nudgeFrame.untilAuthorityMs > nudge.at,
      'the nudge carries an authority-clock expiry, for T7b2 to enforce',
    )
    const nudgeLine = decisions.find(
      (line) => line.includes(`member=${lagging.selfId}`) && line.includes('action=nudge'),
    )
    assert.ok(nudgeLine !== undefined, 'the log records the nudge decision')
    const nudgeDrift = Number(/drift=(-?\d+(?:\.\d+)?)/.exec(nudgeLine ?? '')?.[1])
    assert.ok(
      nudgeDrift <= -0.1 && nudgeDrift > -1.5,
      `the nudge was for a ${Math.abs(nudgeDrift)} s drift (0.1–1.5 is the nudge band behind)`,
    )

    // R8: the two healthy windows receive no correction at all.
    await settle(100)
    for (const client of [owner, healthy]) {
      assert.equal(
        client.frames.some((record) => record.frame.type === 'nudge'),
        false,
        `${client.name} received no nudge`,
      )
      assert.equal(stateCount(client), 1, `${client.name} saw only the owner’s one play state`)
    }
    // No seek reached the lagging member before the nudge: the ladder nudges
    // first, as §6.3's table says.
    const firstSeek = lagging.frames.find(
      (record) => record.frame.type === 'state' && record.frame.reason === 'seek',
    )
    assert.equal(
      firstSeek === undefined || firstSeek.at > nudge.at,
      true,
      'a nudge arrived before any hard seek',
    )

    // Now the 5 s stall. The clock error is removed first: the ladder is what is
    // under test, not an estimate that would keep the member 400 ms out after a
    // correct seek.
    injectSkew(lagging, 0)
    const stallStart = Date.now()
    injectStall(lagging, 5)

    const seek = await waitFor(
      () =>
        lagging.frames.find(
          (record) =>
            record.frame.type === 'state' && record.frame.reason === 'seek' && record.at >= stallStart,
        ) ?? null,
      12_000,
      'the stalled member is hard-seeked',
    )

    await waitFor(
      () =>
        Math.abs(lagging.player.currentTime - expected(harness.room.playback, Date.now())) < 0.25,
      3000,
      'the stalled member converged under 250 ms',
    )
    const convergedAt = Date.now()

    // R8 again, after both corrections: the healthy windows' playheads never
    // moved outside the normal in-step band, and they heard no second state.
    for (const client of [owner, healthy]) {
      assert.equal(stateCount(client), 1, `${client.name} heard no correction state`)
    }
    const healthySpread = Math.abs(owner.player.currentTime - healthy.player.currentTime)
    assert.ok(
      healthySpread < 0.25,
      `the healthy windows are ${(healthySpread * 1000).toFixed(1)} ms apart after the correction`,
    )

    // The decision log is the manual gate's evidence (§6.3 item 4): both
    // actions, with the inputs that caused them.
    const laggingLines = decisions.filter((line) => line.includes(`member=${lagging.selfId}`))
    assert.ok(
      laggingLines.some((line) => line.includes('action=nudge')),
      'the log records the nudge decision',
    )
    const seekLine = laggingLines.find((line) => line.includes('action=seek'))
    assert.ok(seekLine !== undefined, 'the log records the seek decision')
    const drift = Number(/drift=(-?\d+(?:\.\d+)?)/.exec(seekLine ?? '')?.[1])
    assert.ok(drift < -1.75, `the seek was chosen because the member was ${drift} s behind (1.75 is the threshold)`)

    assert.ok(
      convergedAt - stallStart < 12_000,
      `convergence took ${convergedAt - stallStart} ms after the stall began`,
    )
    assert.ok((seek as { at: number }).at - stallStart < 12_000)
  } finally {
    await harness.close()
  }
})

// F1: §5's epoch rule and §4.3 invariant 6 — an authority-bearing frame carries
// the epoch; a stale one is refused with `stale_host` rather than applied.
test('R11: a setMedia carrying a stale epoch is refused and registers nothing', async () => {
  const registered: string[] = []
  const harness = await startHarness({ clients: 1, log: (line) => registered.push(line) })
  const fixture = fileURLToPath(new URL('../fixtures/fixture.mp4', import.meta.url))
  try {
    const held = harness.owner.welcome.epoch
    assert.equal(held, harness.room.authority.epoch, 'the welcome carries the room’s epoch')

    // §4.4: authority moved after this window's `welcome`, so the epoch it still
    // holds is one behind the room's.
    harness.room.authority = { memberId: harness.room.authority.memberId, epoch: held + 1 }

    // The refusal must be a no-op down to the sequence number: a pick that was
    // not applied is not a write, so `revision` may not move (§4.3 invariant 8).
    // Hoisting `revision += 1` above the epoch compare in `setMedia()` turns
    // this red while the `stale_host` assertion above stays green.
    const revisionBefore = harness.room.revision
    harness.owner.send({
      type: 'setMedia',
      id: 'f1',
      title: 'Fixture',
      duration: 60,
      path: fixture,
      epoch: held,
    })
    const refusal = (await harness.owner.next((frame) => frame.type === 'error')).frame as ErrorFrame
    assert.equal(refusal.code, 'stale_host')
    assert.equal(harness.room.media, null, 'a stale pick puts no file in the room')
    assert.equal(
      harness.room.revision,
      revisionBefore,
      'a refused pick left the room’s revision where it was',
    )
    // T9a2's line is written only after an accepted pick, so its absence here is
    // the proof that nothing was registered.
    await settle(100)
    assert.deepEqual(registered, [], 'no file was registered for a stale pick')

    // The epoch the room holds now is accepted: one file, one line.
    harness.owner.send({
      type: 'setMedia',
      id: 'f1',
      title: 'Fixture',
      duration: 60,
      path: fixture,
      epoch: harness.room.authority.epoch,
    })
    const set = await waitFor(() => harness.room.media, 2000, 'the owner set the room’s media')
    assert.equal(set.id, 'f1')
    assert.equal(registered.length, 1, 'the accepted pick is the only registration')
    assert.match(registered[0] ?? '', /^\[media\] registered id=f1 /)
  } finally {
    await harness.close()
  }
})

// T9a1: file mode's wire half. The bytes are served by `/media/<id>`; this
// assertion is the door — who may name the file, and whether a refusal moves
// anything.
test('R11: only the owner may set the room\'s media, and a refusal leaves the room untouched', async () => {
  const harness = await startHarness({ clients: 2 })
  const fixture = fileURLToPath(new URL('../fixtures/fixture.mp4', import.meta.url))
  try {
    assert.equal(harness.room.media, null, 'the room starts with no file')
    const guest = harness.guests[0] as ScriptedClient

    // ADR-030 / §5: a guest naming a path on someone else's disk is refused,
    // and the refusal happens before anything is assigned.
    guest.send({
      type: 'setMedia',
      id: 'guest',
      title: 'not mine',
      duration: 1,
      path: fixture,
      epoch: harness.owner.welcome.epoch,
    })
    const refusal = (await guest.next((frame) => frame.type === 'error')).frame as ErrorFrame
    assert.equal(refusal.code, 'not_controller')
    assert.equal(harness.room.media, null, 'a guest cannot put a file in the room')

    harness.owner.send({
      type: 'setMedia',
      id: 'f1',
      title: 'Fixture',
      duration: 60,
      path: fixture,
      epoch: harness.owner.welcome.epoch,
    })
    const set = await waitFor(() => harness.room.media, 2000, 'the owner set the room’s media')
    assert.equal(set.id, 'f1')
    assert.equal(set.contentType, 'video/mp4', 'the content type comes from ADR-035’s map')

    // The same guard refuses a path that is not there, and `f1` stays put.
    harness.owner.send({
      type: 'setMedia',
      id: 'f2',
      title: 'Missing',
      duration: 60,
      path: join(dirname(fixture), 'missing.mp4'),
      epoch: harness.owner.welcome.epoch,
    })
    const missing = (await harness.owner.next((frame) => frame.type === 'error')).frame as ErrorFrame
    assert.equal(missing.code, 'bad_media')
    // The assertion at the top narrowed `harness.room.media` to null; the room is
    // changed through the socket, so read it afresh to get its declared type back.
    const currentMedia = () => harness.room.media
    assert.equal(currentMedia()?.id, 'f1')

    // `welcome.room.media` is what a guest receives: the same file, no path.
    const late = await harness.join('late')
    assert.deepEqual(late.welcome.room.media, {
      kind: 'file',
      id: 'f1',
      title: 'Fixture',
      duration: 60,
      contentType: 'video/mp4',
    })
    assert.equal('path' in (late.welcome.room.media as object), false, 'the owner’s disk path never goes on the wire')
  } finally {
    await harness.close()
  }
})

// F2 / `docs/spec.md:315` and phase slice §6's `clampToMedia` row: every seek
// lands in `[0, duration − 0.25]`. The room is where that rule is enforced now,
// so the wire is the layer that proves it: a controller dragging the bar to the
// very end is stored, and broadcast, a quarter second short of it.
test('R6: a seek to the media duration lands at duration − 0.25, never at the exact end', async () => {
  const harness = await startHarness({ clients: 2 })
  const fixture = fileURLToPath(new URL('../fixtures/fixture.mp4', import.meta.url))
  try {
    harness.owner.send({
      type: 'setMedia',
      id: 'f2',
      title: 'Fixture',
      duration: 60,
      path: fixture,
      epoch: harness.owner.welcome.epoch,
    })
    const media = await waitFor(() => harness.room.media, 2000, 'the room holds the fixture')
    assert.equal(media.duration, 60, 'the fixture is the 60 s clip')

    const hearing = harness.clients.map((client) => client.next((frame) => frame.type === 'state'))
    harness.owner.send({ type: 'seek', position: media.duration, wasPlaying: false })
    const heard = await Promise.all(hearing)

    for (const [index, record] of heard.entries()) {
      const state = record.frame as StateFrame
      assert.equal(state.reason, 'seek')
      assert.equal(
        state.playback.position,
        59.75,
        `${harness.clients[index]!.name} is told 59.75, not ${media.duration}`,
      )
    }
    assert.equal(harness.room.playback.position, 59.75, 'the room stored the clamped target')
  } finally {
    await harness.close()
  }
})

// F7: §4.5's clamp is a rule about **seek targets** (`docs/spec.md:315`, "Seek
// targets clamp to `[0, duration − 0.25]`", and phase slice §6's "Every seek
// goes through it"). A `play` or `pause` frame carries the playhead the press was
// made at, which is a measurement of where the film is, not a place anyone asked
// to jump to. Pressing pause 0.1 s before the end must leave the room there; a
// clamp applied to every command would rewind every client to 0.25 s short.
test('F7: a pause at duration − 0.1 is stored and broadcast where it was pressed', async () => {
  const harness = await startHarness({ clients: 2 })
  const fixture = fileURLToPath(new URL('../fixtures/fixture.mp4', import.meta.url))
  try {
    harness.owner.send({
      type: 'setMedia',
      id: 'f7',
      title: 'Fixture',
      duration: 60,
      path: fixture,
      epoch: harness.owner.welcome.epoch,
    })
    const media = await waitFor(() => harness.room.media, 2000, 'the room holds the fixture')

    // A `pause` is only applied while the room is playing, so play first and
    // consume the `state` it broadcasts — `next()` hands a frame out once.
    const started = harness.clients.map((client) => client.next((frame) => frame.type === 'state'))
    harness.owner.send({ type: 'play', position: 10 })
    for (const record of await Promise.all(started)) {
      assert.equal((record.frame as StateFrame).reason, 'play')
    }

    const hearing = harness.clients.map((client) => client.next((frame) => frame.type === 'state'))
    harness.owner.send({ type: 'pause', position: media.duration - 0.1 })
    const heard = await Promise.all(hearing)

    for (const [index, record] of heard.entries()) {
      const state = record.frame as StateFrame
      assert.equal(state.reason, 'pause')
      assert.equal(state.playback.playing, false)
      assert.equal(
        state.playback.position,
        59.9,
        `${harness.clients[index]!.name} is told where the pause was pressed, not 59.75`,
      )
    }
    assert.equal(harness.room.playback.position, 59.9, 'the room stored the pause’s own position')
  } finally {
    await harness.close()
  }
})

// F4, docs/spec.md:417 and §14/ADR-024: file mode has no room without its
// owner. The end does not wait for a pick — a room with no owner could neither
// be given bytes nor controlled — and everyone still here is told plainly.
test('F4: the owner closing before any pick still ends the room, and the guest is told', async () => {
  const harness = await startHarness({ clients: 2 })
  try {
    assert.equal(harness.room.media, null, 'nothing was picked: this is the hole the case covers')
    const guest = harness.guests[0] as ScriptedClient
    const guestClosed = new Promise<void>((resolve) => guest.socket.once('close', () => resolve()))

    await harness.owner.close()

    const over = await guest.next((frame) => frame.type === 'roomOver')
    assert.equal((over.frame as RoomOverFrame).reason, 'owner_left')
    await guestClosed

    // §4.4 / T9b check 3: discarded, not kept as an ownerless tombstone.
    assert.equal(harness.room.owner, null, 'the dead room keeps no owner seat')
    assert.equal(harness.room.members.size, 0, 'and no members')
  } finally {
    await harness.close()
  }
})

// F4: `wss.close()` only stops new upgrades; a socket that connected but never
// sent `hello` is in `wss.clients` and not in `sockets`. The end must reach it
// too, and it must never have been welcomed while it was live.
test('F4: a client that never said hello does not outlive the room', async () => {
  const harness = await startHarness({ clients: 2 })
  try {
    const raw = await connectSilently(harness.port)
    assert.equal(raw.socket.readyState, WebSocket.OPEN, 'the raw client is connected')

    await harness.owner.close()

    // The end closes every client, joined or not, so this socket cannot keep
    // listening to the discarded room. Limit the end's sweep to `sockets` and
    // this wait times out with the raw socket still open.
    await waitFor(
      () => raw.socket.readyState !== WebSocket.OPEN,
      2000,
      'the room’s end reached the un-joined socket',
    )
    // It never sent `hello`, so nothing should ever have answered it: a
    // `welcome` here means a socket was seated as a member without asking.
    assert.equal(
      raw.frames.some((frame) => frame.type === 'welcome'),
      false,
      'a silent socket was never welcomed',
    )

    // The late-hello guard is not tested here: a send on this socket cannot
    // reach the server now, so an assertion about it would pass for the wrong
    // reason. That guard is proven on a live socket by the next case.
  } finally {
    await harness.close()
  }
})

// F4: the join path itself refuses a discarded room. Without the guard,
// `room.code` still matches, the client is loopback, `room.owner` is null, and
// `joinRoom()` seats it as a fresh owner — a room the spec says cannot exist.
test('F4: after a discard, a loopback hello is refused and no owner is re-seated', async () => {
  const harness = await startHarness({ clients: 1 })
  try {
    discardRoom(harness.room)
    assert.equal(harness.room.owner, null, 'the room was discarded')

    const outcome = await ScriptedClient.attempt(harness.port, CODE, 'late')
    if (outcome.ok) {
      await outcome.client.close()
      assert.fail('a discarded room accepted a loopback hello')
    }
    assert.equal(outcome.error.type, 'error')
    assert.equal(outcome.error.code, 'bad_room')
    assert.equal(harness.room.owner, null, 'the loopback hello did not re-seat an owner')
    assert.equal(harness.room.members.size, 0, 'and it added no member')
  } finally {
    await harness.close()
  }
})

// T148 / ADR-033 rule 1: a reconnect restores the same seat. The second socket
// names the id the first one joined with, and the room must keep one row for
// that person - its join time, its name and the control it held - while the
// older connection is closed. Without the reuse this case shows three rows in a
// two-person room, which is what the owner saw on the evening.
test('T148/ADR-033: a second hello with the same member id re-seats the row, keeps name and control, and closes the older socket', async () => {
  const harness = await startHarness({ clients: 0 })
  try {
    const ADA = 'ada00000-0000-4000-8000-000000000148'
    // The first connection on loopback is the room's owner, so Ada's control is
    // the grant ADR-033 rule 1 binds to this id; no grant frame exists in M1.
    const first = await harness.join('Ada', { id: ADA })
    assert.equal(first.welcome.selfId, ADA, 'the id the page sent is the seat')
    assert.equal(harness.room.members.size, 1, 'one row before the second hello')
    assert.deepEqual(harness.room.controllers, [ADA], 'Ada holds control before the rejoin')

    let closeCode = -1
    let closeReason = ''
    first.socket.once('close', (code: number, reason: Buffer) => {
      closeCode = code
      closeReason = String(reason)
    })

    const second = await harness.join('Ada', { id: ADA })

    await waitFor(() => closeCode !== -1, 2000, 'the older socket was closed')
    assert.equal(closeCode, SEAT_REUSED_CLOSE_CODE, 'the older socket got the seat-reused code')
    assert.equal(closeReason, SEAT_REUSED_CLOSE_REASON, 'and a reason a person can read')

    assert.equal(second.welcome.selfId, ADA, 'the second socket holds the same seat')
    assert.equal(harness.room.members.size, 1, 'one row after the second hello, never two')
    const row = harness.room.members.get(ADA)
    assert.equal(row?.name, 'Ada', 'the name the row already had')
    assert.deepEqual(harness.room.controllers, [ADA], 'the control granted before the second hello is still hers')
    assert.equal(harness.room.owner, ADA, 'the rejoin did not move the owner seat')

    // Requirement 3: the welcome list and the roster broadcast are keyed by id.
    assert.deepEqual(
      second.welcome.members.map((member) => member.id),
      [ADA],
      'welcome carries the full list as one row',
    )
    const roster = await waitFor(
      () => {
        const latest = second.frames.filter((record) => record.frame.type === 'members').pop()
        const members = latest?.frame.type === 'members' ? latest.frame.members : []
        return members.length === 1 ? members : null
      },
      2000,
      'the rejoin broadcast a one-row roster',
    )
    assert.deepEqual(roster.map((member) => member.id), [ADA])
  } finally {
    await harness.close()
  }
})

// The sibling guard: the join path must not collapse distinct people. Two ids
// are two rows, and neither socket is closed by the other's arrival.
test('T148/ADR-033: two different member ids still make two rows', async () => {
  const harness = await startHarness({ clients: 0 })
  try {
    const ada = await harness.join('Ada', { id: 'ada00000-0000-4000-8000-00000000014a' })
    assert.equal(harness.room.members.size, 1, 'one row for the first id')

    const bea = await harness.join('Bea', { id: 'bea00000-0000-4000-8000-00000000014b' })
    assert.equal(harness.room.members.size, 2, 'a distinct id is a distinct person')
    assert.notEqual(ada.selfId, bea.selfId)
    assert.equal(ada.socket.readyState, WebSocket.OPEN, 'Ada was not evicted by Bea joining')

    const roster = await waitFor(
      () => {
        const latest = bea.frames.filter((record) => record.frame.type === 'members').pop()
        const members = latest?.frame.type === 'members' ? latest.frame.members : []
        return members.length === 2 ? members : null
      },
      2000,
      'the roster holds both people',
    )
    assert.deepEqual(roster.map((member) => member.id).sort(), [ada.selfId, bea.selfId].sort())
  } finally {
    await harness.close()
  }
})

// T148b / ADR-049: presence is what the room hears, not what a socket once was.
// The close handler is the only other path to `offline`, so a connection that
// goes quiet without closing leaves its row online and the count keeps a person
// who is gone. The owner's seat is exempt while its socket is open, which is why
// the quiet client here is a guest and the count settles at one, not zero.
test('T148b/ADR-049: a silent seat leaves the count at the presence cutoff while its socket stays open', async () => {
  const previousPresence = process.env.WATCHPARTY_PRESENCE_MS
  process.env.WATCHPARTY_PRESENCE_MS = '1500'
  const harness = await startHarness({ clients: 0 })
  try {
    const owner = await harness.join('sam')
    const quiet = await harness.join('quiet')
    assert.equal(harness.room.owner, owner.selfId, 'the first loopback member owns the room')
    assert.equal(onlineCount(harness), 2, 'the count starts at two, both heard at hello')

    const startedAt = Date.now()
    await waitFor(() => onlineCount(harness) === 1, 4000, 'the silent seat left the count')
    const elapsedMs = Date.now() - startedAt

    assert.equal(quiet.socket.readyState, WebSocket.OPEN, 'the sweep never closed the silent socket')
    assert.equal(harness.room.members.get(quiet.selfId)?.status, 'offline', 'the silent row is offline')
    assert.equal(harness.room.members.get(owner.selfId)?.status, 'online', 'the owner seat is not swept')

    // ADR-049: the list and the count read the same predicate, so the roster
    // broadcast a window draws "1 online" from must hold exactly the owner.
    const roster = await waitFor(
      () => {
        const latest = owner.frames.filter((record) => record.frame.type === 'members').pop()
        const members = latest?.frame.type === 'members' ? latest.frame.members : []
        return members.filter((member) => member.status !== 'offline').length === 1 ? members : null
      },
      2000,
      'the room broadcast the one-person roster',
    )
    assert.deepEqual(
      roster.filter((member) => member.status !== 'offline').map((member) => member.id),
      [owner.selfId],
    )
    // The check's number: within 4 s at a 1500 ms cutoff (reported in the TESTED line).
    assert.ok(elapsedMs < 4000, `the count dropped in ${elapsedMs} ms (the check allows 4000)`)
    console.log(`T148b: online count 2 -> 1 in ${elapsedMs} ms (cutoff 1500 ms)`)
  } finally {
    await harness.close()
    if (previousPresence === undefined) delete process.env.WATCHPARTY_PRESENCE_MS
    else process.env.WATCHPARTY_PRESENCE_MS = previousPresence
  }
})
