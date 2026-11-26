// Drives a running window from a shell, without a hand on the mouse and without
// the screen (T8c, T19): lists the page the window is showing, runs one
// expression inside it, saves a picture of it, presses the mouse at a point,
// enters text and presses a key.
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
//   node scripts/cdp.mjs type <target-id|index> <text> [--at <x> <y>] [--port 9222]
//   node scripts/cdp.mjs key <target-id|index> <key> [--port 9222]
//
// stdout carries the answer and nothing else: JSON for `targets`, the
// expression's value for `eval`, the file's path for `shot`, one line naming
// the target, the point and the focused element for `click`, the same plus the
// characters entered and the field's new length for `type`, the key and the
// focused element for `key`. Every complaint is one line on stderr and a
// non-zero exit, so a check never hangs on a window that is not there.
//
// `click` is the only way here to make a *trusted* press: it goes through
// `Input.dispatchMouseEvent`, so the page sees a real gesture and a handler it
// reaches may call `requestFullscreen()`. An `eval`led call is refused with
// `TypeError: not granted` (T08, T19).
//
// `click`'s exit code means the press was sent, not that the page answered
// afterwards: the focus it prints is read after a frame, and a page the browser
// reports as hidden - a window behind another, a minimised one - never produces
// one. That read is therefore bounded and, when no frame comes, the line says
// the press landed and the element was not read (T190).
//
// `type` enters text the way a person's typing or paste does: it goes through
// `Input.insertText`, so the page's own `input` handler sees it and a bound
// field updates. `Runtime.evaluate` writing `element.value` is not the same
// thing - no event fires, so the page never learns (T111). It types into the
// page's focused field, or into the field at `--at <x> <y>` (a real press
// first), and refuses when nothing typeable is focused. The point it prints is
// the `--at` point when given, otherwise the centre of the focused field.
//
// `key` presses one key the way a person's keyboard does, through
// `Input.dispatchKeyEvent`: a `keyDown`, the matching `char` when the key has
// one, then a `keyUp`. The page's own `keydown` handler therefore sees a
// trusted event - `e.isTrusted` is true - where an event built in `eval` would
// not be. It knows `Space`, `Enter`, `Escape`, the four arrows and any single
// character, and refuses any other name rather than guessing at one. It names
// the key and the page's `document.activeElement`, the shape `click` prints.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_PORT = 9222
const ANSWER_TIMEOUT_MS = 10_000
/**
 * How long the page may take to produce the frame `click` reads focus after.
 * A visible page paints one every 16 ms or so; a hidden one paints none at all.
 */
const FRAME_BUDGET_MS = 500
/** The host's own bound on that read, so a page that answers nothing costs 3 s, not 10 s. */
const FRAME_ANSWER_TIMEOUT_MS = 3_000

const USAGE = [
  'usage:',
  '  node scripts/cdp.mjs targets [--port 9222]',
  '  node scripts/cdp.mjs eval <target-id|index> <expression> [--port 9222]',
  '  node scripts/cdp.mjs shot <target-id|index> <file.png> [--port 9222]',
  '  node scripts/cdp.mjs click <target-id|index> <x> <y> [--double] [--port 9222]',
  '  node scripts/cdp.mjs type <target-id|index> <text> [--at <x> <y>] [--port 9222]',
  '  node scripts/cdp.mjs key <target-id|index> <key> [--port 9222]',
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
  let at = null
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
    } else if (arg === '--at') {
      const x = argv[++index]
      const y = argv[++index]
      const pointX = Number(x)
      const pointY = Number(y)
      if (x === undefined || y === undefined || !Number.isFinite(pointX) || !Number.isFinite(pointY)) {
        const got = [x, y].filter((part) => part !== undefined).map((part) => `"${part}"`).join(' ')
        throw new CliError(`--at needs numbers for x and y, got ${got === '' ? 'nothing' : got}`, true)
      }
      at = { x: pointX, y: pointY }
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

  return { port, positional, double, at }
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
function exchange(webSocketUrl, commands, timeoutMs = ANSWER_TIMEOUT_MS) {
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
        reject(new CliError(`${commands[step].method} got no answer within ${timeoutMs / 1000} s`))
      }, timeoutMs)
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

/**
 * What the page focused once the press was handled: its tag and id, whether a
 * frame was waited for, and whether the page calls itself hidden. The wait is
 * bounded because a hidden page produces no animation frame at all (T190): it
 * then answers at once, read synchronously, with `waited: false`.
 */
const ACTIVE_ELEMENT_AFTER_CLICK = `new Promise((settle) => {
  const read = (waited) => {
    const element = document.activeElement
    const label = element ? element.tagName + (element.id ? '#' + element.id : '') : null
    settle({ element: label, waited, hidden: document.visibilityState === 'hidden' })
  }
  if (document.visibilityState === 'hidden') return read(false)
  let answered = false
  const answer = (waited) => {
    if (answered) return
    answered = true
    read(waited)
  }
  requestAnimationFrame(() => answer(true))
  setTimeout(() => answer(false), ${FRAME_BUDGET_MS})
})`

