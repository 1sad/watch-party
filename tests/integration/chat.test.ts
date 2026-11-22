import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import { createRoom } from '../../src/server/room.ts'
import { attachRoomSocket } from '../../src/server/socket.ts'
import { settle, waitFor } from './harness.ts'

// T4's checks against a real socket: the chat frame, the two limits that
// matter over the wire, the one order everyone sees, and §4.6's system lines.
// The limit maths itself is unit-tested in tests/unit/chat.test.ts.

const CODE = 'AAAAAA'

interface Frame {
  type: string
  [key: string]: any
}

async function openRoom(
  options: { now?: () => number; log?: (line: string) => void } = {},
): Promise<{
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

test('joins, a leave and a seek make exactly the system entries and nothing else', async () => {
  const fixture = await openRoom()
  const owner = connect(fixture.port)
  const guest = connect(fixture.port)
  try {
    await owner.ready
    await owner.hello(CODE, 'sam')
    const joinLine = await owner.next((frame) => frame.type === 'chat')
    assert.equal(joinLine.text, 'sam joined')

    // F4: the leaver has to be a guest. An owner's close now ends the room
    // unconditionally, and a dead room admits nobody to read the tail.
    await guest.ready
    await guest.hello(CODE, 'alex')
    const guestJoin = await guest.next((frame) => frame.type === 'chat')
    assert.equal(guestJoin.text, 'alex joined')

    owner.send({ type: 'seek', position: 12.34, wasPlaying: false })
    const seekLine = await owner.next(
      (frame) => frame.type === 'chat' && frame.text.startsWith('sam seeked'),
    )
    assert.equal(seekLine.text, 'sam seeked to 0:12')
    assert.equal(seekLine.kind, 'system')
    assert.equal(seekLine.memberId, undefined)

    const closed = new Promise<void>((resolve) => guest.socket.once('close', () => resolve()))
    guest.socket.close()
    await closed
    await owner.next((frame) => frame.type === 'chat' && frame.text === 'alex left')

    const late = connect(fixture.port)
    try {
      await late.ready
      const welcome = await late.hello(CODE, 'robin')
      assert.equal(
        welcome.chatTail.length,
        4,
        'two joins, a seek and a leave — and nothing else',
      )
      assert.deepEqual(
        welcome.chatTail.map((entry: Frame) => [entry.kind, entry.text]),
        [
          ['system', 'sam joined'],
          ['system', 'alex joined'],
          ['system', 'sam seeked to 0:12'],
          ['system', 'alex left'],
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

test('one accepted message is one ASCII [chat] line with sender, id and length; a refusal is none', async () => {
  // T22b: T22's sidecar line is a claim, not only a run that happened to be ASCII.
  const lines: string[] = []
  const fixture = await openRoom({ log: (line) => lines.push(line) })
  const chatLines = () => lines.filter((line) => line.startsWith('[chat]'))
  const sam = connect(fixture.port)
  const alex = connect(fixture.port)
  try {
    await sam.ready
    await sam.hello(CODE, 'sam')
    await alex.ready
    await alex.hello(CODE, 'alex')

    // Two members seated, then one message. 'héllo ✓' is seven UTF-16 units and
    // ten UTF-8 bytes, so `chars=7` also says the count is the length, not bytes.
    const text = 'héllo ✓'
    sam.send({ type: 'chat', text })
    const posted = await sam.next((frame) => frame.type === 'chat' && frame.kind === 'user')
    await waitFor(() => chatLines().length > 0, 2000, 'the [chat] line')
    assert.equal(chatLines().length, 1, 'one accepted message, exactly one line')
    const line = chatLines()[0]!
    assert.equal(
      line,
      `[chat] m=${posted.id} from=${posted.memberId} chars=7`,
      'the line is the sender, the message id and the length, in that shape',
    )
    assert.doesNotMatch(line, /[^\x20-\x7e]/, 'ASCII whatever was typed (AGENTS.md rule 10)')
    assert.ok(!line.includes('héllo'), 'never the text')
    assert.ok(!line.includes('✓'), 'not even the character that is not ASCII')

    // A message the sidecar refuses is not a message: no [chat] line for it.
    sam.send({ type: 'chat', text: 'x'.repeat(3000) })
    const refusal = await sam.next((frame) => frame.type === 'error')
    assert.equal(refusal.code, 'chat_too_long')
    await settle(150)
    assert.equal(chatLines().length, 1, 'the refusal logged nothing')
  } finally {
    await fixture.close()
  }
})
