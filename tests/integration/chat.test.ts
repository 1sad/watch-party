import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import { createRoom } from '../../src/server/room.ts'
import { attachRoomSocket } from '../../src/server/socket.ts'

// T4's checks against a real socket: the chat frame, the two limits that
// matter over the wire, the one order everyone sees, and §4.6's system lines.
// The limit maths itself is unit-tested in tests/unit/chat.test.ts.

const CODE = 'AAAAAA'

interface Frame {
  type: string
  [key: string]: any
}

async function openRoom(options: { now?: () => number } = {}): Promise<{
  room: ReturnType<typeof createRoom>
  port: number
  close: () => Promise<void>
}> {
  const room = createRoom(CODE)
  const server = createServer()
  const wss = attachRoomSocket(server, room, options)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
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

function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  const inbox: Frame[] = []
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = []

  socket.on('error', () => {
    // Surfaced through the wait timeouts instead.
  })
  socket.on('message', (data: unknown) => {
    const frame = JSON.parse(String(data)) as Frame
    const index = waiters.findIndex((waiter) => waiter.match(frame))
    if (index === -1) inbox.push(frame)
    else waiters.splice(index, 1)[0]!.resolve(frame)
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
    /** Sends one `chat` and resolves with the next chat frame it receives. */
    say(text: string): Promise<Frame> {
      client.send({ type: 'chat', text })
      return client.next((frame) => frame.type === 'chat' && frame.kind === 'user')
    },
  }
  return client
}

test('a 3000-character chat is refused for length and the buffer does not grow', async () => {
  const fixture = await openRoom()
  const client = connect(fixture.port)
  try {
    await client.ready
    await client.hello(CODE, 'sam')

    const before = fixture.room.chat.length
    client.send({ type: 'chat', text: 'x'.repeat(3000) })
    const refusal = await client.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'chat_too_long')
    assert.equal(typeof refusal.message, 'string')
    assert.equal(fixture.room.chat.length, before, 'the refusal recorded nothing')

    // The socket is still usable, and the largest legal message is accepted.
    const accepted = await client.say('x'.repeat(2000))
    assert.equal(accepted.text.length, 2000)
    assert.equal(fixture.room.chat.length, before + 1)
  } finally {
    await fixture.close()
  }
})

test('the sixth message in two seconds is refused with the mute code and a warning; a seventh stays refused', async () => {
  const fixture = await openRoom()
  const client = connect(fixture.port)
  try {
    await client.ready
    await client.hello(CODE, 'sam')
    await client.next((frame) => frame.type === 'chat' && frame.kind === 'system')

    for (let index = 0; index < 5; index += 1) await client.say(`message ${index}`)

    client.send({ type: 'chat', text: 'sixth' })
    const warning = await client.next((frame) => frame.type === 'warning')
    assert.equal(warning.code, 'chat_rate_limited')
    const refusal = await client.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'chat_rate_limited')

    await new Promise((resolve) => setTimeout(resolve, 1000))
    client.send({ type: 'chat', text: 'seventh' })
    const stillRefused = await client.next((frame) => frame.type === 'error')
    assert.equal(stillRefused.code, 'chat_rate_limited')
    assert.equal(
      fixture.room.chat.filter((entry) => entry.kind === 'user').length,
      5,
      'exactly five messages reached the room',
    )
    assert.equal(fixture.room.chat.length, 6, 'five messages and the join line')
  } finally {
    await fixture.close()
  }
})

test('33 KB inside a minute trips the bytes cap: 16 accepted, the 17th refused, message count legal', async () => {
  let clock = 1_000_000
  const fixture = await openRoom({ now: () => clock })
  const client = connect(fixture.port)
  try {
    await client.ready
    await client.hello(CODE, 'sam')
    await client.next((frame) => frame.type === 'chat' && frame.kind === 'system')

    const big = 'x'.repeat(2000)
    for (let index = 0; index < 16; index += 1) {
      clock += 3_000
      await client.say(big)
    }
    clock += 3_000
    client.send({ type: 'chat', text: big })
    const refusal = await client.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'chat_byte_limit')

    assert.equal(fixture.room.chat.length, 17, 'the join line and sixteen messages')
    assert.equal(fixture.room.chat.filter((entry) => entry.kind === 'user').length, 16)
  } finally {
    await fixture.close()
  }
})

