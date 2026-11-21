/**
 * T9b: the room ends with the file's owner.
 *
 * Two rules live here, both of them facts about the authority rather than about a
 * window: §4.5 says a file room has no per-viewer offset to set, and §14/ADR-024
 * say a file room dies with the owner's app, because that app holds the only copy
 * of the bytes. The live half of the ticket (the overlay in a second window) is
 * measured in the app; this is the protocol half, on real sockets.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

import { ROOM_OVER_SENTENCE, type ChatMessage, type RoomOverFrame } from '../../src/shared/protocol.ts'
import { createRoom, type RoomState } from '../../src/server/room.ts'
import { attachRoomSocket } from '../../src/server/socket.ts'
import { ScriptedClient } from '../support/client.ts'
import type { WebSocketServer } from 'ws'

const CODE = 'T9B001'
const FIXTURE = fileURLToPath(new URL('../fixtures/fixture.mp4', import.meta.url))
const NAMES = ['sam', 'alex', 'robin']

interface TestRoom {
  room: RoomState
  wss: WebSocketServer
  clients: ScriptedClient[]
  close(): Promise<void>
}

/** One authority, real sockets on loopback, the given number of seated members. */
async function openRoom(members: number): Promise<TestRoom> {
  const room = createRoom(CODE)
  const server = createServer()
  const wss = attachRoomSocket(server, room)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  const clients: ScriptedClient[] = []
  for (let index = 0; index < members; index += 1) {
    clients.push(await ScriptedClient.open(port, CODE, NAMES[index]))
  }

  return {
    room,
    wss,
    clients,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()))
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())))
    },
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('T9b: `setOffset` is not implemented — no member carries an offset, and no frame moves one', async () => {
  const harness = await openRoom(2)
  try {
    const [, guest] = harness.clients as [ScriptedClient, ScriptedClient]
    assert.deepEqual(
      guest.welcome.members.map((member) => member.timelineOffset),
      [0, 0],
      'a file room opens with no per-viewer offset',
    )

    const membersBefore = guest.frames.filter((record) => record.frame.type === 'members').length
    // §5's table names `setOffset` but §4.5 says it is website-mode only. Sent
    // anyway, it is an unknown frame: §5's last rule ignores it.
    guest.send({ type: 'setOffset', timelineOffset: 30 })
    await delay(200)

    assert.deepEqual(
      [...harness.room.members.values()].map((member) => member.timelineOffset),
      [0, 0],
      'the offset stayed 0 for the owner and the guest',
    )
    assert.equal(
      guest.frames.filter((record) => record.frame.type === 'members').length,
      membersBefore,
      'an ignored frame broadcasts nothing: no member list moved',
    )
  } finally {
    await harness.close()
  }
})

test('T9b: the owner leaving a file room ends it — one system line, one roomOver, and nothing kept', async () => {
  const harness = await openRoom(2)
  try {
    const [owner, guest] = harness.clients as [ScriptedClient, ScriptedClient]
    owner.send({
      type: 'setMedia',
      id: 'f1',
      title: 'Fixture',
      duration: 60,
      path: FIXTURE,
      epoch: owner.welcome.epoch,
    })
    await guest.next((frame) => frame.type === 'media' && frame.media !== null)
    assert.ok(harness.room.media !== null, 'this is a file room')

    const guestClosed = new Promise<void>((resolve) => guest.socket.once('close', () => resolve()))
    await owner.close()

    const over = await guest.next((frame) => frame.type === 'roomOver')
    assert.equal((over.frame as RoomOverFrame).reason, 'owner_left')
    assert.equal(over.frame.type, 'roomOver')

    const lines = guest.frames.filter(
      (record) => record.frame.type === 'chat' && record.frame.text === ROOM_OVER_SENTENCE,
    )
    assert.equal(lines.length, 1, 'the room’s end is exactly one system line')
    assert.equal((lines[0]?.frame as ChatMessage).kind, 'system')

    await guestClosed

    // §4.4/check 3: the replica is discarded, not kept. The file's path goes
    // with it, so `/media/<id>` cannot serve a room whose owner is gone.
    assert.equal(harness.room.media, null, 'the file is not kept')
    assert.equal(harness.room.members.size, 0, 'the members are not kept')
    assert.equal(harness.room.chat.length, 0, 'the chat is not kept')
    assert.equal(harness.room.owner, null)
    assert.equal(harness.wss.clients.size, 0, 'and no socket is left holding the dead room')
  } finally {
    await harness.close()
  }
})

test('T9b: a guest leaving a file room does not end it', async () => {
  const harness = await openRoom(2)
  try {
    const [owner, guest] = harness.clients as [ScriptedClient, ScriptedClient]
    owner.send({
      type: 'setMedia',
      id: 'f1',
      title: 'Fixture',
      duration: 60,
      path: FIXTURE,
      epoch: owner.welcome.epoch,
    })
    await guest.next((frame) => frame.type === 'media' && frame.media !== null)

    await guest.close()

    const left = await owner.next((frame) => frame.type === 'chat' && frame.text === 'alex left')
    assert.equal((left.frame as ChatMessage).kind, 'system')
    assert.equal(harness.room.media?.id, 'f1', 'the owner’s file is still the room’s')
    assert.equal(
      owner.frames.some((record) => record.frame.type === 'roomOver'),
      false,
      'nobody was told the room ended',
    )
  } finally {
    await harness.close()
  }
})
