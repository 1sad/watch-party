import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyAddress, classifyMapping } from '../../src/server/discovery.ts'
import type { MappingOutcome } from '../../src/server/discovery.ts'

function mapped(externalIp: string): MappingOutcome {
  return { type: 'mapped', externalIp, mappedPort: 52341, detail: 'router said so' }
}

test('10.0.33.122 → cgnat: a private "public" address is E1\'s diagnosis', () => {
  assert.equal(classifyAddress('10.0.33.122'), 'private')
  const verdict = classifyMapping(mapped('10.0.33.122'))
  assert.equal(verdict.kind, 'cgnat')
  assert.equal(verdict.addressClass, 'private')
})

test('100.64.1.5 → cgnat: the carrier-grade range is shared by definition', () => {
  assert.equal(classifyAddress('100.64.1.5'), 'cgnat')
  assert.equal(classifyMapping(mapped('100.64.1.5')).kind, 'cgnat')
})

test('192.168.1.9 → cgnat: a home-router address is not reachable from outside', () => {
  assert.equal(classifyAddress('192.168.1.9'), 'private')
  assert.equal(classifyMapping(mapped('192.168.1.9')).kind, 'cgnat')
})

test('203.0.113.9 → ok: a public address can accept visitors', () => {
  assert.equal(classifyAddress('203.0.113.9'), 'public')
  assert.equal(classifyMapping(mapped('203.0.113.9')).kind, 'ok')
})

test('a refusal → upnp_unavailable', () => {
  const verdict = classifyMapping({ type: 'refused', detail: 'no router answered UPnP' })
  assert.equal(verdict.kind, 'upnp_unavailable')
  assert.equal(verdict.addressClass, 'unknown')
})

test('an 8-second silence → timeout, not a crasher', () => {
  const verdict = classifyMapping({ type: 'timeout', detail: 'the router did not answer within 8 seconds' })
  assert.equal(verdict.kind, 'timeout')
  assert.equal(verdict.addressClass, 'unknown')
})

test('172.16/12 is private too, and 172.32 is not', () => {
  assert.equal(classifyAddress('172.16.0.1'), 'private')
  assert.equal(classifyAddress('172.31.255.254'), 'private')
  assert.equal(classifyAddress('172.32.0.1'), 'public')
})
