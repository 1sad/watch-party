import test from 'node:test'
import assert from 'node:assert/strict'

import { ECHO_EXPIRY_MS, createEchoSet } from '../../src/shared/echo.ts'

// §6.6's set, on its own: the player puts one entry in before it calls
// `play()`, `pause()` or sets `currentTime`, and the event those calls cause is
// consumed instead of becoming a command. Without the expiry, one dropped event
// would silence the next real one; without consume-once, two identical events
// would both pass.

test('an expected event is consumed once and only once', () => {
  const echoes = createEchoSet()
  echoes.expect('pause', 1000)

  assert.equal(echoes.consume('pause', 1001), true, 'the programmatic pause is ours')
  assert.equal(echoes.consume('pause', 1002), false, 'the second pause is somebody else’s')
})

test('a matching event of another kind is not consumed', () => {
  const echoes = createEchoSet()
  echoes.expect('play', 0)
  assert.equal(echoes.consume('pause', 10), false)
  assert.equal(echoes.consume('play', 20), true)
})

test('an entry expires after ECHO_EXPIRY_MS, so a dropped event cannot silence the next one', () => {
  const echoes = createEchoSet()
  echoes.expect('seeked', 0)

  assert.equal(echoes.consume('seeked', ECHO_EXPIRY_MS), false, 'the window is closed at the boundary')
  assert.equal(echoes.consume('seeked', ECHO_EXPIRY_MS + 1), false)
})

test('each call to play or pause is its own entry: two of ours, two consumed', () => {
  const echoes = createEchoSet()
  echoes.expect('play', 0)
  echoes.expect('play', 5)

  assert.equal(echoes.consume('play', 10), true)
  assert.equal(echoes.consume('play', 11), true)
  assert.equal(echoes.consume('play', 12), false)
})
