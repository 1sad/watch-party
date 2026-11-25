/**
 * T148 / ADR-033 rule 1: the stored identity record.
 *
 * Only the pure half lives here - the cookie itself is read and written by the
 * page, and a browser is where "a second load finds the same id" is measured.
 * These cases pin the record's encoding and the id's shape, so the live check
 * reads one document rather than guessing one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeIdentity,
  encodeIdentity,
  memberIdentity,
  mintMemberId,
  rememberMemberName,
  rememberSeat,
} from '../../src/ui/identity.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('T148: the identity record round-trips through the cookie value it is stored as', () => {
  const named = { id: 'ada00000-0000-4000-8000-000000000148', name: 'Ada Lovelace' }
  assert.deepEqual(decodeIdentity(decodeURIComponent(encodeIdentity(named))), named)

  const anonymous = { id: named.id, name: null }
  assert.deepEqual(decodeIdentity(decodeURIComponent(encodeIdentity(anonymous))), anonymous)

  // The encoding cannot split the cookie on `;` or a non-ASCII character.
  const awkward = { id: named.id, name: 'Ada; Lovelace=1 ünïcode' }
  const value = encodeIdentity(awkward)
  assert.equal(value.includes(';'), false, 'a semicolon would end the cookie')
  assert.deepEqual(decodeIdentity(decodeURIComponent(value)), awkward)
})

test('T165 / ADR-053: the seat proof rides in the same record, and an older record has none', () => {
  const proved = {
    id: 'ada00000-0000-4000-8000-000000000165',
    name: 'Ada Lovelace',
    proof: 'ab'.repeat(32),
  }
  assert.deepEqual(decodeIdentity(decodeURIComponent(encodeIdentity(proved))), proved)
  assert.deepEqual(
    decodeIdentity('{"id":"abc"}'),
    { id: 'abc', name: null },
    'a record written before the proof existed still carries an id and no proof',
  )
  assert.deepEqual(
    decodeIdentity('{"id":"abc","proof":""}'),
    { id: 'abc', name: null },
    'an empty proof is no proof at all',
  )
})

test('T172 / ADR-053: a welcome re-seats the record under the id and proof the room issued', () => {
  // The record before the room answers: one id, one proof, and the name this
  // window remembers.
  const refusedId = 'ada00000-0000-4000-8000-000000000172'
  const roomId = 'bob00000-0000-4000-8000-000000000172'
  const refusedProof = 'a1'.repeat(32)
  const roomProof = 'b2'.repeat(32)

  rememberMemberName('Ada Lovelace')
  rememberSeat({ id: refusedId, proof: refusedProof })
  assert.deepEqual(memberIdentity(), { id: refusedId, name: 'Ada Lovelace', proof: refusedProof })

  // A room that refused that row seats the connection as a fresh member and
  // sends its id with the new row's proof in the `welcome`. The record adopts
  // both in one write, and keeps the name it already had.
  const seated = rememberSeat({ id: roomId, proof: roomProof })
  assert.deepEqual(
    memberIdentity(),
    { id: roomId, name: 'Ada Lovelace', proof: roomProof },
    'the stored id follows the seat the room gave, with that seat\'s own proof',
  )

  // The same seat again changes nothing, so no write happens for nothing.
  assert.equal(
    rememberSeat({ id: roomId, proof: roomProof }),
    seated,
    'a welcome that agrees with the record returns the record itself',
  )

  // A `welcome` with no proof must not drop the stored one while the id matches.
  const quiet = rememberSeat({ id: roomId, proof: null })
  assert.equal(quiet, seated, 'a welcome with no proof changes nothing')
  assert.equal(quiet.proof, roomProof, 'the stored proof of the matching id survives')
})

test('T148: an absent, empty or malformed record is no identity at all', () => {
  assert.equal(decodeIdentity(null), null)
  assert.equal(decodeIdentity(''), null)
  assert.equal(decodeIdentity('not json'), null)
  assert.equal(decodeIdentity('"a string"'), null)
  assert.equal(decodeIdentity('{"name":"Ada"}'), null, 'an id is the record')
  assert.equal(decodeIdentity('{"id":"   "}'), null)
  assert.deepEqual(decodeIdentity('{"id":"abc"}'), { id: 'abc', name: null })
})

test('T148: a minted member id is a distinct UUID v4 each time', () => {
  const first = mintMemberId()
  const second = mintMemberId()
  assert.match(first, UUID_V4)
  assert.match(second, UUID_V4)
  assert.notEqual(first, second)
})
