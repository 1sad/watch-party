import test from 'node:test'
import assert from 'node:assert/strict'

import { PORT_LINE_PREFIX, portLine } from '../../src/shared/port.ts'

test('the port line the host parses is "PORT <digits>" and nothing else', () => {
  assert.equal(PORT_LINE_PREFIX, 'PORT ')
  assert.equal(portLine(1), 'PORT 1')
  assert.equal(portLine(43117), 'PORT 43117')
  assert.equal(portLine(65535), 'PORT 65535')
  assert.match(portLine(8080), /^PORT [1-9][0-9]{0,4}$/)
})

test('a value that is not a usable port is refused rather than printed', () => {
  for (const bad of [0, -1, 65536, 5173.5, Number.NaN]) {
    assert.throws(() => portLine(bad), RangeError)
  }
})
