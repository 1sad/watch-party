// Serves tests/fixtures/ -- the probe page and the fixture video beside it -- to
// a live check, and nothing else. Zero dependencies: node:http and node:fs.
//
//   node tests/fixtures/serve.ts [port]
//
// It prints the page's URL and stays up until stopped. Loopback only, on port
// 8123 unless a port is given. Range requests are answered 206 with
// Content-Range and exactly the bytes asked for: testing-manual.md section 7
// trap 3 is this trap, and a 200 with accept-ranges makes video.seekable read
// [0, 0], so every seek a check reads would land at 0.
import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_PORT = 8123

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
}

function typeOf(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * The byte range a `Range` header asks for, or null to send the whole file.
 * A malformed or unsatisfiable range is the word 'unsatisfiable'.
 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!match) return null
  const first = match[1]!
  const second = match[2]!
  if (first === '' && second === '') return 'unsatisfiable'

  let start: number
  let end: number
  if (first === '') {
    // `bytes=-500`: the last 500 bytes.
    const suffix = Number(second)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(first)
    end = second === '' ? size - 1 : Math.min(Number(second), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * The server for one directory. Exported so a test can bind port 0 and prove
 * the Range answers without a live check. `log` is how a live check tells the
 * page's own navigation (a request for `/probe-loop.html?n=2`) from the app's,
 * so every answer names the path it served; the default discards it and the
 * command line prints it.
 */
export function createProbeServer(
  root: string = HERE,
  log: (line: string) => void = () => {},
): Server {
  const base = resolve(root)

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    // The path exactly as asked for, query included, because `?n=` is the loop
    // page's whole point and the app's own requests carry none.
    let asked = request.url ?? '/'
    const say = (status: number): void => log(`probe: ${status} ${request.method} ${asked}`)

    const notFound = (): void => {
      say(404)
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found\n')
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      say(405)
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }

    const url = new URL(asked, 'http://127.0.0.1')
    asked = url.pathname + url.search
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      notFound()
      return
    }
    if (pathname === '/' || pathname === '') {
      pathname = '/probe.html'
      // Log the file that is served, not the shorthand that asked for it.
      asked = pathname + url.search
    }

    const file = resolve(base, `.${pathname}`)
    if (file !== base && !file.startsWith(base + sep)) {
      notFound()
      return
    }

    let size: number
    try {
      const stat = statSync(file)
      if (!stat.isFile()) {
        notFound()
        return
      }
      size = stat.size
    } catch {
      notFound()
      return
    }

    const range = parseRange(request.headers.range, size)
    const head = request.method === 'HEAD'
    const type = typeOf(file)

    if (range === 'unsatisfiable') {
      say(416)
      response.writeHead(416, {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${size}`,
      })
      response.end()
      return
    }

    if (range === null) {
      say(200)
      response.writeHead(200, {
        'content-type': type,
        'content-length': size,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      })
      if (head) {
        response.end()
        return
      }
      createReadStream(file).pipe(response)
      return
    }

    say(206)
    response.writeHead(206, {
      'content-type': type,
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    })
    if (head) {
      response.end()
      return
    }
    createReadStream(file, { start: range.start, end: range.end }).pipe(response)
  })
}

function main(argv: string[]): void {
  const asked = argv[2] ?? process.env.PROBE_PORT ?? String(DEFAULT_PORT)
  const port = Number(asked)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`watch-party probe: "${asked}" is not a port`)
    process.exit(1)
  }

  const server = createProbeServer(HERE, (line) => console.log(line))
  server.on('error', (error: Error) => {
    console.error(`watch-party probe: cannot listen on 127.0.0.1:${port}: ${error.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`probe page on http://127.0.0.1:${port}/probe.html (ctrl+c stops it)`)
  })
}

const program = process.argv[1]
if (program && import.meta.url === pathToFileURL(resolve(program)).href) {
  main(process.argv)
}