const READ_ACTIVE_ELEMENT_STEP = {
  method: 'Runtime.evaluate',
  params: { expression: ACTIVE_ELEMENT_AFTER_CLICK, returnByValue: true, awaitPromise: true },
}

/** A real mouse gesture at a point: hover, then press and release, once per click. */
function clickSteps(x, y, double) {
  const move = { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0 } }
  const gestures = (double ? [1, 2] : [1]).flatMap((clickCount) => [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount } },
  ])
  return [move, ...gestures]
}

/**
 * The page's point of focus once the press was handled, and how it was read:
 * `waited` says a frame was waited for, `hidden` says the page reported itself
 * hidden and answered without one. A page that answers nothing is not a
 * failure here - the press has already landed (T190) - so it answers
 * `waited: false` and the caller says the element was not read.
 */
async function readFocusAfterPress(webSocketUrl) {
  let results
  try {
    results = await exchange(webSocketUrl, [READ_ACTIVE_ELEMENT_STEP], FRAME_ANSWER_TIMEOUT_MS)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    return { element: null, waited: false, hidden: false }
  }

  const [focused] = results
  if (focused.exceptionDetails) {
    const thrown = focused.exceptionDetails.exception?.description ?? focused.exceptionDetails.text
    throw new CliError(`reading the focused element threw: ${thrown.split('\n')[0]}`)
  }

  const answer = focused.result?.value
  return { element: answer?.element ?? null, waited: answer?.waited === true, hidden: answer?.hidden === true }
}

/**
 * The page's focused element as a field: its tag, id, value length and the
 * centre of its box, which is the point a check quotes. `valueLength` is null
 * for an element that holds no text, which is how `type` knows to refuse before
 * anything is entered.
 */
const READ_ACTIVE_FIELD = `(() => {
  const element = document.activeElement
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const value = typeof element.value === 'string' ? element.value : null
  return {
    tag: element.tagName,
    id: element.id || '',
    valueLength: value !== null ? value.length : (element.isContentEditable ? element.textContent.length : null),
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  }
})()`

const READ_ACTIVE_FIELD_STEP = {
  method: 'Runtime.evaluate',
  params: { expression: READ_ACTIVE_FIELD, returnByValue: true },
}

/**
 * A press at the point when one is given, then the field before the text is
 * entered, then `Input.insertText`, then the field again: the browser's own
 * input path, so the page's `input` handler runs and a bound field updates.
 */
function typeSteps(text, at) {
  return [
    ...(at ? clickSteps(at.x, at.y, false) : []),
    READ_ACTIVE_FIELD_STEP,
    { method: 'Input.insertText', params: { text } },
    READ_ACTIVE_FIELD_STEP,
  ]
}

/** The field a `Runtime.evaluate` of `READ_ACTIVE_FIELD` answered, or a refusal. */
function readField(result, what) {
  if (result.exceptionDetails) {
    const thrown = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new CliError(`reading the ${what} element threw: ${thrown.split('\n')[0]}`)
  }
  return result.result?.value === undefined ? null : result.result.value
}

/**
 * The keys a check may press by name, each with the Windows virtual key code
 * the engine reads: `Space`, `Enter`, `Escape` and the four arrows. A single
 * character is pressed as itself. `text` is the character the key types, absent
 * for a key that types nothing.
 */
