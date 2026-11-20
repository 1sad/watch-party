import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export interface SidecarOptions {
  /** The folder the page was built into (vite → dist/). */
  distDir: string
  /** What GET /healthz answers with; the page shows it. */
  version: string
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
    void handle(request, response, distDir, options.version)
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  distDir: string,
  version: string,
): Promise<void> {
  const method = request.method ?? 'GET'

  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    response.end('method not allowed\n')
    return
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (url.pathname === '/healthz') {
    sendText(response, 200, version, method)
    return
  }

  const filePath = resolveStaticFile(distDir, url.pathname)
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
