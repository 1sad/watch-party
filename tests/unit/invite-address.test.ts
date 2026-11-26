/**
 * T185 / R51 as amended, ADR-056: the room has one invitation, and every screen
 * prints the room's address.
 *
 * The three screens learn the room's address from three different places
 * (`ui/invite-address.ts`): the owner's own `/discovery` answer, the origin an
 * app guest dialled, and the origin of the page a browser guest was served. For
 * one room they must all name that room - never the guest window's own sidecar
 * port, which a friend could reach but which would lead to an empty room.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { invitationAddress } from '../../src/ui/invite-address.ts'
import { COPY_REFUSED, copyTextToClipboard } from '../../src/ui/clipboard.ts'

test('one room prints the same address on the front door and on both guests bars', () => {
  const room = 'http://192.168.10.44:51390'
  const code = 'K3M9QR'

  const frontDoor = invitationAddress({
    surface: 'front-door',
    code,
    ownAddress: `${room}/join?c=${code}`,
    roomOrigin: null,
    pageOrigin: null,
  })
  const appGuest = invitationAddress({
    surface: 'app-guest',
    code,
    ownAddress: null,
    roomOrigin: room,
    pageOrigin: null,
  })
  const browserGuest = invitationAddress({
    surface: 'browser-guest',
    code,
    ownAddress: null,
    roomOrigin: null,
    pageOrigin: room,
  })

  assert.equal(frontDoor, `${room}/join?c=${code}`)
  assert.equal(appGuest, frontDoor, 'the front door and an app guest print one address')
  assert.equal(browserGuest, frontDoor, 'the browser guest prints the same address')
})

test('an app guest prints the room it joined, never its own sidecar port', () => {
  // Ticket 183's evidence picture: the guest's page was served from its own
  // loopback sidecar on 56313 while the room ran on 51390. A friend sent the
  // guest's own port would reach the guest's empty room.
  const address = invitationAddress({
    surface: 'app-guest',
    code: 'K3M9QR',
    ownAddress: null,
    roomOrigin: 'http://192.168.10.44:51390',
    pageOrigin: 'http://127.0.0.1:56313',
  })
  assert.equal(address, 'http://192.168.10.44:51390/join?c=K3M9QR')
  assert.doesNotMatch(address ?? '', /56313/)
})

test('a refused copy makes the button report the refusal and never show the copied state', async () => {
  const address = 'http://192.168.10.44:51390/join?c=K3M9QR'
  const refused = {
    writeText: async (): Promise<void> => {
      throw new Error('NotAllowedError')
    },
  }

  // A missing API and a refused write are the same outcome to the page.
  for (const api of [null, refused]) {
    const result = await copyTextToClipboard(address, api)
    assert.equal(result.copied, false, 'nothing was copied, so the button may not say "Copied"')
    assert.equal(result.notice, COPY_REFUSED)
    // `App.svelte` draws `{copied ? 'Copied' : 'Invite'}`, so the words stay its own.
    assert.equal(result.copied ? 'Copied' : 'Invite', 'Invite')
  }
})
