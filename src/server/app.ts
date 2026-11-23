import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { parseRange } from '../shared/media.ts'
import { ADDRESS_BLOCK_MS, createRefusalBook, type RefusalBook } from './socket.ts'

/** The one file the room registered, as `/media/<id>` needs it. T9a1. */
export interface RegisteredMedia {
  id: string
  path: string
  contentType: string
}

export interface SidecarOptions {
  /** The folder the page was built into (vite → dist/). */
  distDir: string
  /**
   * T6b's clip, served at `/fixture` for `tests/integration/sidecar.test.ts`;
   * the page opens `/media/<id>` only. One named path rather than a media
   * folder: the page must not be able to ask the sidecar for the contents of
   * the disk.
   */
  fixture?: string
  /**
   * The room's one file (T9a1). `/media/<id>` serves this and only this: a URL
   * names an id, never a path, so a guest cannot read the owner's disk.
   */
  media?: () => RegisteredMedia | null
  /**
   * T05: the bridge the host injects into every frame of the site view, served
   * here so that the script the window runs and the script the tests read are
   * one file (ADR-038: "nothing of ours runs in it except one bridge script").
   */
  bridge?: string
  /** The sidecar's own log; one line per `/media/` request (T9a1 item 4). */
  log?: (line: string) => void
  /** What GET /healthz answers with; the page shows it. */
  version: string
  /**
   * The start screen's state, as the page asks for it (T2). The host never
   * reads this: discovery is sidecar code, and the page is the only consumer.
   */
  start?: () => unknown
  /** Runs one more mapping attempt; the page's "try again" button. */
  retryDiscovery?: () => void
  /**
   * T71: the refusal book, shared with the socket door so a wrong code costs
   * the same callers the same minute whichever door they knock on. `main.ts`
   * passes one instance to both; a test that does not pass one gets its own.
   */
  refusals?: RefusalBook
  /**
   * T71: who counts as this machine's own window, so the host's loopback page
   * is never billed for a refusal. Defaults to loopback; only a test overrides
   * it, because a test's caller always arrives from 127.0.0.1.
   */
  isLocal?: (remoteAddress: string | undefined) => boolean
}

/**
 * T64, ADR-044: the room code is the key, and these three routes hand it out
 * (`/discovery` carries `roomCode` and the whole invite link). Only the host's
 * own window may have them: it always loads the page from `127.0.0.1`
 * (`main.ts`), and a guest's page joins from the code in its own link instead
 * (`ui/App.svelte`). `/healthz` is here too because nothing outside this
 * machine needs the version.
 */
const HOST_ONLY_ROUTES = new Set(['/discovery', '/discovery/retry', '/healthz'])

/** Did this request come from this machine? The socket's own address, nothing the caller can claim. */
function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  const address = (remoteAddress ?? '').replace(/^::ffff:/, '')
  return address === '::1' || address.startsWith('127.')
}

/**
 * T68, ADR-044: the invite link is the key. A caller that reaches this port from
 * anywhere but this machine gets one gate page - no page, no bundle, no version,
 * no room - until it presents the room code. The invite link carries it the way
 * `invite.ts` builds it (`/join?c=<code>`), and that link answers with the app
 * plus this cookie, so the bundle and asset requests the page makes next carry
 * the key too. The host's own window loads from 127.0.0.1 and needs neither.
 */
const KEY_COOKIE = 'wp_key'
/** One evening: long enough for a party, and not a permanent credential. */
const KEY_COOKIE_MAX_AGE_S = 12 * 60 * 60

/**
 * The gate: one small self-contained page. It asks for the code and reveals
 * nothing else - no bundle reference, no version, no roster, no room state - and
 * its form's `c` is exactly the parameter the invite link and the page use.
 */
