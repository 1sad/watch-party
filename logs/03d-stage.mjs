// Scratch: one staged page in window A, optionally cancelled, with wall-clock
// timestamps on stdout. Not committed.
//   node logs/03d-stage.mjs <port> <url> [--cancel <ms>]
const [portArg, url, ...flags] = process.argv.slice(2)
const port = Number(portArg)
const cancelIndex = flags.indexOf('--cancel')
const cancelAfter = cancelIndex === -1 ? null : Number(flags[cancelIndex + 1])

const stamp = () => new Date().toISOString().slice(11, 23)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
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
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width} })()`,
  )
  if (box === null || box.w === 0) throw new Error('no visible element for ' + selector)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
}
async function key(key, code, vk, modifiers = 0, text) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

await clickAt('input[aria-label="Page address"]')
await key('a', 'KeyA', 65, 2)
await call('Input.insertText', { text: url })
await key('Enter', 'Enter', 13, 0, '\r')
console.log(`enter ${stamp()} ${url}`)

if (cancelAfter !== null) {
  await new Promise((ok) => setTimeout(ok, cancelAfter))
  await clickAt('button.cancel')
  console.log(`cancel-click ${stamp()}`)
}

socket.close()
