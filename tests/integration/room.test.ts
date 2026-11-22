import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import { createRoom } from '../../src/server/room.ts'
import { attachRoomSocket } from '../../src/server/socket.ts'
import { findLanIp } from '../../src/server/discovery.ts'
import { expected, sampleFrom } from '../../src/shared/timing.ts'

// T3's checks, against a real socket: one short-lived server on port 0 per test
// and plain `node --test` cases (no shared two-client harness — a later ticket
// owns that). Everything here is the sidecar's side of the wire; the page is T3b.

const CODE = 'AAAAAA'

interface Frame {
  type: string
  [key: string]: any
}

async function openRoom(): Promise<{
  room: ReturnType<typeof createRoom>
  port: number
  close: () => Promise<void>
}> {
  const room = createRoom(CODE)
  const server = createServer()
  const wss = attachRoomSocket(server, room)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    room,
    port,
    close: async () => {
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())))
    },
  }
}

function connect(host: string, port: number) {
  const socket = new WebSocket(`ws://${host}:${port}/`)
  const inbox: Frame[] = []
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = []

  socket.on('error', () => {
    // Asserted through the wait timeouts instead; a socket error closes the test.
  })
  socket.on('message', (data: unknown) => {
    const frame = JSON.parse(String(data)) as Frame
    const index = waiters.findIndex((waiter) => waiter.match(frame))
    if (index === -1) inbox.push(frame)
    else waiters.splice(index, 1)[0].resolve(frame)
  })

  const ready = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  const client = {
    socket,
    ready,
    inbox,
    send(frame: object): void {
      socket.send(JSON.stringify(frame))
    },
    next(match: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
      const index = inbox.findIndex(match)
      if (index !== -1) return Promise.resolve(inbox.splice(index, 1)[0] as Frame)
      return new Promise<Frame>((resolve, reject) => {
        const waiter = {
          match,
          resolve: (frame: Frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
        }
        const timer = setTimeout(() => {
          // A timed-out waiter must stop claiming frames, or the next arrival is
          // swallowed by a promise nobody is listening to any more.
          const at = waiters.indexOf(waiter)
          if (at !== -1) waiters.splice(at, 1)
          reject(new Error(`no matching frame in ${timeoutMs}ms; inbox: ${JSON.stringify(inbox)}`))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    async hello(code: string, name?: string): Promise<Frame> {
      client.send({ type: 'hello', code, ...(name === undefined ? {} : { name }) })
      return client.next((frame) => frame.type === 'welcome')
    },
  }
  return client
}

const labels = (members: Frame[]): string[] => members.map((member) => member.displayName)

test('a good code gets welcome with itself in members; a wrong code gets bad_room and stays open', async () => {
  const fixture = await openRoom()
  const owner = connect('127.0.0.1', fixture.port)
  try {
    await owner.ready
    const welcome = await owner.hello(CODE, 'sam')

    assert.equal(typeof welcome.selfId, 'string')
    assert.equal(welcome.room.code, CODE)
    assert.equal(welcome.epoch, 0)
    assert.deepEqual(welcome.chatTail, [])

    const self = welcome.members.find((member: Frame) => member.id === welcome.selfId)
    assert.ok(self, 'the joiner is in its own members list')
    assert.equal(self.displayName, 'sam')
    assert.equal(self.status, 'online')
    assert.equal(welcome.room.owner, welcome.selfId, 'loopback is the window, so it owns the room')
    assert.deepEqual(welcome.room.controllers, [welcome.selfId])

    const stranger = connect('127.0.0.1', fixture.port)
    await stranger.ready
    stranger.send({ type: 'hello', code: 'ZZZZZZ' })
    const refusal = await stranger.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'bad_room')
    assert.equal(typeof refusal.message, 'string')
    assert.equal(stranger.socket.readyState, WebSocket.OPEN, 'the socket is not dropped')

    // Still usable: the same socket joins once it has the right code.
    const retried = await stranger.hello(CODE)
    assert.equal(typeof retried.selfId, 'string')
  } finally {
    await fixture.close()
  }
})

test('two sams become sam and sam (2); renaming one to null re-broadcasts anonymous', async () => {
  const fixture = await openRoom()
  const first = connect('127.0.0.1', fixture.port)
  const second = connect('127.0.0.1', fixture.port)
  try {
    await first.ready
    await first.hello(CODE, 'sam')
    await second.ready
    const welcome = await second.hello(CODE, 'sam')

    const both = await first.next((frame) => frame.type === 'members' && frame.members.length === 2)
    assert.deepEqual(labels(both.members).sort(), ['sam', 'sam (2)'])

    second.send({ type: 'rename', name: null })

    const seenByFirst = await first.next(
      (frame) =>
        frame.type === 'members' &&
        frame.members.some((member: Frame) => member.id === welcome.selfId && member.displayName === 'anonymous'),
    )
    assert.deepEqual(labels(seenByFirst.members).sort(), ['anonymous', 'sam'])

    const seenBySecond = await second.next(
      (frame) =>
        frame.type === 'members' &&
        frame.members.some((member: Frame) => member.id === welcome.selfId && member.displayName === 'anonymous'),
    )
    assert.deepEqual(labels(seenBySecond.members).sort(), ['anonymous', 'sam'])
  } finally {
    await fixture.close()
  }
})

test('ten members is the ceiling: the eleventh hello is room_full and members still has ten', async () => {
  const fixture = await openRoom()
  const joined = []
  try {
    for (let index = 0; index < 10; index += 1) {
      const client = connect('127.0.0.1', fixture.port)
      await client.ready
      await client.hello(CODE, `friend ${index + 1}`)
      joined.push(client)
    }

    const eleventh = connect('127.0.0.1', fixture.port)
    await eleventh.ready
    eleventh.send({ type: 'hello', code: CODE, name: 'eleventh' })
    const refusal = await eleventh.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'room_full')

    const ten = await joined[0]!.next((frame) => frame.type === 'members' && frame.members.length === 10)
    assert.equal(ten.members.length, 10)
    assert.equal(fixture.room.members.size, 10)
    assert.equal(
      joined[0]!.inbox.some((frame) => frame.type === 'members' && frame.members.length > 10),
      false,
    )
  } finally {
    await fixture.close()
  }
})

test('a pause from a non-owner is refused and moves nothing; the owner\'s is accepted', async () => {
  const lanIp = findLanIp()
  assert.ok(lanIp, 'this check needs a real second address, because the owner is the loopback window')

  const fixture = await openRoom()
  const owner = connect('127.0.0.1', fixture.port)
  const guest = connect(lanIp, fixture.port)
  try {
    await owner.ready
    const ownerWelcome = await owner.hello(CODE, 'sam')

    await guest.ready
    const guestWelcome = await guest.hello(CODE, 'alex')
    assert.equal(guestWelcome.room.owner, ownerWelcome.selfId)
    assert.deepEqual(guestWelcome.room.controllers, [ownerWelcome.selfId])

    guest.send({ type: 'pause', position: 12.5 })
    const refusal = await guest.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'not_controller')
    assert.equal(guest.socket.readyState, WebSocket.OPEN)

    // Nothing moved: no state frame, so `revision` is still what the guest was told.
    await assert.rejects(guest.next((frame) => frame.type === 'state', 150), /no matching frame/)

    // The room starts paused, and T6a makes a pause-while-paused a no-op, so the
    // room is started first: the check is that an *accepted* command moves the
    // room by exactly one revision, not that a duplicate does.
    owner.send({ type: 'play', position: 12.5 })
    const started = await guest.next((frame) => frame.type === 'state')
    assert.equal(started.revision, guestWelcome.room.revision + 1, 'only the accepted command moved it')
    assert.equal(started.reason, 'play')

    owner.send({ type: 'pause', position: 12.5 })
    const state = await guest.next((frame) => frame.type === 'state')
    assert.equal(state.revision, guestWelcome.room.revision + 2, 'one more, not a jump')
    assert.equal(state.by, ownerWelcome.selfId)
    assert.equal(state.playback.playing, false)
    assert.equal(state.playback.position, 12.5)
    assert.equal(state.reason, 'pause')
  } finally {
    await fixture.close()
  }
})

test('a ping is answered with its own t0 and the authority\'s two instants (§6.1)', async () => {
  const fixture = await openRoom()
  const client = connect('127.0.0.1', fixture.port)
  try {
    await client.ready
    await client.hello(CODE, 'pat')

    const sentAt = Date.now()
    client.send({ type: 'ping', t0: sentAt })
    const pong = await client.next((frame) => frame.type === 'pong')
    assert.equal(pong.t0, sentAt, 'the member\'s instant comes back untouched')
    assert.ok(pong.t1 >= sentAt, 't1 is the authority\'s receive instant, not one of ours')
    assert.ok(pong.t2 >= pong.t1, 't2 is its send instant')

    // §6.1's arithmetic on a real loopback socket: the sample the page would take.
    const sample = sampleFrom(pong.t0, pong.t1, pong.t2, Date.now())
    assert.ok(sample)
    assert.ok(sample.rtt >= 0 && sample.rtt < 100, `loopback rtt ${sample.rtt} ms`)
    assert.ok(Math.abs(sample.offset) < 100, `offset ${sample.offset} ms on one clock`)

    // The same socket keeps beating, and a t0 that is not a number is not a frame
    // this server can answer — §5's "ignore what it cannot read", no error frame.
    client.send({ type: 'ping', t0: Date.now() })
    await client.next((frame) => frame.type === 'pong')
    client.send({ type: 'ping', t0: 'soon' })
    await assert.rejects(client.next((frame) => frame.type === 'pong', 150), /no matching frame/)
  } finally {
    await fixture.close()
  }
})

test('an unknown frame type is ignored: the socket stays open and the next real frame works', async () => {
  const fixture = await openRoom()
  const client = connect('127.0.0.1', fixture.port)
  try {
    await client.ready
    await client.hello(CODE, 'pat')

    client.send({ type: 'nonsense', payload: { anything: true } })
    client.socket.send('}{ not even json')
    assert.equal(client.socket.readyState, WebSocket.OPEN)

    client.send({ type: 'rename', name: 'pat again' })
    const members = await client.next(
      (frame) =>
        frame.type === 'members' &&
        frame.members.some((member: Frame) => member.displayName === 'pat again'),
    )
    assert.deepEqual(labels(members.members), ['pat again'])
  } finally {
    await fixture.close()
  }
})

// T6a: the room's playback model on the wire. One `state` per *accepted*
// command, none for a duplicate (§5's idempotency rule), and `report` — a
// member's own measurement — never in that set.

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('one owner pause is exactly one state, and all three members see it, sender included', async () => {
  const lanIp = findLanIp()
  assert.ok(lanIp, 'the two guests need a real second address, so loopback is the owner')

  const fixture = await openRoom()
  const owner = connect('127.0.0.1', fixture.port)
  const guestA = connect(lanIp, fixture.port)
  const guestB = connect(lanIp, fixture.port)
  const everyone = [owner, guestA, guestB]
  try {
    for (const client of everyone) await client.ready
    const ownerWelcome = await owner.hello(CODE, 'sam')
    await guestA.hello(CODE, 'alex')
    await guestB.hello(CODE, 'robin')

    // The room starts paused, and a pause-while-paused is a no-op (T6a item 4),
    // so the room is started first and those frames are drained.
    owner.send({ type: 'play', position: 30 })
    for (const client of everyone) await client.next((frame) => frame.type === 'state')
    await settle()
    for (const client of everyone) {
      assert.equal(
        client.inbox.filter((frame) => frame.type === 'state').length,
        0,
        'the starting play produced exactly one state each',
      )
    }
    const before = fixture.room.revision

    owner.send({ type: 'pause', position: 31 })
    const seen = await Promise.all(
      everyone.map((client) => client.next((frame) => frame.type === 'state')),
    )
    await settle()
    for (const [index, client] of everyone.entries()) {
      assert.equal(
        client.inbox.filter((frame) => frame.type === 'state').length,
        0,
        'one pause is one state, not one per receiver',
      )
      const state = seen[index] as Frame
      assert.equal(state.revision, before + 1, 'one accepted command, one revision')
      assert.equal(state.by, ownerWelcome.selfId)
      assert.equal(state.reason, 'pause', 'the log says why the playhead moved')
      assert.equal(state.playback.playing, false)
      assert.equal(state.playback.position, 31)
    }
  } finally {
    await fixture.close()
  }
})

test('a seek within 0.3 s of the expected position is skipped; a real one is one state', async () => {
  const fixture = await openRoom()
  const owner = connect('127.0.0.1', fixture.port)
  try {
    await owner.ready
    await owner.hello(CODE, 'sam')

    owner.send({ type: 'seek', position: 120, wasPlaying: false })
    const first = await owner.next((frame) => frame.type === 'state')
    assert.equal(first.reason, 'seek')
    assert.equal(first.playback.position, 120)
    await owner.next((frame) => frame.type === 'chat' && String(frame.text).includes('seeked'))
    const at = fixture.room.revision

    // 0.2 s from where the room already is: the second arrival of that move.
    // The target comes from `expected()`, the one function that owns positions.
    const next = expected(fixture.room.playback, Date.now()) + 0.2
    owner.send({ type: 'seek', position: next, wasPlaying: false })
    await settle()
    assert.equal(fixture.room.revision, at, 'a duplicate seek bumps no revision')
    assert.equal(
      owner.inbox.filter((frame) => frame.type === 'state').length,
      0,
      'a duplicate seek sends no state',
    )
    assert.equal(
      owner.inbox.filter((frame) => frame.type === 'chat' && String(frame.text).includes('seeked')).length,
      0,
      'and does not claim to have seeked',
    )

    owner.send({ type: 'seek', position: 200, wasPlaying: false })
    const second = await owner.next((frame) => frame.type === 'state')
    assert.equal(second.revision, at + 1)
    assert.equal(second.playback.position, 200)
  } finally {
    await fixture.close()
  }
})

test('revision rises by exactly one per accepted command — never a jump, never a fall', async () => {
  const fixture = await openRoom()
  const owner = connect('127.0.0.1', fixture.port)
  try {
    await owner.ready
    await owner.hello(CODE, 'sam')
    const start = fixture.room.revision

    // Each entry carries whether §5's idempotency rule should skip it.
    const script: Array<{ frame: Frame; skipped: boolean }> = [
      { frame: { type: 'play', position: 0 }, skipped: false },
      { frame: { type: 'pause', position: 0.5 }, skipped: false },
      { frame: { type: 'seek', position: 60, wasPlaying: false }, skipped: false },
      { frame: { type: 'play', position: 60 }, skipped: false },
      { frame: { type: 'play', position: 60 }, skipped: true }, // already playing
      { frame: { type: 'pause', position: 61 }, skipped: false },
      { frame: { type: 'pause', position: 61 }, skipped: true }, // already paused
      { frame: { type: 'seek', position: 61, wasPlaying: false }, skipped: true }, // where it is
    ]

    let last = start
    for (const [index, step] of script.entries()) {
      owner.send(step.frame)
      if (step.skipped) {
        await settle()
        assert.equal(fixture.room.revision, last, `command ${index} was a duplicate and moved nothing`)
        continue
      }
      const state = await owner.next((frame) => frame.type === 'state')
      assert.equal(state.revision, last + 1, `command ${index} rose by exactly one`)
      last = state.revision
    }

    assert.equal(fixture.room.revision, last, 'the room agrees with the last frame it sent')
    assert.equal(last, start + 5, 'five accepted commands, five revisions')
  } finally {
    await fixture.close()
  }
})

test('a raw report moves nothing: no state, no revision change, no writer but commands', async () => {
  const fixture = await openRoom()
  const owner = connect('127.0.0.1', fixture.port)
  try {
    await owner.ready
    await owner.hello(CODE, 'sam')
    const before = { revision: fixture.room.revision, playback: { ...fixture.room.playback } }

    // §5's `report` frame, from a scripted socket rather than a player: the
    // most direct attempt a member could make to move the room by reporting.
    owner.send({
      type: 'report',
      position: 999.5,
      readyState: 4,
      buffered: 5,
      rate: 1,
      duration: 600,
      origin: 'https://example.test/watch',
      rtt: 20,
    })
    await settle()
    assert.equal(fixture.room.revision, before.revision, 'a report is not a command')
    assert.deepEqual(fixture.room.playback, before.playback, 'and `playback` has no second writer')
    assert.equal(
      owner.inbox.filter((frame) => frame.type === 'state').length,
      0,
      'nothing was broadcast',
    )

    // The same socket is still healthy: the next real command is applied.
    owner.send({ type: 'play', position: 0 })
    const state = await owner.next((frame) => frame.type === 'state')
    assert.equal(state.revision, before.revision + 1, 'exactly one, from the command')
  } finally {
    await fixture.close()
  }
})

// T6b, R7: "join 20 min into a film" (§2). The snapshot the newcomer receives
// carries the room's `playback` at its `revision`, so its player can be put on
// that position without asking for anything. That the others hear no `state` is
// the ticket's Safety line: an arrival is not a command, so it cannot start a
// ping-pong with the room.
test('a late joiner is handed the room position in `welcome`, and its arrival broadcasts no state', async () => {
  const fixture = await openRoom()
  const owner = connect('127.0.0.1', fixture.port)
  const late = connect('127.0.0.1', fixture.port)
  try {
    await owner.ready
    await owner.hello(CODE)

    // The room is 12 s in and playing, from its only writer.
    owner.send({ type: 'play', position: 12 })
    const play = await owner.next((frame) => frame.type === 'state' && frame.reason === 'play')
    assert.equal(play.playback.playing, true)

    await late.ready
    const welcome = await late.hello(CODE)
    assert.equal(welcome.room.playback.playing, true)
    assert.equal(welcome.room.playback.position, 12)
    assert.ok(welcome.room.revision > play.revision, 'the snapshot is at the room’s revision')

    // Nobody else heard it; a reloaded window produces no command on arrival.
    let surprise: Frame | null = null
    try {
      surprise = await owner.next(
        (frame) => frame.type === 'state' && frame.revision > play.revision,
        250,
      )
    } catch {
      surprise = null
    }
    assert.equal(
      surprise,
      null,
      `the owner received a state for the arrival: ${JSON.stringify(surprise)}`,
    )
    assert.equal(fixture.room.revision, welcome.room.revision, 'and nothing moved')
  } finally {
    await fixture.close()
  }
})