const GATE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch Party</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #eee; font: 16px system-ui, sans-serif; }
form { display: grid; gap: 0.75rem; padding: 2rem; border: 1px solid #444; border-radius: 0.5rem; background: #1a1a1a; }
h1 { margin: 0; font-size: 1.25rem; }
p { margin: 0; color: #aaa; }
label { font-size: 0.875rem; color: #aaa; }
input { font: inherit; padding: 0.5rem; border: 1px solid #555; border-radius: 0.25rem; background: #0b0b0b; color: #eee; text-transform: uppercase; }
button { font: inherit; padding: 0.5rem; border: 0; border-radius: 0.25rem; background: #3b82f6; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<form action="/join" method="get">
<h1>Watch Party</h1>
<p>Enter the room code from the link you were sent.</p>
<label for="c">Room code</label>
<input id="c" name="c" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
<button type="submit">Join</button>
</form>
</body>
</html>
`

/** The room's code, as `/discovery` already answers it; `null` before there is one. */
function roomCodeOf(options: SidecarOptions): string | null {
  const state: unknown = options.start?.()
  if (typeof state !== 'object' || state === null) return null
  const code = (state as { roomCode?: unknown }).roomCode
  return typeof code === 'string' && code.length > 0 ? code : null
}

/**
 * The two places a key can arrive: the query's `c`, and the cookie the invite
 * link set. The query is read on `/join` (the link itself) and on `/media/*`
 * (T85): a guest's page is served by its own sidecar, so its browser holds no
 * `wp_key` cookie for the owner's origin, and the media request is the only
 * place that page can bring the code - the same code, in the same parameter,
 * not a second credential.
 */
function presentedCode(
  request: IncomingMessage,
  url: URL,
): { link: string | null; cookie: string | null } {
  const carriesQuery = url.pathname === '/join' || url.pathname.startsWith('/media/')
  const raw = carriesQuery ? (url.searchParams.get('c') ?? '') : ''
  const link = raw.trim().toUpperCase()

  let cookie: string | null = null
  const header = request.headers.cookie
  if (typeof header === 'string') {
    for (const part of header.split(';')) {
      const equals = part.indexOf('=')
      if (equals < 0) continue
      if (part.slice(0, equals).trim() !== KEY_COOKIE) continue
      const value = part.slice(equals + 1).trim()
      try {
        cookie = decodeURIComponent(value)
      } catch {
        cookie = value
      }
      break
    }
  }

  return { link: link.length === 0 ? null : link, cookie }
}

/** The one answer an unauthorized caller gets: the gate, and nothing else. */
function sendGate(response: ServerResponse, method: string): void {
  response.writeHead(403, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(GATE_PAGE),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(method === 'HEAD' ? undefined : GATE_PAGE)
}

// A four-entry map instead of a `mime` package (ADR-035). Anything the page
// build does not emit is served as bytes rather than guessed at.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/**
 * The sidecar's single listener: it serves the page the window loads, and
 * answers /healthz with the version string. Nothing here knows about rooms.
 */
export function createSidecarServer(options: SidecarOptions): Server {
  const distDir = resolve(options.distDir)
  // One book per listener, shared with the socket when `main.ts` passes one in
  // (T71). Created once here, not per request.
  const refusals = options.refusals ?? createRefusalBook()
  return createServer((request, response) => {
    void handle(request, response, distDir, options, refusals)
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  distDir: string,
  options: SidecarOptions,
  refusals: RefusalBook,
): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  // T68, ADR-044: the port serves the app only to a caller that holds the key.
  // This machine's own window holds it by definition, and `/discovery` is what
  // hands it the code; anyone else must bring it in the link (`/join?c=`) or in
  // the cookie that link sets. This is the first and widest check: below it, the
  // rest of the file is the app as it was.
  const address = request.socket.remoteAddress ?? 'unknown'
  const isLocal = options.isLocal ?? isLoopbackAddress
  const loopback = isLocal(address)
  // T71: a barred address gets the gate page whatever it presents, the real
  // code included, until `ADDRESS_BLOCK_MS` has run out (ADR-044).
  if (!loopback && refusals.blocked(address)) {
    sendGate(response, method)
    return
  }
  const code = roomCodeOf(options)
  const presented = presentedCode(request, url)
  const fromLink = code !== null && presented.link === code
  const authorized = loopback || fromLink || (code !== null && presented.cookie === code)
  if (!authorized) {
    // T71: only a code that was actually presented is billed. A caller with no
    // code at all (`/`, or a `/join` with an empty one) gets the gate page for
    // free, and the host's own loopback window is never billed either.
    if (!loopback && (presented.link !== null || presented.cookie !== null)) {
      // The socket half of the book is meaningless for one HTTP request; the
      // address half is the shared one, and it is the limit a script cannot pay.
      const verdict = refusals.refuse(request, address)
      if (verdict.blockAddress) {
        options.log?.(
          `[gate] address refused for ${ADDRESS_BLOCK_MS / 1000}s ` +
            `refusals=${verdict.addressRefusals} addr=${address}`,
        )
      }
    }
    sendGate(response, method)
    return
  }

  // T64: a caller that is not this machine learns nothing from these routes -
  // no room code, no invite link, no version. 403 and one word, before anything
  // else looks at the request.
  if (HOST_ONLY_ROUTES.has(url.pathname) && !loopback) {
    sendText(response, 403, 'forbidden\n', method)
    return
  }

  if (url.pathname === '/discovery') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendMethodNotAllowed(response, 'GET, HEAD')
      return
    }
    sendJson(response, 200, options.start?.() ?? { status: 'pending' }, method)
    return
  }

  if (url.pathname === '/discovery/retry') {
    if (method !== 'POST') {
      sendMethodNotAllowed(response, 'POST')
      return
    }
    options.retryDiscovery?.()
    sendJson(response, 202, { status: 'pending' }, method)
    return
  }

  if (url.pathname === '/fixture') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendMethodNotAllowed(response, 'GET, HEAD')
      return
    }
    if (options.fixture === undefined) {
      sendText(response, 404, 'no fixture\n', method)
      return
    }
    await sendFile(request, response, { path: options.fixture, contentType: 'video/mp4' }, method)
    return
  }

  if (url.pathname === '/bridge.js') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendMethodNotAllowed(response, 'GET, HEAD')
      return
    }
    if (options.bridge === undefined) {
      sendText(response, 404, 'no bridge\n', method)
      return
    }
    await sendFile(request, response, { path: options.bridge, contentType: 'text/javascript; charset=utf-8' }, method)
    return
  }

  if (url.pathname.startsWith('/media/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendMethodNotAllowed(response, 'GET, HEAD')
      return
    }
    await sendMedia(request, response, url.pathname.slice('/media/'.length), options, method)
    return
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendMethodNotAllowed(response, 'GET, HEAD')
    return
  }

  if (url.pathname === '/healthz') {
    sendText(response, 200, options.version, method)
    return
  }

  // `/join?c=<code>` is the guest's door: it serves the same page, and the
  // page asks the sidecar which room that code is (T3 owns the room itself).
  const filePath =
    url.pathname === '/join'
      ? resolveStaticFile(distDir, '/')
      : resolveStaticFile(distDir, url.pathname)
  if (filePath === null) {
    sendText(response, 404, 'not found\n', method)
    return
  }


  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch {
    sendText(response, 404, 'not found\n', method)
    return
  }

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
    // T68: the link is the key, so following it leaves the key in this jar and
    // the page's own asset requests carry it. Only the link can set it.
    ...(fromLink
      ? {
          'set-cookie':
            `${KEY_COOKIE}=${encodeURIComponent(presented.link ?? '')}; ` +
            `Path=/; HttpOnly; SameSite=Lax; Max-Age=${KEY_COOKIE_MAX_AGE_S}`,
        }
      : {}),
  })
  response.end(method === 'HEAD' ? undefined : body)
}

