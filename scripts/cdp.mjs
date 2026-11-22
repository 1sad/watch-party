// Drives a running window from a shell, without a hand on the mouse and without
// the screen (T8c, T19): lists the page the window is showing, runs one
// expression inside it, saves a picture of it, presses the mouse at a point.
//
// It speaks to the DevTools endpoint that only the measuring build opens —
// `npm run dev:debug` — and that endpoint listens on loopback only. Nothing
// here is shipped code, and it adds no dependency: Node 24's own fetch and
// WebSocket are enough (ADR-035).
//
//   node scripts/cdp.mjs targets [--port 9222]
//   node scripts/cdp.mjs eval <target-id|index> <expression> [--port 9222]
//   node scripts/cdp.mjs shot <target-id|index> <file.png> [--port 9222]
//   node scripts/cdp.mjs click <target-id|index> <x> <y> [--double] [--port 9222]
//
// stdout carries the answer and nothing else: JSON for `targets`, the
// expression's value for `eval`, the file's path for `shot`, one line naming
// the target, the point and the focused element for `click`. Every complaint is
// one line on stderr and a non-zero exit, so a check never hangs on a window
// that is not there.
//
// `click` is the only way here to make a *trusted* press: it goes through
// `Input.dispatchMouseEvent`, so the page sees a real gesture and a handler it
// reaches may call `requestFullscreen()`. An `eval`led call is refused with
// `TypeError: not granted` (T08, T19).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_PORT = 9222
const ANSWER_TIMEOUT_MS = 10_000

const USAGE = [
  'usage:',
  '  node scripts/cdp.mjs targets [--port 9222]',
  '  node scripts/cdp.mjs eval <target-id|index> <expression> [--port 9222]',
  '  node scripts/cdp.mjs shot <target-id|index> <file.png> [--port 9222]',
  '  node scripts/cdp.mjs click <target-id|index> <x> <y> [--double] [--port 9222]',
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

/** Splits `--port` out of the arguments wherever it appears; order never matters. */
function parseArgs(argv) {
  let port = DEFAULT_PORT
  let double = false
  const configured = process.env.WP_DEBUG_PORT

  if (configured) {
    port = Number(configured)
    if (!isPort(port)) {
      throw new CliError(`WP_DEBUG_PORT must be a port number, got "${configured}"`)
    }
  }

  const positional = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--double') {
      double = true
    } else if (arg === '--port') {
      const value = argv[++index]
      port = Number(value)
      if (!isPort(port)) {
        throw new CliError(`--port needs a port number, got ${value === undefined ? 'nothing' : `"${value}"`}`, true)
      }
    } else if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length)
      port = Number(value)
      if (!isPort(port)) {
        throw new CliError(`--port needs a port number, got "${value}"`, true)
      }
    } else {
      positional.push(arg)
    }
  }

  return { port, positional, double }
}

/** The page targets of the window on `port`, or one clear line saying there is none. */
async function pageTargets(port) {
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
  return list
    .filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    .map((target) => ({ id: target.id, title: target.title, url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl }))
}

/** A target by its id, or by its position in the `targets` list. */
function pickTarget(targets, key) {
  if (targets.length === 0) {
    throw new CliError('the window has no page to drive yet - its sidecar may not have reported a port')
  }

  if (/^\d+$/.test(key)) {
    const target = targets[Number(key)]
    if (target) return target
    throw new CliError(`no target at index ${key}; there ${targets.length === 1 ? 'is 1 page' : `are ${targets.length} pages`} - run \`targets\` to list them`)
  }

  const target = targets.find((candidate) => candidate.id === key)
  if (target) return target
  throw new CliError(`no target with id ${key} - run \`targets\` to list them`)
}

/**
 * Several DevTools commands over one WebSocket, in order, each answered or
 * refused; never open-ended. One socket because a press and its release belong
 * to the same gesture: a second connection would be a second session.
 */
function exchange(webSocketUrl, commands) {
  return new Promise((settle, reject) => {
    const socket = new WebSocket(webSocketUrl)
    const results = []
    let step = 0
    let timer

    const close = () => {
      try {
        socket.close()
      } catch {
        // The answer is already read, or the socket is already gone.
      }
    }
    const finish = (action, value) => {
      clearTimeout(timer)
      close()
      action(value)
    }
    const advance = () => {
      if (step >= commands.length) return finish(settle, results)
      clearTimeout(timer)
      timer = setTimeout(() => {
        close()
        reject(new CliError(`${commands[step].method} got no answer within ${ANSWER_TIMEOUT_MS / 1000} s`))
      }, ANSWER_TIMEOUT_MS)
      socket.send(JSON.stringify({ id: step + 1, method: commands[step].method, params: commands[step].params ?? {} }))
    }

    socket.onopen = advance
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== step + 1) return
      const { method } = commands[step]
      if (message.error) {
        finish(reject, new CliError(`${method} refused: ${message.error.message}`))
      } else {
        results.push(message.result)
        step++
        advance()
      }
    }
    socket.onerror = () => finish(reject, new CliError(`could not open the page's DevTools socket at ${webSocketUrl}`))
  })
}

