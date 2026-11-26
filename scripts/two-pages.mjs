// Reads two pages in the same instant from one process and prints how far
// apart they are, so "inside 0.25 s" (ADR-039) is measured rather than
// eyeballed. Tickets 164, 179 and 178's check each wrote their own throwaway -
// one Node process, one WebSocket per page, both evaluated in the same tick,
// printing a per-sample row (`a.now a.state b.now b.state gap`). Every version
// did a slightly different thing and none can be re-run by the next ticket.
// This is that tool, re-runnable.
//
//   node scripts/two-pages.mjs --port <n> --port <m> --eval <expression> [--count <n>] [--interval <ms>]
//
// `--eval` is the caller's expression, evaluated on both pages in the same tick
// (both requests are sent before either answer is awaited). It must resolve to
// an object with a numeric `now` - the position being compared, e.g. a film's
// `currentTime` or the embed's `now()` - and a `state` of the caller's choosing
// (a player state, `paused`/`playing`, anything). The tool does not know what
// it is reading: the same command serves a YouTube room, a file room and a
// plain page. The ports default to 9222 and 9223, the two `dev:debug` windows.
//
// stdout carries one row per sample plus the worst gap, and nothing else:
//
//   0 a.now=25.9149 a.state=playing b.now=25.9247 b.state=playing gap=0.0098
//   1 a.now=26.9149 a.state=playing b.now=26.9247 b.state=playing gap=0.0098
//   worst gap 0.0098 at sample 0
//
// `gap` is `b.now - a.now`, signed; the worst gap is the sample farthest from
// zero. `--interval` is the ms between the start of one sample and the start of
// the next (default 1000), and `--count` defaults to 1. Every complaint is one
// line on stderr and a non-zero exit, never a stack trace: no endpoint, no
// page, a thrown expression, a result without a numeric `now`, or no sample
// taken all exit 1; a mistyped argument exits 2. It reads two DevTools
// endpoints on loopback and writes nothing - no dependency is added (ADR-035).
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { formatRow, formatSummary, worstSample } from './two-pages-format.ts'

const DEFAULT_PORTS = [9222, 9223]
const ANSWER_TIMEOUT_MS = 10_000
const DEFAULT_COUNT = 1
const DEFAULT_INTERVAL_MS = 1000

const USAGE = [
  'usage:',
  '  node scripts/two-pages.mjs --port <n> --port <m> --eval <expression> [--count <n>] [--interval <ms>]',
].join('\n')

/** A problem worth one line on stderr. `usage` separates a typo from a failure. */
class CliError extends Error {
  usage
  constructor(message, usage = false) {
    super(message)
    this.usage = usage
  }
}

function isPort(value) {
  return Number.isInteger(value) && value > 0 && value < 65_536
}

/** Splits the flags out of the arguments wherever they appear; order never matters. */
function parseArgs(argv) {
  const ports = []
  let expression
  let count = DEFAULT_COUNT
  let interval = DEFAULT_INTERVAL_MS

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--port') {
      const value = argv[++index]
      const port = Number(value)
      if (!isPort(port)) {
        throw new CliError(`--port needs a port number, got ${value === undefined ? 'nothing' : `"${value}"`}`, true)
      }
      ports.push(port)
    } else if (arg === '--eval') {
      const value = argv[++index]
      if (value === undefined || value === '') {
        throw new CliError('--eval needs an expression', true)
      }
      expression = value
    } else if (arg === '--count') {
      const value = argv[++index]
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) {
        throw new CliError(`--count needs a positive integer, got ${value === undefined ? 'nothing' : `"${value}"`}`, true)
      }
      count = n
    } else if (arg === '--interval') {
      const value = argv[++index]
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms < 0) {
        throw new CliError(`--interval needs a non-negative number of ms, got ${value === undefined ? 'nothing' : `"${value}"`}`, true)
      }
      interval = ms
    } else {
      throw new CliError(`unexpected argument "${arg}"\n${USAGE}`, true)
    }
  }

  if (expression === undefined) {
    throw new CliError(`--eval is required\n${USAGE}`, true)
  }
  if (ports.length === 1 || ports.length > 2) {
    throw new CliError(`two --port values are needed, got ${ports.length}\n${USAGE}`, true)
  }

  const [portA = DEFAULT_PORTS[0], portB = DEFAULT_PORTS[1]] = ports
  return { portA, portB, expression, count, interval }
}

