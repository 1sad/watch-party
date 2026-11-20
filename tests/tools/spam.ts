/**
 * R5 on the wire: write 120 messages into a room, join late, see exactly 100.
 *
 * The clock leaps 3 s per frame so the time limits stay legal — this script is
 * about the ring buffer; the limit rules are unit-tested in tests/unit/chat.ts.
 *
 * Run: node tests/tools/spam.ts
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import { createRoom } from '../../src/server/room.ts'
import { attachRoomSocket } from '../../src/server/socket.ts'

const TOTAL = 120
let clock = 1_000_000
const room = createRoom('AAAAAA')
const server = createServer()
const wss = attachRoomSocket(server, room, { now: () => (clock += 3_000) })
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const { port } = server.address() as AddressInfo

function dial(): { socket: WebSocket; frames: Array<Record<string, any>> } {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  const frames: Array<Record<string, any>> = []
  socket.on('message', (data) => frames.push(JSON.parse(String(data))))
  return { socket, frames }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let tries = 0; !predicate(); tries += 1) {
    if (tries > 2_000) throw new Error('timed out waiting for the room')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const users = (frames: Array<Record<string, any>>) =>
  frames.filter((frame) => frame.type === 'chat' && frame.kind === 'user')

const poster = dial()
await new Promise<void>((resolve) => poster.socket.once('open', () => resolve()))
poster.socket.send(JSON.stringify({ type: 'hello', code: 'AAAAAA', name: 'sam' }))
await until(() => poster.frames.some((frame) => frame.type === 'welcome'))
for (let index = 1; index <= TOTAL; index += 1) {
  poster.socket.send(JSON.stringify({ type: 'chat', text: `message ${index}` }))
}
await until(() => users(poster.frames).length === TOTAL)

const late = dial()
await new Promise<void>((resolve) => late.socket.once('open', () => resolve()))
late.socket.send(JSON.stringify({ type: 'hello', code: 'AAAAAA', name: 'alex' }))
await until(() => late.frames.some((frame) => frame.type === 'welcome'))
const welcome = late.frames.find((frame) => frame.type === 'welcome')!

const expected = users(poster.frames).slice(-100).map((frame) => frame.id)
const actual = welcome.chatTail.map((entry: { id: string }) => entry.id)
console.log(`posted ${TOTAL}, late joiner chatTail = ${welcome.chatTail.length}`)
console.log(`first ${actual[0]}, last ${actual[actual.length - 1]}`)

if (welcome.chatTail.length !== 100 || JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(`R5 FAIL: expected the last 100 ids, got ${welcome.chatTail.length}`)
  process.exitCode = 1
} else {
  console.log('R5 pass: 120 written, 100 replayed, in order')
}

for (const socket of wss.clients) socket.terminate()
await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())))