test('two members sending in the same millisecond see the same order and ids, sender included', async () => {
  const fixture = await openRoom({ now: () => 5_000_000 })
  const sam = connect(fixture.port)
  const alex = connect(fixture.port)
  try {
    await sam.ready
    await sam.hello(CODE, 'sam')
    await alex.ready
    await alex.hello(CODE, 'alex')

    sam.send({ type: 'chat', text: 'a' })
    alex.send({ type: 'chat', text: 'b' })

    const isUser = (frame: Frame) => frame.type === 'chat' && frame.kind === 'user'
    const seenBySam = [await sam.next(isUser), await sam.next(isUser)]
    const seenByAlex = [await alex.next(isUser), await alex.next(isUser)]

    // Whatever the arrival order is, both windows were told the same one.
    assert.deepEqual(
      seenBySam.map((frame) => [frame.id, frame.text, frame.ts]),
      seenByAlex.map((frame) => [frame.id, frame.text, frame.ts]),
    )
    assert.deepEqual(seenBySam.map((frame) => frame.text).sort(), ['a', 'b'])
    const ids = seenBySam.map((frame) => frame.id)
    assert.ok(ids[0]! < ids[1]!, 'ids sort the way the authority ordered them')
    assert.deepEqual(
      fixture.room.chat.filter((entry) => entry.kind === 'user').map((entry) => entry.id),
      ids,
    )
    // The sender's own line came back over the socket, carrying its sender.
    const samsOwn = seenBySam.find((frame) => frame.text === 'a')!
    assert.equal(typeof samsOwn.memberId, 'string')
    assert.ok(fixture.room.members.has(samsOwn.memberId), 'the sender received its own copy')
    assert.notEqual(
      seenBySam.find((frame) => frame.text === 'a')!.memberId,
      seenBySam.find((frame) => frame.text === 'b')!.memberId,
      'each line carries its own sender',
    )
  } finally {
    await fixture.close()
  }
})

test('a join, a leave and a seek make exactly three system entries and nothing else', async () => {
  const fixture = await openRoom()
  const owner = connect(fixture.port)
  try {
    await owner.ready
    await owner.hello(CODE, 'sam')
    const joinLine = await owner.next((frame) => frame.type === 'chat')
    assert.equal(joinLine.text, 'sam joined')

    owner.send({ type: 'seek', position: 12.34, wasPlaying: false })
    const seekLine = await owner.next((frame) => frame.type === 'chat')
    assert.equal(seekLine.text, 'sam seeked to 0:12')
    assert.equal(seekLine.kind, 'system')
    assert.equal(seekLine.memberId, undefined)

    const closed = new Promise<void>((resolve) => owner.socket.once('close', () => resolve()))
    owner.socket.close()
    await closed

    const late = connect(fixture.port)
    try {
      await late.ready
      const welcome = await late.hello(CODE, 'alex')
      assert.equal(welcome.chatTail.length, 3, 'joined, seeked, left — and nothing else')
      assert.deepEqual(
        welcome.chatTail.map((entry: Frame) => [entry.kind, entry.text]),
        [
          ['system', 'sam joined'],
          ['system', 'sam seeked to 0:12'],
          ['system', 'sam left'],
        ],
      )
      assert.deepEqual(
        welcome.chatTail.filter((entry: Frame) => entry.memberId !== undefined),
        [],
        '§4.6: a system line carries no memberId',
      )
    } finally {
      const closedLate = new Promise<void>((resolve) =>
        late.socket.once('close', () => resolve()),
      )
      late.socket.close()
      await closedLate
    }
  } finally {
    await fixture.close()
  }
})
