// Scratch driver for the 03d proof run. Not committed (logs/ is scratch).
//   node logs/03d-drive.mjs <port> addr <url>
//   node logs/03d-drive.mjs <port> join <link>
//   node logs/03d-drive.mjs <port> click <css selector>
//   node logs/03d-drive.mjs <port> eval <expression>
const [portArg, op, ...rest] = process.argv.slice(2)
const port = Number(portArg)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
if (!target) throw new Error('no app page on ' + port)

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
    waiting.set(id, (message) => (message.error ? no(new Error(method + ': ' + message.error.message)) : ok(message.result)))
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
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height} })()`,
  )
  if (box === null || box.w === 0) throw new Error('no visible element for ' + selector)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  return box
}

async function key(key, code, vk, modifiers = 0, text) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function typeInto(selector, value) {
  await clickAt(selector)
  await key('a', 'KeyA', 65, 2) // Ctrl+A: replace whatever the bar already holds
  await call('Input.insertText', { text: value })
  await key('Enter', 'Enter', 13, 0, '\r')
}

if (op === 'addr') {
  await typeInto('input[aria-label="Page address"]', rest.join(' '))
  console.log('typed address ' + rest.join(' '))
} else if (op === 'join') {
  await typeInto('input[aria-label="Invite link"]', rest.join(' '))
  console.log('typed invite ' + rest.join(' '))
} else if (op === 'click') {
  const box = await clickAt(rest.join(' '))
  console.log('clicked ' + rest.join(' ') + ' at ' + Math.round(box.x) + ',' + Math.round(box.y))
} else if (op === 'eval') {
  console.log(JSON.stringify(await evaluate(rest.join(' '))))
} else {
  throw new Error('unknown op ' + op)
}

socket.close()
