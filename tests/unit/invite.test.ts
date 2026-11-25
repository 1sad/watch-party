import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInviteLinks } from '../../src/server/invite.ts'
import { parseJoinLink } from '../../src/ui/join.ts'

// T177 / R51: one room code, two first-class invitations. The app form is
// checked through the app's own link parser, so "opens a window with host, port
// and code" is the claim the app itself makes of it.
test('one code has both invitations: the app link and the plain browser address', () => {
  const links = buildInviteLinks({
    kind: 'ok',
    externalIp: '203.0.113.9',
    mappedPort: 62000,
    lanIp: '192.168.10.44',
    localPort: 52341,
    code: 'ABC234',
  })
  assert.ok(links)

  // The app form: a watchparty:// link the app parses into a window's target.
  const app = parseJoinLink(links.primary)
  assert.ok(app, 'the app form is a link the app can open')
  assert.equal(app.host, '203.0.113.9')
  assert.equal(app.port, 62000)
  assert.equal(app.code, 'ABC234')

  // The plain form: an http:// address a browser can open, same code.
  const plain = new URL(links.raw)
  assert.equal(plain.protocol, 'http:')
  assert.equal(plain.hostname, '203.0.113.9')
  assert.equal(plain.port, '62000')
  assert.equal(plain.pathname, '/join')
  assert.equal(plain.searchParams.get('c'), 'ABC234')
  assert.ok(links.raw.endsWith('/join?c=ABC234'), 'the browser address ends in the code')
})

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
