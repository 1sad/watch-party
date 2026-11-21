// Scratch driver for the 07b proof run (not committed). One target picked by a
// substring of its URL, so the app view (:sidecar port) and the site view
// (:8099) are never confused.
//   node logs/07b-drive.mjs targets <port>
//   node logs/07b-drive.mjs eval   <port> <match> <expression>
//   node logs/07b-drive.mjs click  <port> <match> <css selector>
//   node logs/07b-drive.mjs type   <port> <match> <css selector> <text>
//   node logs/07b-drive.mjs reload <port> <match>
//   node logs/07b-drive.mjs nav    <port> <match> <url>
const [op, portArg, match, ...rest] = process.argv.slice(2)
const port = Number(portArg)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const pages = list.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
if (op === 'targets') {
  console.log(JSON.stringify(pages.map(({ id, url, title }) => ({ id, url, title }))))
  process.exit(0)
}
const target = pages.find((candidate) => candidate.url.includes(match))
if (!target) {
  console.error(`no page matching ${match}; have ${pages.map((page) => page.url).join(' | ')}`)
  process.exit(1)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, no) => {
  socket.onopen = ok
  socket.onerror = no
})

let next = 1
const waiting = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const settle = waiting.get(message.id)
  if (!settle) return
  waiting.delete(message.id)
  settle(message)
}

function call(method, params = {}) {
  const id = next++
  return new Promise((ok, no) => {
    waiting.set(id, (message) => (message.error ? no(new Error(`${method}: ${message.error.message}`)) : ok(message.result)))
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result?.value
}

async function clickAt(selector) {
  const box = await evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width} })()`,
  )
  if (box === null || box.w === 0) throw new Error(`no visible element for ${selector}`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
}

async function key(keyName, code, vk, modifiers = 0, text) {
  const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

if (op === 'eval') {
  console.log(JSON.stringify(await evaluate(rest.join(' '))))
} else if (op === 'click') {
  await clickAt(rest.join(' '))
  console.log(`clicked ${rest.join(' ')} at ${new Date().toISOString()}`)
} else if (op === 'type') {
  const selector = rest[0]
  const text = rest.slice(1).join(' ')
  await clickAt(selector)
  await key('a', 'KeyA', 65, 2)
  await call('Input.insertText', { text })
  await key('Enter', 'Enter', 13, 0, '\r')
  console.log(`typed ${text} at ${new Date().toISOString()}`)
} else if (op === 'reload') {
  await call('Page.reload', { ignoreCache: true })
  console.log(`reloaded ${target.url} at ${new Date().toISOString()}`)
} else if (op === 'nav') {
  await call('Page.navigate', { url: rest.join(' ') })
  console.log(`navigated ${target.url} to ${rest.join(' ')} at ${new Date().toISOString()}`)
} else {
  throw new Error(`unknown op ${op}`)
}

socket.close()
