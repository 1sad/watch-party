import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { parseRange } from '../shared/media.ts'

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
  return createServer((request, response) => {
    void handle(request, response, distDir, options)
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  distDir: string,
  options: SidecarOptions,
): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

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