const NAMED_KEYS = new Map([
  ['Space', { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' }],
  ['Enter', { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' }],
  ['Escape', { key: 'Escape', code: 'Escape', virtualKeyCode: 27 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 }],
])

/** What one key name means, or one line refusing it: a name is never guessed at. */
function keyDefinition(name) {
  const named = NAMED_KEYS.get(name)
  if (named) return named
  if ([...name].length === 1) {
    if (name === ' ') return NAMED_KEYS.get('Space')
    const upper = name.toUpperCase()
    const letter = upper.length === 1 && upper >= 'A' && upper <= 'Z' ? upper.charCodeAt(0) : null
    const digit = name.length === 1 && name >= '0' && name <= '9' ? name.charCodeAt(0) : null
    return {
      key: name,
      code: letter !== null ? `Key${upper}` : digit !== null ? `Digit${name}` : '',
      virtualKeyCode: letter ?? digit ?? 0,
      text: name,
    }
  }
  throw new CliError(
    `"${name}" is not a key name - use ${[...NAMED_KEYS.keys()].join(', ')} or a single character`,
    true,
  )
}

/**
 * The key's name and what to press, or a refusal. Runs before the endpoint is
 * dialled: a key name is a fixed vocabulary, so a typo in it is not reported as
 * a missing window.
 */
function pressTarget(args) {
  const [targetKey, name, ...extra] = args
  if (targetKey === undefined || name === undefined || extra.length > 0) {
    throw new CliError('key needs a target and the key to press', true)
  }
  return { targetKey, name, definition: keyDefinition(name) }
}

/** The page's point of focus once the key was handled: a tag and an id, or null. */
const ACTIVE_ELEMENT_AFTER_KEY = `(() => {
  const element = document.activeElement
  if (!element) return null
  return element.tagName + (element.id ? '#' + element.id : '')
})()`

/**
 * One real key gesture: press, the character the key types if it types one,
 * release, then the page's point of focus. `windowsVirtualKeyCode` is what makes
 * the engine treat the key as the key it names.
 */
function keySteps(definition) {
  const wire = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.virtualKeyCode,
    nativeVirtualKeyCode: definition.virtualKeyCode,
  }
  return [
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...wire } },
    ...(definition.text === undefined
      ? []
      : [{ method: 'Input.dispatchKeyEvent', params: { type: 'char', ...wire, text: definition.text, unmodifiedText: definition.text } }]),
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...wire } },
    { method: 'Runtime.evaluate', params: { expression: ACTIVE_ELEMENT_AFTER_KEY, returnByValue: true } },
  ]
}

async function run(command, rest, port, double, at) {
  // Checked before the endpoint is dialled: a typo is not a missing window.
  if (command !== 'targets' && command !== 'eval' && command !== 'shot' && command !== 'click' && command !== 'type' && command !== 'key') {
    throw new CliError(`"${command ?? ''}" is not a subcommand.\n${USAGE}`, true)
  }

  const press = command === 'key' ? pressTarget(rest) : null

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
    // Two exchanges, and the exit code turns on the first: the press is what
    // this command sends, the focus is only its report (T190). The press and
    // its release still ride one socket, as one gesture.
    await exchange(target.webSocketDebuggerUrl, clickSteps(pointX, pointY, double))
    const focused = await readFocusAfterPress(target.webSocketDebuggerUrl)

    const element = focused.element === null ? 'null' : focused.element
    const said = focused.waited
      ? `activeElement ${element}`
      : focused.hidden
        ? `pressed; the page is hidden, so activeElement ${element} was read without waiting for a frame`
        : 'pressed; no frame came, so activeElement was not read'
    const gesture = double ? 'double-click' : 'click'
    process.stdout.write(
      `${gesture} ${key} at (${pointX}, ${pointY}) on ${target.title || target.id}: ${said}\n`,
    )
    return
  }

  if (command === 'type') {
    // The text is everything after the target, spaces included, so a link
    // pasted from a shell arrives whole. Validated after the dial, like `eval`.
    const [key, ...textParts] = rest
    const text = textParts.join(' ')
    if (key === undefined || text.length === 0) {
      throw new CliError('type needs a target and the text to enter', true)
    }

    const target = pickTarget(targets, key)
    const results = await exchange(target.webSocketDebuggerUrl, typeSteps(text, at))
    // After a press the list is [move, press, release, field, insert, field];
    // without one it is [field, insert, field].
    const before = readField(results[results.length - 3], 'focused')
    const after = readField(results[results.length - 1], 'focused')

    const field = after ?? before
    if (field === null) {
      throw new CliError('nothing to type into: no field is focused - press the field first (cdp.mjs click) or pass --at <x> <y>')
    }
    if (field.valueLength === null) {
      const label = `${field.tag}${field.id ? `#${field.id}` : ''}`
      throw new CliError(`nothing to type into: the focused ${label} holds no text - press a text field first (cdp.mjs click) or pass --at <x> <y>`)
    }

    // The field's own centre is the point when no press was asked for.
    const point = at ?? { x: field.x, y: field.y }
    const label = `${field.tag}${field.id ? `#${field.id}` : ''}`
    const entered = [...text].length
    process.stdout.write(
      `typed ${entered} char${entered === 1 ? '' : 's'} at (${point.x}, ${point.y}) on ${target.title || target.id}: activeElement ${label} (value length ${field.valueLength})\n`,
    )
    return
  }

  if (command === 'key') {
    const target = pickTarget(targets, press.targetKey)
    const results = await exchange(target.webSocketDebuggerUrl, keySteps(press.definition))
    const focused = results[results.length - 1]

    if (focused.exceptionDetails) {
      const thrown = focused.exceptionDetails.exception?.description ?? focused.exceptionDetails.text
      throw new CliError(`reading the focused element threw: ${thrown.split('\n')[0]}`)
    }

    const element = focused.result?.value === undefined ? null : focused.result.value
    process.stdout.write(`key ${press.name} on ${target.title || target.id}: activeElement ${element ?? 'null'}\n`)
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
    await run(command, rest, parsed.port, parsed.double, parsed.at)
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
