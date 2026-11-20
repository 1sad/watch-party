import test from 'node:test'
import assert from 'node:assert/strict'

import {
  admitChat,
  CHAT_BUFFER_SIZE,
  CHAT_BYTES_PER_MINUTE,
  CHAT_MAX_CHARS,
  CHAT_MUTE_MS,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  formatClock,
  newChatBudget,
  pushChat,
} from '../../src/shared/chat.ts'
import { createRoom, postChat, postSystemChat } from '../../src/server/room.ts'
import type { ChatMessage } from '../../src/shared/protocol.ts'

function message(id: string): ChatMessage {
  return { id, kind: 'user', name: 'sam', text: id, ts: 0 }
}

test('the buffer is a fixed 100 and keeps the newest end, in order', () => {
  assert.equal(CHAT_BUFFER_SIZE, 100)
  const buffer: ChatMessage[] = []
  for (let index = 1; index <= 120; index += 1) pushChat(buffer, message(`m${index}`))

  assert.equal(buffer.length, 100)
  assert.equal(buffer[0]!.id, 'm21')
  assert.equal(buffer[99]!.id, 'm120')
})

test('one message is capped at 2000 characters; 2000 is accepted, 2001 is refused', () => {
  assert.equal(CHAT_MAX_CHARS, 2000)
  const budget = newChatBudget()

  assert.deepEqual(admitChat(budget, 'x'.repeat(2000), 1_000), { ok: true })
  assert.deepEqual(admitChat(budget, 'x'.repeat(2001), 5_000), {
    ok: false,
    code: 'chat_too_long',
    muted: false,
  })
  // A refusal records nothing: only the accepted message is in the window.
  assert.equal(budget.accepted.length, 1)
  assert.equal(budget.bytes.length, 1)
})

test('five messages in 10 s pass, the sixth mutes for 10 s and says so once', () => {
  assert.equal(CHAT_RATE_LIMIT, 5)
  assert.equal(CHAT_RATE_WINDOW_MS, 10_000)
  assert.equal(CHAT_MUTE_MS, 10_000)
  const budget = newChatBudget()

  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(admitChat(budget, `msg ${index}`, index * 100), { ok: true })
  }

  assert.deepEqual(admitChat(budget, 'sixth', 490), {
    ok: false,
    code: 'chat_rate_limited',
    muted: true,
  })
  // Still refused a second later, and no second warning.
  assert.deepEqual(admitChat(budget, 'seventh', 1_490), {
    ok: false,
    code: 'chat_rate_limited',
    muted: false,
  })
  // And for the whole mute, even with the rate window empty.
  assert.deepEqual(admitChat(budget, 'ninth', 9_000), {
    ok: false,
    code: 'chat_rate_limited',
    muted: false,
  })
  // Once the mute expires and the window has moved on, chat works again.
  assert.deepEqual(admitChat(budget, 'tenth', 10_490), { ok: true })
})

test('33 KB inside a minute trips the bytes cap while the message count stays legal', () => {
  const budget = newChatBudget()
  const big = 'x'.repeat(2000)

  let refused = 0
  let accepted = 0
  for (let index = 0; index < 17; index += 1) {
    const verdict = admitChat(budget, big, index * 3_000)
    assert.ok(
      budget.accepted.length <= CHAT_RATE_LIMIT,
      'the rate limit is never reached: 3 s apart is 4 per 10 s',
    )
    if (verdict.ok) accepted += 1
    else {
      refused += 1
      assert.equal(verdict.code, 'chat_byte_limit')
    }
  }

  assert.equal(accepted, 16, '16 x 2000 chars is 32 000 bytes, under the cap')
  assert.equal(refused, 1, 'the 17th would be 34 000 bytes')
  assert.equal(accepted * 2000 <= CHAT_BYTES_PER_MINUTE, true)
})

test('a message older than a minute stops counting against the bytes cap', () => {
  const budget = newChatBudget()
  const big = 'x'.repeat(2000)

  for (let index = 0; index < 16; index += 1) {
    assert.equal(admitChat(budget, big, index * 3_000).ok, true)
  }
  assert.equal(admitChat(budget, big, 45_000).ok, false)
  // 61 s after the first message, the oldest twelve have aged out.
  assert.equal(admitChat(budget, big, 62_000).ok, true)
})

test('a seek is written as mm:ss', () => {
  assert.equal(formatClock(754.9), '12:34')
  assert.equal(formatClock(5), '0:05')
  assert.equal(formatClock(-2), '0:00')
  assert.equal(formatClock(Number.NaN), '0:00')
})

test('plain text is stored verbatim: nothing is escaped, parsed or fetched', () => {
  const room = createRoom('AAAAAA')
  const text = '<b>hi</b> & <script>alert(1)</script> https://example.test'
  const posted = postChat(room, { kind: 'user', memberId: 'm1', name: 'sam', text }, () => 1)
  assert.equal(posted.text, text)
  assert.equal(room.chat[0]!.text, text)
})

test('the room mints sortable ids, marks system lines, and trims its own buffer', () => {
  const room = createRoom('AAAAAA')
  let clock = 1_000
  const now = () => (clock += 1)

  const joined = postSystemChat(room, 'nobody', (label) => `${label} joined`, now)
  const first = postChat(room, { kind: 'user', memberId: 'm1', name: 'sam', text: 'hi' }, now)
  const second = postChat(room, { kind: 'user', memberId: 'm2', name: 'alex', text: 'yo' }, now)

  assert.deepEqual([joined.kind, first.kind], ['system', 'user'])
  assert.equal(joined.memberId, undefined, '§4.6: a system message has no memberId')
  assert.equal(first.memberId, 'm1')
  assert.ok(joined.id < first.id && first.id < second.id, 'ids sort in arrival order')
  assert.ok(first.ts < second.ts)
  assert.deepEqual(
    room.chat.map((entry) => entry.id),
    [joined.id, first.id, second.id],
  )

  for (let index = 0; index < 120; index += 1) {
    postChat(room, { kind: 'user', memberId: 'm1', name: 'sam', text: `spam ${index}` }, now)
  }
  assert.equal(room.chat.length, CHAT_BUFFER_SIZE)
})
