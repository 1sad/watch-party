import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEDIA_CONTENT_TYPES,
  contentTypeFor,
  parseRange,
  type ByteRange,
} from '../../src/shared/media.ts'

test('ADR-035: exactly four extensions, and the type each one is served as', () => {
  assert.deepEqual(Object.keys(MEDIA_CONTENT_TYPES).sort(), ['m4v', 'mov', 'mp4', 'webm'])

  const rows: Array<[string, string | null]> = [
    ['clip.mp4', 'video/mp4'],
    ['SHORT.MP4', 'video/mp4'],
    ['C:\\Users\\sam\\Videos\\film.m4v', 'video/x-m4v'],
    ['/home/sam/some.show.S01E02.webm', 'video/webm'],
    ['trailer.mov', 'video/quicktime'],
    ['film.mkv', null],
    ['no-extension', null],
    ['.mp4', null],
  ]

  for (const [path, expected] of rows) {
    assert.equal(contentTypeFor(path), expected, `content type for ${path}`)
  }
})

test('a Range header answers with one of the three outcomes, one row per case', () => {
  const rows: Array<[string | undefined, number, ByteRange, string]> = [
    ['bytes=0-', 1000, { kind: 'range', start: 0, end: 999 }, 'from a keyframe to the end'],
    ['bytes=100-200', 1000, { kind: 'range', start: 100, end: 200 }, 'a closed range'],
    ['bytes=-500', 1000, { kind: 'range', start: 500, end: 999 }, 'the tail, suffix form'],
    ['bytes=-5000', 1000, { kind: 'range', start: 0, end: 999 }, 'a suffix longer than the file'],
    ['bytes=0-0', 1, { kind: 'range', start: 0, end: 0 }, 'one byte out of one'],
    ['bytes=900-2000', 1000, { kind: 'range', start: 900, end: 999 }, 'an end past the file clamps'],
    [undefined, 1000, { kind: 'whole' }, 'no header'],
    ['bytes=abc', 1000, { kind: 'whole' }, 'unparseable'],
    ['bytes=-', 1000, { kind: 'whole' }, 'neither end given'],
    ['bytes=0-1,5-6', 1000, { kind: 'whole' }, 'multi-range is not answered'],
    ['bytes=1000-', 1000, { kind: 'unsatisfiable', size: 1000 }, 'start at the end'],
    ['bytes=2000-3000', 1000, { kind: 'unsatisfiable', size: 1000 }, 'entirely past the end'],
    ['bytes=500-400', 1000, { kind: 'unsatisfiable', size: 1000 }, 'an end before its start'],
    ['bytes=-0', 1000, { kind: 'unsatisfiable', size: 1000 }, 'a zero-length suffix'],
    ['bytes=0-', 0, { kind: 'unsatisfiable', size: 0 }, 'an empty file'],
  ]

  for (const [header, size, expected, label] of rows) {
    assert.deepEqual(parseRange(header, size), expected, label)
  }
})
