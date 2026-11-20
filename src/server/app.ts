import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export interface SidecarOptions {
  /** The folder the page was built into (vite → dist/). */
  distDir: string
  /**
   * §5's fixture clip, served at `/fixture` until T9a swaps in a picked file.
   * One named path rather than a media folder: the page must not be able to ask
   * the sidecar for the contents of the disk.
   */
  fixture?: string
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
    await sendFixture(request, response, options.fixture, method)
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
 * The fixture clip, with byte ranges because a `<video>` seeks by asking for a
 * byte range starting at a keyframe. Without `206` the browser has to download
 * the whole file before `currentTime = 30` can land, which would make T6b's
 * seek checks measure the disk rather than the player.
 *
 * `no-store` keeps a window's reload from trusting a stale body after the
 * fixture is regenerated.
 */
async function sendFixture(
  request: IncomingMessage,
  response: ServerResponse,
  fixture: string | undefined,
  method: string,
): Promise<void> {
  if (fixture === undefined) {
    sendText(response, 404, 'no fixture\n', method)
    return
  }

  let size: number
  try {
    size = (await stat(fixture)).size
  } catch {
    sendText(response, 404, 'no fixture\n', method)
    return
  }

  const headers: Record<string, string | number> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }

  const range = parseByteRange(request.headers.range, size)
  if (range === 'invalid') {
    response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    response.end()
    return
  }

  if (range === null) {
    response.writeHead(200, { ...headers, 'content-length': size })
    if (method === 'HEAD') response.end()
    else createReadStream(fixture).pipe(response)
    return
  }

  response.writeHead(206, {
    ...headers,
    'content-length': range.end - range.start + 1,
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
  })
  if (method === 'HEAD') response.end()
  else createReadStream(fixture, { start: range.start, end: range.end }).pipe(response)
}

/**
 * One `Range: bytes=` header in the two forms a media element sends:
 * `start-` (from a keyframe to the end) and `start-end`. A suffix range
 * (`-500`) is the tail and is not needed by the player, so it is refused as
 * invalid rather than half-implemented. Anything unreadable is `invalid`, never
 * "serve the whole thing": a browser that asked for a range and got 200 will
 * seek in the wrong place.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' || size === 0) return 'invalid'

  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start >= size || start > end) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}