/** The page target's socket URL on `port`, or one clear line saying there is none. */
async function pageSocketUrl(port) {
  const url = `http://127.0.0.1:${port}/json/list`
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) })
  } catch {
    throw new CliError(
      `no DevTools endpoint on 127.0.0.1:${port} - start a window with \`npm run dev:debug\` (or pass --port <n>)`,
    )
  }

  if (!response.ok) {
    throw new CliError(`no DevTools endpoint on 127.0.0.1:${port} - it answered HTTP ${response.status}`)
  }

  const list = await response.json()
  const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (!page) {
    throw new CliError(`no page to read on 127.0.0.1:${port} - run \`node scripts/cdp.mjs targets --port ${port}\` to list them`)
  }
  return page.webSocketDebuggerUrl
}

/** One DevTools WebSocket, opened and ready; the page's socket is the connection. */
function openSocket(webSocketUrl) {
  return new Promise((settle, reject) => {
    const socket = new WebSocket(webSocketUrl)
    socket.onopen = () => settle(socket)
    socket.onerror = () => reject(new CliError(`could not open the page's DevTools socket at ${webSocketUrl}`))
  })
}

/**
 * A client that keeps one socket open across the whole run and answers each
 * `evaluate` in order. One socket per page: a second connection would be a
 * second session, and the two pages must stay the two the caller pointed at.
 */
function makeClient(socket) {
  let nextId = 1
  const pending = new Map()

  socket.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry(message)
  }

  return {
    evaluate(expression, timeoutMs = ANSWER_TIMEOUT_MS) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new CliError(`Runtime.evaluate got no answer within ${timeoutMs / 1000} s`))
        }, timeoutMs)
        pending.set(id, (message) => {
          clearTimeout(timer)
          if (message.error) {
            reject(new CliError(`Runtime.evaluate refused: ${message.error.message}`))
            return
          }
          if (message.result?.exceptionDetails) {
            const thrown = message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text
            reject(new CliError(`the expression threw: ${thrown.split('\n')[0]}`))
            return
          }
          resolve(message.result?.result?.value)
        })
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      })
    },
    close() {
      try {
        socket.close()
      } catch {
        // Already gone.
      }
    },
  }
}

/** The expression's result as `{ now, state }`, or one line refusing a bad shape. */
function readSample(port, value) {
  if (value === null || typeof value !== 'object' || typeof value.now !== 'number' || !Number.isFinite(value.now)) {
    throw new CliError(`the expression's result has no numeric now on 127.0.0.1:${port} (got ${JSON.stringify(value)})`)
  }
  return value
}

function print(line) {
  process.stdout.write(`${line}\n`)
}

const sleep = (ms) => new Promise((ready) => setTimeout(ready, ms))

async function main() {
  const parsed = parseArgs(process.argv.slice(2))

  const [socketUrlA, socketUrlB] = await Promise.all([pageSocketUrl(parsed.portA), pageSocketUrl(parsed.portB)])
  const clientA = makeClient(await openSocket(socketUrlA))
  const clientB = makeClient(await openSocket(socketUrlB))

  const samples = []
  try {
    for (let index = 0; index < parsed.count; index += 1) {
      const started = performance.now()
      // Both requests are sent before either answer is awaited: one tick, not two.
      const a = clientA.evaluate(parsed.expression)
      const b = clientB.evaluate(parsed.expression)
      const [aValue, bValue] = await Promise.all([a, b])

      const aRead = readSample(parsed.portA, aValue)
      const bRead = readSample(parsed.portB, bValue)
      const sample = {
        index,
        aNow: aRead.now,
        aState: aRead.state,
        bNow: bRead.now,
        bState: bRead.state,
        gap: bRead.now - aRead.now,
      }
      samples.push(sample)
      print(formatRow(sample))

      if (index < parsed.count - 1) {
        const wait = parsed.interval - (performance.now() - started)
        if (wait > 0) await sleep(wait)
      }
    }
  } finally {
    clientA.close()
    clientB.close()
  }

  print(formatSummary(worstSample(samples)))
}

function fail(error) {
  if (error instanceof CliError) {
    process.stderr.write(`watch-party: ${error.message}\n`)
    process.exit(error.usage ? 2 : 1)
  }
  process.stderr.write(`watch-party: ${error?.message ?? error}\n`)
  process.exit(1)
}

const program = process.argv[1]
if (program && import.meta.url === pathToFileURL(resolve(program)).href) {
  main().catch(fail)
}
