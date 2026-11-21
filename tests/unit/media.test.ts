import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEDIA_CONTENT_TYPES,
  checkExtension,
  contentTypeFor,
  extensionRefusal,
  loadRefusal,
  mediaTitle,
  mediaUrl,
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

test('T9a2: an unplayable file is refused in one sentence naming it and the reason', () => {
  assert.equal(
    extensionRefusal('C:\\Users\\sam\\Videos\\Some Film.MKV'),
    "Some Film.MKV is an MKV file, and the app's browser cannot play it — file mode plays MP4, M4V, WebM and MOV files only.",
  )
  assert.equal(
    extensionRefusal('/home/sam/no-extension'),
    "no-extension has no file type this app can play, and the app's browser cannot play it — file mode plays MP4, M4V, WebM and MOV files only.",
  )

  // The four ADR-035 types pass the first check; the page's load check is next.
  for (const playable of ['a.mp4', 'b.M4V', 'c.webm', 'd.mov']) {
    assert.equal(extensionRefusal(playable), null, playable)
  }
})

test('T9a2: the page gets the type it must serve, or the refusal, from one call', () => {
  assert.deepEqual(checkExtension('C:\\Videos\\film.MP4'), { playable: true, contentType: 'video/mp4' })
  assert.deepEqual(checkExtension('C:\\Videos\\film.mkv'), {
    playable: false,
    refusal:
      "film.mkv is an MKV file, and the app's browser cannot play it — file mode plays MP4, M4V, WebM and MOV files only.",
  })
})

test('T9a2: the load check refuses with the file named and the room left alone', () => {
  const outcomes = ['error', 'no-duration', 'timeout'] as const
  for (const outcome of outcomes) {
    const sentence = loadRefusal('C:\\Videos\\half.mp4', outcome)
    assert.match(sentence, /^half\.mp4 /, outcome)
    assert.match(sentence, /the room is still on what it had\.$/, outcome)
  }
  assert.notEqual(loadRefusal('half.mp4', 'error'), loadRefusal('half.mp4', 'no-duration'))
  assert.notEqual(loadRefusal('half.mp4', 'error'), loadRefusal('half.mp4', 'timeout'))
})

test('T9a2: the room calls a file by its name, not by its path', () => {
  assert.equal(mediaTitle('C:\\Users\\sam\\Videos\\film.mp4'), 'film.mp4')
  assert.equal(mediaTitle('/home/sam/film.mp4'), 'film.mp4')
  assert.equal(mediaTitle('film.mp4'), 'film.mp4')
})

test('T9a3: every window fetches /media/<id> from the owner, not from itself', () => {
  // A guest loads the page from its own sidecar, which holds no file: a
  // relative `/media/<id>` would 404 there. The origin is the connection's.
  assert.equal(mediaUrl('http://192.168.1.5:51234', { id: 'f1' }), 'http://192.168.1.5:51234/media/f1')
  assert.equal(mediaUrl('http://127.0.0.1:51234/', { id: 'f1' }), 'http://127.0.0.1:51234/media/f1')
  assert.equal(mediaUrl('http://127.0.0.1:51234', { id: 'a b/c' }), 'http://127.0.0.1:51234/media/a%20b%2Fc')
  // No file: no source at all, so the player has nothing to load.
  assert.equal(mediaUrl('http://127.0.0.1:51234', null), null)
})
