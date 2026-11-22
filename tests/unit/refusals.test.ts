import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADDRESS_BLOCK_MS,
  ADDRESS_REFUSAL_LIMIT,
  ADDRESS_REFUSAL_WINDOW_MS,
  SOCKET_REFUSAL_LIMIT,
  createRefusalBook,
} from '../../src/server/socket.ts'

/** A clock the test moves by hand, so "a minute" is instant. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

test('the limits are T68 item 2: five on a socket, twenty a minute for an address', () => {
  assert.equal(SOCKET_REFUSAL_LIMIT, 5)
  assert.equal(ADDRESS_REFUSAL_LIMIT, 20)
  assert.equal(ADDRESS_REFUSAL_WINDOW_MS, 60_000)
  assert.equal(ADDRESS_BLOCK_MS, 60_000)
})

test('one socket is closed on its fifth refused join, and not before', () => {
  const book = createRefusalBook()
  const socket = {}

  for (let attempt = 1; attempt < SOCKET_REFUSAL_LIMIT; attempt += 1) {
    const verdict = book.refuse(socket, '10.0.0.2')
    assert.equal(verdict.socketRefusals, attempt)
    assert.equal(verdict.closeSocket, false, `attempt ${attempt} must not close the socket`)
  }

  const fifth = book.refuse(socket, '10.0.0.2')
  assert.equal(fifth.socketRefusals, SOCKET_REFUSAL_LIMIT)
  assert.equal(fifth.closeSocket, true)
})

test('twenty refused joins from one address bar it until the block runs out', () => {
  const clock = fakeClock()
  const book = createRefusalBook(clock.now)

  // One socket each, so the per-socket limit cannot be what bars the address.
  for (let attempt = 1; attempt < ADDRESS_REFUSAL_LIMIT; attempt += 1) {
    const verdict = book.refuse({}, '10.0.0.3')
    assert.equal(verdict.addressRefusals, attempt)
    assert.equal(verdict.blockAddress, false)
  }

  const twentieth = book.refuse({}, '10.0.0.3')
  assert.equal(twentieth.addressRefusals, ADDRESS_REFUSAL_LIMIT)
  assert.equal(twentieth.blockAddress, true)
  assert.equal(book.blocked('10.0.0.3'), true)
  // Another address is untouched by this one's bill.
  assert.equal(book.blocked('10.0.0.4'), false)

  clock.advance(ADDRESS_BLOCK_MS - 1)
  assert.equal(book.blocked('10.0.0.3'), true, 'still barred one millisecond before the minute is up')

  clock.advance(1)
  assert.equal(book.blocked('10.0.0.3'), false, 'the bar is exactly ADDRESS_BLOCK_MS long')
})

test('refusals older than the window do not count towards the address limit', () => {
  const clock = fakeClock()
  const book = createRefusalBook(clock.now)

  for (let attempt = 1; attempt < ADDRESS_REFUSAL_LIMIT; attempt += 1) book.refuse({}, '10.0.0.5')

  clock.advance(ADDRESS_REFUSAL_WINDOW_MS)
  const later = book.refuse({}, '10.0.0.5')
  assert.equal(later.addressRefusals, 1, 'the previous minute has fallen out of the window')
  assert.equal(later.blockAddress, false)
})

test('the socket count is forgotten on close while the address keeps its own', () => {
  const book = createRefusalBook()
  const socket = {}

  book.refuse(socket, '10.0.0.6')
  book.refuse(socket, '10.0.0.6')
  book.forget(socket)

  const afterReconnect = book.refuse(socket, '10.0.0.6')
  assert.equal(afterReconnect.socketRefusals, 1, 'a new socket starts its own count')
  assert.equal(afterReconnect.addressRefusals, 3, 'the address still remembers all three')
})
