/**
 * File mode's two pure decisions (T9a1): which four extensions count as
 * playable (ADR-035), and what one `Range:` header means for a file of a known
 * size. Both are shared because the page will show the picker's refusals and
 * the sidecar serves the bytes, and neither may derive its own answer.
 *
 * No `node:path` here: this module is imported by the page too.
 */

/**
 * ADR-035: a four-entry map instead of a `mime` package. Keys are extensions
 * without the dot, lower-case. Anything else is refused when it is picked, so
 * the sidecar never guesses a type it does not know how to play.
 */
export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

/** The last segment of a path, which is the name the room shows and a refusal quotes. */
export function mediaTitle(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
}

/** The content type for a file path, or `null` when file mode cannot play it. */
export function contentTypeFor(filePath: string): string | null {
  const name = mediaTitle(filePath)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return MEDIA_CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null
}

/** Letters whose written names begin with a vowel sound; `an MKV`, `a WEBM`. */
const AN_LETTERS = 'AEFHILMNORSX'

function article(word: string): string {
  return AN_LETTERS.includes(word.charAt(0).toUpperCase()) ? 'an' : 'a'
}

/**
 * T9a2's first check, at pick time: the extension against ADR-035's four
 * (`§7.2`'s refusal rule). One answer, so the page has no second copy of the
 * judgement — the type it will ask the host to serve, or the sentence.
 */
export type ExtensionCheck =
  | { playable: true; contentType: string }
  | { playable: false; refusal: string }

export function checkExtension(filePath: string): ExtensionCheck {
  const contentType = contentTypeFor(filePath)
  if (contentType !== null) return { playable: true, contentType }
  return { playable: false, refusal: refusalSentence(filePath) }
}

/** One sentence that names the file and the reason, or `null` for a type file mode plays. */
export function extensionRefusal(filePath: string): string | null {
  const check = checkExtension(filePath)
  return check.playable ? null : check.refusal
}

function refusalSentence(filePath: string): string {
  const name = mediaTitle(filePath)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : null
  const what =
    extension === null
      ? 'has no file type this app can play'
      : `is ${article(extension)} ${extension.toUpperCase()} file`
  return `${name} ${what}, and the app's browser cannot play it — file mode plays MP4, M4V, WebM and MOV files only.`
}

/** How long the owner's page waits for `loadedmetadata` before refusing (T9a2). */
export const MEASURE_TIMEOUT_MS = 10_000

/** Why the page's load check failed, after the extension check passed. */
export type LoadRefusal = 'error' | 'no-duration' | 'timeout'

/**
 * T9a2's second check: the file passed the extension check but the page could
 * not play it. Named, reasoned, one sentence, and true about the room — nothing
 * was sent, so it is still on what it had.
 */
export function loadRefusal(filePath: string, outcome: LoadRefusal): string {
  const name = mediaTitle(filePath)
  switch (outcome) {
    case 'error':
      return `${name} is one of the four file types, but the app's browser could not read it, so the room is still on what it had.`
    case 'no-duration':
      return `${name} reports no length, so the app's browser cannot play it and the room is still on what it had.`
    case 'timeout':
      return `${name} did not load within ${MEASURE_TIMEOUT_MS / 1000} seconds, so the room is still on what it had.`
  }
}

/**
 * What to do with one `Range:` header:
 * - `whole`: no header, or one this sidecar cannot read — serve all of it, 200.
 *   A browser that asked for a range and gets 200 seeks by downloading, which
 *   is slow but correct; refusing would be worse.
 * - `range`: a satisfiable byte range, inclusive.
 * - `unsatisfiable`: a range asking past the end (or an empty file), 416 with
 *   a Content-Range reporting the size. The size travels with the answer so
 *   the header has one place to be computed.
 */
export type ByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable'; size: number }
  | { kind: 'whole' }

/**
 * `bytes=0-`, `bytes=100-200` and the suffix form `bytes=-500` (the tail).
 * A multi-range request is not something a `<video>` element sends and this
 * sidecar will not answer it: it falls back to the whole file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return { kind: 'whole' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return { kind: 'whole' }

  const [, rawStart, rawEnd] = match
  // `bytes=-` names neither end: nothing to honour.
  if (rawStart === '' && rawEnd === '') return { kind: 'whole' }
  if (size === 0) return { kind: 'unsatisfiable', size }

  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix === 0) return { kind: 'unsatisfiable', size }
    // A suffix longer than the file is the whole file (RFC 9110 §14.2).
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable', size }
  if (rawEnd === '') return { kind: 'range', start, end: size - 1 }

  const end = Number(rawEnd)
  if (!Number.isFinite(end) || end < start) return { kind: 'unsatisfiable', size }
  return { kind: 'range', start, end: Math.min(end, size - 1) }
}
