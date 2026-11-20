import test from 'node:test'
import assert from 'node:assert/strict'

import { isRoomCode, newRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../src/shared/room.ts'

test('a room code is six characters from §4.1, with no O, 0, I or 1', () => {
  assert.equal(ROOM_CODE_LENGTH, 6)
  for (const forbidden of ['O', '0', 'I', '1']) {
    assert.equal(ROOM_CODE_ALPHABET.includes(forbidden), false, `${forbidden} must not be in the alphabet`)
  }

  for (let run = 0; run < 500; run += 1) {
    const code = newRoomCode()
    assert.equal(code.length, 6)
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/)
    assert.equal(isRoomCode(code), true)
  }
})

test('the generator only uses the alphabet, whatever the random source says', () => {
  assert.equal(newRoomCode(() => 0), 'AAAAAA')
  assert.equal(newRoomCode(() => ROOM_CODE_ALPHABET.length - 1), '999999')
  assert.equal(isRoomCode('ABC123'), false) // "1" is out
  assert.equal(isRoomCode('ABCDE'), false) // too short
})
