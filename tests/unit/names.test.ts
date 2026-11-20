import test from 'node:test'
import assert from 'node:assert/strict'

import { ANONYMOUS, displayNames, normalizeName } from '../../src/shared/names.ts'

// §4.1 (`name: string | null`) and R26: the naming rule, tested where it lives,
// because both the roster and the sidecar call it.

test('a blank or absent name is null, which renders as anonymous', () => {
  assert.equal(normalizeName(undefined), null)
  assert.equal(normalizeName(null), null)
  assert.equal(normalizeName(''), null)
  assert.equal(normalizeName('   '), null)
  assert.equal(normalizeName('\t\n'), null)
  assert.equal(normalizeName(42), null)
  assert.equal(ANONYMOUS, 'anonymous')

  const labels = displayNames([{ id: 'a', name: null, joinedAt: 1 }])
  assert.equal(labels.get('a'), 'anonymous')
})

test('the second member called sam is "sam (2)", the third "sam (3)"', () => {
  const labels = displayNames([
    { id: 'a', name: 'sam', joinedAt: 1 },
    { id: 'b', name: 'sam', joinedAt: 2 },
    { id: 'c', name: ' sam ', joinedAt: 3 }, // trimmed, so the same name
    { id: 'd', name: 'alex', joinedAt: 4 },
  ])

  assert.equal(labels.get('a'), 'sam')
  assert.equal(labels.get('b'), 'sam (2)')
  assert.equal(labels.get('c'), 'sam (3)')
  assert.equal(labels.get('d'), 'alex')
})

test('renaming to null clears back to anonymous and frees the suffix', () => {
  const members = [
    { id: 'a', name: 'sam', joinedAt: 1 },
    { id: 'b', name: 'sam', joinedAt: 2 },
  ]
  assert.equal(displayNames(members).get('b'), 'sam (2)')

  // The first sam clears: the second is plain "sam" again, with nothing to undo.
  members[0].name = null
  const afterClear = displayNames(members)
  assert.equal(afterClear.get('a'), 'anonymous')
  assert.equal(afterClear.get('b'), 'sam')

  // Both clear: anonymous rows disambiguate by the same rule as any other name.
  members[1].name = null
  const bothClear = displayNames(members)
  assert.equal(bothClear.get('a'), 'anonymous')
  assert.equal(bothClear.get('b'), 'anonymous (2)')
})

test('labels are computed in join order, so every replica agrees', () => {
  const listedBackwards = [
    { id: 'b', name: 'sam', joinedAt: 20 },
    { id: 'a', name: 'sam', joinedAt: 10 },
  ]
  assert.equal(displayNames(listedBackwards).get('a'), 'sam')
  assert.equal(displayNames(listedBackwards).get('b'), 'sam (2)')
})
