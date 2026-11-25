/**
 * T165 / ADR-053: a seat is proved, not quoted.
 *
 * The row half of the one-seat rule lives in `room.ts`. These cases pin the
 * three answers a `hello` naming a row can get - the proof it was issued, a
 * proof that is not this seat's, or none at all - and the fact that the proof
 * never reaches another member's frames.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createRoom, joinRoom, snapshot, wireMembers, type RoomState } from '../../src/server/room.ts'
import type { Member } from '../../src/shared/protocol.ts'

function member(id: string, name: string, joinedAt: number): Member {
  return {
    id,
    name,
    joinedAt,
    transport: 'app',
    status: 'online',
    lastSeen: joinedAt,
    rtt: 0,
    timelineOffset: 0,
    source: null,
    driftStrikes: 0,
    ready: false,
    address: null,
  }
}

/** The room's owner, seated the way the host's own window is (loopback). */
function roomWithOwner(id = 'ada'): { room: RoomState; proof: string } {
  const room = createRoom('SEAT01')
  const first = joinRoom(room, member(id, 'Ada', 1), { isLocal: true })
  assert.equal(first.ok, true)
  if (!first.ok) throw new Error('the owner join was refused')
  return { room, proof: first.proof }
}

test('T165: a join presenting the proof the row was issued re-seats that row and keeps the proof', () => {
  const { room, proof } = roomWithOwner()
  assert.equal(proof.length > 0, true, 'the first join issued a proof')

  const again = joinRoom(room, member('ada', 'Ada', 9), { isLocal: false, proof })

  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.equal(again.member, room.members.get('ada'), 'the same row object, not a second one')
  assert.equal(again.proof, proof, 'the seat keeps the proof it was issued')
  assert.equal(room.members.size, 1, 'one row for one person')
  assert.equal(again.member.name, 'Ada', 'the name the row already had')
  assert.equal(again.member.joinedAt, 1, 'and its join time')
  assert.deepEqual(room.controllers, ['ada'], 'control did not move')
  assert.equal(again.seatClaimRefused, false, 'a proved claim is not a refused one')
})

test('T165: a join naming a row with no proof is a fresh person, never that row', () => {
  const { room } = roomWithOwner()

  const quoted = joinRoom(room, member('ada', 'Quoted', 9), { isLocal: false })

  assert.equal(quoted.ok, true)
  if (!quoted.ok) return
  assert.notEqual(quoted.member.id, 'ada', 'the quoting connection is not Ada')
  assert.equal(room.members.size, 2, 'it made a row of its own')
  assert.equal(room.owner, 'ada', 'the owner seat did not move')
  assert.deepEqual(room.controllers, ['ada'], 'and control stayed with the owner')
  assert.equal(quoted.seatClaimRefused, true, 'the room says the claim was refused')
  assert.notEqual(quoted.proof, room.seatProofs.get('ada'), 'the fresh row has its own proof')
})

test('T165: a proof issued for one seat never takes another', () => {
  const { room, proof } = roomWithOwner()
  const bea = joinRoom(room, member('bea', 'Bea', 2), { isLocal: false })
  assert.equal(bea.ok, true)
  if (!bea.ok) return

  const crossed = joinRoom(room, member('bea', 'Crossed', 3), { isLocal: false, proof })

  assert.equal(crossed.ok, true)
  if (!crossed.ok) return
  assert.notEqual(crossed.member.id, 'bea', 'Ada\u2019s proof is not Bea\u2019s seat')
  assert.equal(room.members.get('bea')?.name, 'Bea', 'Bea\u2019s row is untouched')
  assert.equal(room.members.size, 3, 'a third row, never a takeover')
  assert.equal(crossed.seatClaimRefused, true)
})

test('T165: the proof appears in no member list and no room snapshot', () => {
  const { room, proof } = roomWithOwner()
  joinRoom(room, member('bea', 'Bea', 2), { isLocal: false })

  const wire = JSON.stringify({ room: snapshot(room), members: wireMembers(room) })
  assert.equal(wire.includes(proof), false, 'no proof rides `welcome` or `members`')
  for (const row of wireMembers(room)) {
    assert.equal(Object.keys(row).includes('proof'), false, 'a member row has no proof field')
  }
  assert.equal(Object.keys(snapshot(room)).includes('proof'), false, 'nor does the snapshot')
})
