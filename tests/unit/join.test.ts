import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInviteLinks } from '../../src/server/invite.ts'
import { parseJoinLink, readJoinLink } from '../../src/ui/join.ts'

// T3b: the join box accepts either link form (item 1) and refuses anything else
// with one sentence. `bad_room` is not decided here — that is the room's answer.

test('the watchparty form parses to the same socket as the raw HTTP form', () => {
  const custom = parseJoinLink('watchparty://join?h=192.168.1.20&p=51234&c=ABC234')
  const plain = parseJoinLink('http://192.168.1.20:51234/join?c=ABC234')

  assert.deepEqual(custom, {
    host: '192.168.1.20',
    port: 51234,
    code: 'ABC234',
    socketUrl: 'ws://192.168.1.20:51234/',
  })
  assert.deepEqual(plain, custom)
})

test('a pasted link survives the whitespace a copy and paste adds', () => {
  const target = parseJoinLink('  watchparty://join?h=192.168.1.20&p=51234&c=ABC234\n')
  assert.equal(target?.socketUrl, 'ws://192.168.1.20:51234/')
})

test('the code is upper-cased, because the alphabet has no lower case', () => {
  assert.equal(parseJoinLink('http://192.168.1.20:51234/join?c=abc234')?.code, 'ABC234')
})

test('anything that is not one of the two forms is refused, not guessed at', () => {
  const refused = [
    '',
    '   ',
    'hello',
    'ABC234',
    '192.168.1.20:51234',
    'https://192.168.1.20:51234/join?c=ABC234',
    'ftp://192.168.1.20:51234/join?c=ABC234',
    // code alphabet has no I, O, 0 or 1 (§4.1), and it is six characters
    'watchparty://join?h=192.168.1.20&p=51234&c=ABCI23',
    'watchparty://join?h=192.168.1.20&p=51234&c=ABC23',
    // a port that cannot be dialled
    'watchparty://join?h=192.168.1.20&p=0&c=ABC234',
    'watchparty://join?h=192.168.1.20&p=70000&c=ABC234',
    'watchparty://join?h=192.168.1.20&p=abc&c=ABC234',
    // no code at all
    'watchparty://join?h=192.168.1.20&p=51234',
    'http://192.168.1.20:51234/join',
    // no host: the custom form keeps it in `h`, never in the address
    'watchparty://join?p=51234&c=ABC234',
    // a host is not a sentence
    'watchparty://join?h=not a host&p=51234&c=ABC234',
  ]

  for (const text of refused) {
    assert.equal(parseJoinLink(text), null, `expected a refusal for ${JSON.stringify(text)}`)
  }
})

test('a DNS name and an http URL with a path both parse', () => {
  assert.equal(parseJoinLink('http://sam-pc:51234/join?c=ABC234')?.socketUrl, 'ws://sam-pc:51234/')
  assert.equal(
    parseJoinLink('watchparty://join?h=watch.example.net&p=80&c=ABC234')?.socketUrl,
    'ws://watch.example.net:80/',
  )
})

// T183 / R57, ADR-054: one room, two shapes of the same three facts. The
// composer's own two outputs are read back through the box's own reader, so this
// is the address the invite bar really prints and the link it really copies -
// not a hand-written pair that could agree with itself and not with the app.
test("one room's plain address and its app form parse to the same host, port and code, and lead to the same join", () => {
  const links = buildInviteLinks({
    kind: 'cgnat',
    externalIp: '10.0.33.122',
    mappedPort: 52341,
    lanIp: '192.168.10.44',
    localPort: 52341,
    code: 'ABC234',
  })
  assert.ok(links)

  const app = readJoinLink(links.primary)
  const plain = readJoinLink(links.raw)
  if (app.kind !== 'target' || plain.kind !== 'target') {
    assert.fail(`both forms must be a join target: app=${app.kind} plain=${plain.kind}`)
  }

  assert.equal(app.target.host, '192.168.10.44')
  assert.equal(app.target.port, 52341)
  assert.equal(app.target.code, 'ABC234')
  // The join itself: one socket URL, so the two shapes cannot dial two rooms.
  assert.equal(app.target.socketUrl, 'ws://192.168.10.44:52341/')
  assert.deepEqual(plain.target, app.target)
})

// T183 / R57: a paste the box cannot read is refused in words, one shape at a
// time. The sentence is quoted as a person reads it - not the constant - so a
// later change to the wording has to come past this test.
test('a malformed address, an address with no code and a foreign scheme are each refused in words', () => {
  const refused: Array<[string, string]> = [
    ['http://192.168.1.20:99999/join?c=ABC234', 'a malformed address: a port that cannot be dialled'],
    ['http://192.168.1.20:51234/join', 'an address carrying no code'],
    ['https://192.168.1.20:51234/join?c=ABC234', 'a foreign scheme: not the app form, not a plain address'],
  ]

  for (const [text, what] of refused) {
    assert.deepEqual(
      readJoinLink(text),
      { kind: 'refused', sentence: 'That does not look like a Watch Party link.' },
      `expected the refusal sentence for ${what}: ${text}`,
    )
    assert.equal(parseJoinLink(text), null, `expected no target for ${what}: ${text}`)
  }
})
