import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import { createRoom } from '../../src/server/room.ts'
import { attachRoomSocket } from '../../src/server/socket.ts'
import { findLanIp } from '../../src/server/discovery.ts'
import { sampleFrom } from '../../src/shared/timing.ts'

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

test('five members is the ceiling: the sixth hello is room_full and members still has five', async () => {
  const fixture = await openRoom()
  const joined = []
  try {
    for (let index = 0; index < 5; index += 1) {
      const client = connect('127.0.0.1', fixture.port)
      await client.ready
      await client.hello(CODE, `friend ${index + 1}`)
      joined.push(client)
    }

    const sixth = connect('127.0.0.1', fixture.port)
    await sixth.ready
    sixth.send({ type: 'hello', code: CODE, name: 'sixth' })
    const refusal = await sixth.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'room_full')

    const five = await joined[0]!.next((frame) => frame.type === 'members' && frame.members.length === 5)
    assert.equal(five.members.length, 5)
    assert.equal(fixture.room.members.size, 5)
    assert.equal(
      joined[0]!.inbox.some((frame) => frame.type === 'members' && frame.members.length > 5),
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

    owner.send({ type: 'pause', position: 12.5 })
    const state = await guest.next((frame) => frame.type === 'state')
    assert.equal(state.revision, guestWelcome.room.revision + 1, 'only the accepted command moved it')
    assert.equal(state.by, ownerWelcome.selfId)
    assert.equal(state.playback.playing, false)
    assert.equal(state.playback.position, 12.5)
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