/** Maps a URL path onto a file inside distDir, and refuses to leave distDir. */
export function resolveStaticFile(distDir: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  // A folder request ("/" or "/sub/") serves that folder's index.html.
  const wantsIndex = decoded.endsWith('/')
  const relative = decoded.replace(/^\/+/, '')
  const candidate = resolve(distDir, relative, wantsIndex ? 'index.html' : '')

  if (candidate !== distDir && !candidate.startsWith(distDir + sep)) return null
  return candidate
}

function sendText(response: ServerResponse, status: number, body: string, method: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(method === 'HEAD' ? undefined : body)
}

function sendJson(response: ServerResponse, status: number, value: unknown, method: string): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(method === 'HEAD' ? undefined : body)
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow })
  response.end('method not allowed\n')
}

/**
 * `/media/<id>`: the one file the room holds, and nothing else. The id is
 * looked up in the room's registration; a path never travels in a URL, so this
 * cannot be asked for a file nobody registered (T9a1's Safety line).
 *
 * One log line per request, whatever the answer: the file id, the status and
 * the range exactly as received. That is how a later run reads "206, not one
 * 200" without opening DevTools (T9a1 item 4).
 */
async function sendMedia(
  request: IncomingMessage,
  response: ServerResponse,
  rawId: string,
  options: SidecarOptions,
  method: string,
): Promise<void> {
  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    id = rawId
  }

  const rangeHeader = request.headers.range
  const media = options.media?.() ?? null
  if (media === null || media.id !== id) {
    options.log?.(`[media] id=${id} status=404 range=${rangeHeader ?? '-'}`)
    sendText(response, 404, 'not found\n', method)
    return
  }

  const status = await sendFile(request, response, media, method)
  options.log?.(`[media] id=${id} status=${status} range=${rangeHeader ?? '-'}`)
}

/**
 * One file, streamed, with byte ranges because a `<video>` seeks by asking for
 * a range starting at a keyframe. Without `206` the browser downloads the whole
 * file before `currentTime = 30` can land, which measures the disk rather than
 * the player. No temp copy, no cache, no whole-file read: `createReadStream`
 * on the registered path and nothing between it and the socket.
 *
 * The header's meaning is `parseRange()`'s (shared, table-tested); this
 * function only turns its three answers into the three statuses.
 */
async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: { path: string; contentType: string },
  method: string,
): Promise<number> {
  let size: number
  try {
    size = (await stat(file.path)).size
  } catch {
    sendText(response, 404, 'not found\n', method)
    return 404
  }

  const headers: Record<string, string | number> = {
    'content-type': file.contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }

  const range = parseRange(request.headers.range, size)
  if (range.kind === 'unsatisfiable') {
    response.writeHead(416, { ...headers, 'content-range': `bytes */${range.size}` })
    response.end()
    return 416
  }

  if (range.kind === 'whole') {
    response.writeHead(200, { ...headers, 'content-length': size })
    if (method === 'HEAD') response.end()
    else createReadStream(file.path).pipe(response)
    return 200
  }

  response.writeHead(206, {
    ...headers,
    'content-length': range.end - range.start + 1,
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
  })
  if (method === 'HEAD') response.end()
  else createReadStream(file.path, { start: range.start, end: range.end }).pipe(response)
  return 206
}