/** One DevTools command over one WebSocket, answered or refused; never open-ended. */
function send(webSocketUrl, method, params = {}) {
  return exchange(webSocketUrl, [{ method, params }]).then(([result]) => result)
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** What the page focused once the press was handled: a tag and an id, or null. */
const ACTIVE_ELEMENT_AFTER_CLICK = `new Promise((settle) => {
  requestAnimationFrame(() => {
    const element = document.activeElement
    if (!element) return settle(null)
    settle(element.tagName + (element.id ? '#' + element.id : ''))
  })
})`

/** A real mouse gesture at a point: hover, then press and release, once per click. */
function clickSteps(x, y, double) {
  const move = { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0 } }
  const gestures = (double ? [1, 2] : [1]).flatMap((clickCount) => [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount } },
  ])
  return [move, ...gestures, { method: 'Runtime.evaluate', params: { expression: ACTIVE_ELEMENT_AFTER_CLICK, returnByValue: true, awaitPromise: true } }]
}

async function run(command, rest, port, double) {
  // Checked before the endpoint is dialled: a typo is not a missing window.
  if (command !== 'targets' && command !== 'eval' && command !== 'shot' && command !== 'click') {
    throw new CliError(`"${command ?? ''}" is not a subcommand.\n${USAGE}`, true)
  }

  const targets = await pageTargets(port)

  if (command === 'targets') {
    if (rest.length > 0) throw new CliError(`targets takes no arguments, got "${rest.join(' ')}"`, true)
    print(targets.map(({ webSocketDebuggerUrl, ...target }) => target))
    return
  }

  if (command === 'eval') {
    const [key, ...expression] = rest
    if (key === undefined || expression.length === 0) {
      throw new CliError('eval needs a target and an expression', true)
    }

    const target = pickTarget(targets, key)
    const result = await send(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: expression.join(' '),
      returnByValue: true,
      awaitPromise: true,
    })

    if (result.exceptionDetails) {
      const thrown = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new CliError(`the expression threw: ${thrown.split('\n')[0]}`)
    }

    print(result.result?.value === undefined ? null : result.result.value)
    return
  }

  if (command === 'shot') {
    const [key, ...fileParts] = rest
    if (key === undefined || fileParts.length === 0) {
      throw new CliError('shot needs a target and a file name', true)
    }

    const target = pickTarget(targets, key)
    const { data } = await send(target.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' })
    const file = resolve(fileParts.join(' '))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(data, 'base64'))
    // The path as one plain line: it goes straight into the next command.
    process.stdout.write(`${file}\n`)
    return
  }

  if (command === 'click') {
    // Validated after the dial, like `eval`: with no window the missing
    // endpoint is the answer, not the counting of arguments.
    const [key, x, y, ...extra] = rest
    if (key === undefined || x === undefined || y === undefined || extra.length > 0) {
      throw new CliError('click needs a target, an x and a y', true)
    }
    const pointX = Number(x)
    const pointY = Number(y)
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) {
      throw new CliError(`click needs numbers for x and y, got "${x}" "${y}"`, true)
    }

    const target = pickTarget(targets, key)
    const results = await exchange(target.webSocketDebuggerUrl, clickSteps(pointX, pointY, double))
    const focused = results[results.length - 1]

    if (focused.exceptionDetails) {
      const thrown = focused.exceptionDetails.exception?.description ?? focused.exceptionDetails.text
      throw new CliError(`reading the focused element threw: ${thrown.split('\n')[0]}`)
    }

    const element = focused.result?.value === undefined ? null : focused.result.value
    const gesture = double ? 'double-click' : 'click'
    process.stdout.write(
      `${gesture} ${key} at (${pointX}, ${pointY}) on ${target.title || target.id}: activeElement ${element ?? 'null'}\n`,
    )
  }
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    return fail(error)
  }

  const [command, ...rest] = parsed.positional
  try {
    await run(command, rest, parsed.port, parsed.double)
  } catch (error) {
    fail(error)
  }
}

function fail(error) {
  if (error instanceof CliError) {
    process.stderr.write(`watch-party: ${error.message}\n`)
    process.exit(error.usage ? 2 : 1)
  }

  process.stderr.write(`watch-party: ${error?.message ?? error}\n`)
  process.exit(1)
}

await main()
