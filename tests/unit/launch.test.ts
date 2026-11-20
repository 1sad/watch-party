import test from 'node:test'
import assert from 'node:assert/strict'

import { INVITE_SCHEME, isInviteLink, pageUrl } from '../../src/shared/launch.ts'

const PAGE = 'http://127.0.0.1:43117/'
const INVITE = 'watchparty://join?h=192.168.1.20&p=43117&c=K3M9QR'

test('a launched invite link becomes one ?join= value on the page URL', () => {
  assert.equal(INVITE_SCHEME, 'watchparty:')
  assert.equal(
    pageUrl(PAGE, [INVITE]),
    `${PAGE}?join=${encodeURIComponent(INVITE)}`,
  )
})

test('the page gets the whole link back, percent-encoded, and nothing else', () => {
  const url = new URL(pageUrl(PAGE, [INVITE]))

  assert.equal(url.pathname, '/')
  assert.equal(url.searchParams.get('join'), INVITE)
  assert.deepEqual([...url.searchParams.keys()], ['join'])
  // `h`, `p` and `c` are the join box's to read, never the host's (T3b).
  for (const key of ['h', 'p', 'c']) assert.equal(url.searchParams.get(key), null)
})

test('no invite argument means the plain page URL', () => {
  assert.equal(pageUrl(PAGE, []), PAGE)
  assert.equal(pageUrl(PAGE, ['--foo']), PAGE)
  assert.equal(pageUrl(PAGE, ['--foo', 'C:\\tmp\\invite.txt', '']), PAGE)
})

test('a malformed link is ignored rather than crashing', () => {
  for (const bad of ['watchparty join?h=1.2.3.4&p=43117&c=K3M9QR', 'join?h=1', '']) {
    assert.equal(isInviteLink(bad), false)
    assert.equal(pageUrl(PAGE, [bad]), PAGE)
  }
})

test('someone else\'s scheme and a later good link: the first invite wins', () => {
  assert.equal(pageUrl(PAGE, ['https://example.com/join?c=K3M9QR']), PAGE)
  assert.equal(
    pageUrl(PAGE, ['--foo', INVITE, 'watchparty://join?h=10.0.0.2&p=1&c=ZZZZZZ']),
    `${PAGE}?join=${encodeURIComponent(INVITE)}`,
  )
})
