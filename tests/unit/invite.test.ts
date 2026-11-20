import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInviteLinks } from '../../src/server/invite.ts'

test('a cgnat verdict copies the same-network link, which carries the LAN address', () => {
  const links = buildInviteLinks({
    kind: 'cgnat',
    externalIp: '10.0.33.122',
    mappedPort: 52341,
    lanIp: '192.168.10.44',
    localPort: 52341,
    code: 'ABC234',
  })

  assert.ok(links)
  assert.equal(links.primary, 'watchparty://join?h=192.168.10.44&p=52341&c=ABC234')
  assert.equal(links.raw, 'http://192.168.10.44:52341/join?c=ABC234')
  assert.equal(links.lanRaw, links.raw)
})

test('an ok verdict points at the public address and mapped port', () => {
  const links = buildInviteLinks({
    kind: 'ok',
    externalIp: '203.0.113.9',
    mappedPort: 62000,
    lanIp: '192.168.10.44',
    localPort: 52341,
    code: 'ABC234',
  })

  assert.ok(links)
  assert.equal(links.primary, 'watchparty://join?h=203.0.113.9&p=62000&c=ABC234')
  assert.equal(links.raw, 'http://203.0.113.9:62000/join?c=ABC234')
  assert.equal(links.lanRaw, 'http://192.168.10.44:52341/join?c=ABC234')
})

test('without a LAN address there is no dishonest link', () => {
  assert.equal(
    buildInviteLinks({ kind: 'upnp_unavailable', mappedPort: null, lanIp: null, localPort: 52341, code: 'ABC234' }),
    null,
  )
})
