// Scratch: the 07b rig's local page (not committed). A page whose <video> is
// built by the page's own script (the MSE shape E2 measured) and can be swapped
// for a genuinely new element from a button, plus a second episode.
//   node logs/07b-page.mjs 8099
// The media is served with real 206 range support: a server that answers 200 and
// still says `accept-ranges: bytes` leaves video.seekable at [0,0] and every
// seek resets (06b's friction).
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 0)
const media = join(import.meta.dirname, '..', 'tests', 'fixtures', 'fixture.mp4')

function page(episode) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Episode ${episode}</title>
<style>
  body { margin: 0; background: #111; color: #eee; font: 16px system-ui; }
  #stage { width: 640px; height: 360px; background: #000; }
  video { width: 640px; height: 360px; background: #000; display: block; }
  .bar { padding: 8px 12px; display: flex; gap: 8px; align-items: center; }
  button { font: inherit; padding: 4px 10px; }
  .ep { margin-left: auto; opacity: .7; }
</style></head>
<body>
<div class="bar">
  <button id="play" type="button">Play</button>
  <button id="mirror" type="button">Switch mirror</button>
  <span class="ep" id="build">build -</span>
  <span class="ep">Episode ${episode}</span>
</div>
<div id="stage"></div>
<script>
  // A site's own player: built by script after the document, not typed into the
  // HTML. That is the shape 9 of 11 players E2 tested have.
  var stage = document.getElementById('stage')
  var buildLabel = document.getElementById('build')
  var playButton = document.getElementById('play')
  window.__builds = []

  function current() { return stage.querySelector('video') }

  function build(why) {
    var v = document.createElement('video')
    v.setAttribute('data-build', String(window.__builds.length + 1))
    v.src = '/media.mp4'
    v.preload = 'auto'
    v.playsInline = true
    v.controls = true
    stage.appendChild(v)
    window.__builds.push({ token: v.getAttribute('data-build'), why: why, at: Date.now() })
    buildLabel.textContent = 'build ' + v.getAttribute('data-build')
    v.addEventListener('play', function () { playButton.textContent = 'Pause' })
    v.addEventListener('pause', function () { playButton.textContent = 'Play' })
    return v
  }

  playButton.addEventListener('click', function () {
    var v = current()
    if (!v) return
    if (v.paused) v.play(); else v.pause()
  })

  // A mirror switch: the old element is gone and a new one starts at 0. That is
  // the site behaviour ticket 07 must realign, not the old position.
  document.getElementById('mirror').addEventListener('click', function () {
    var old = current()
    window.__swapAt = Date.now()
    if (old) old.remove()
    build('mirror')
  })

  setTimeout(function () { build('initial') }, 200)
</script>
</body></html>`
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (path === '/ep1' || path === '/ep2' || path === '/') {
    const episode = path === '/ep2' ? 2 : 1
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(page(episode))
    return
  }

  if (path === '/media.mp4') {
    const size = statSync(media).size
    const range = request.headers.range
    const head = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' }

    if (typeof range === 'string') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (match === null) {
        response.writeHead(416, { ...head, 'content-range': `bytes */${size}` })
        response.end()
        return
      }
      let start = match[1] === '' ? size - Number(match[2]) : Number(match[1])
      let end = match[2] === '' || match[1] === '' ? size - 1 : Number(match[2])
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= size) end = size - 1
      if (start > end) {
        response.writeHead(416, { ...head, 'content-range': `bytes */${size}` })
        response.end()
        return
      }
      response.writeHead(206, {
        ...head,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      })
      createReadStream(media, { start, end }).pipe(response)
      return
    }

    response.writeHead(200, { ...head, 'content-length': String(size) })
    createReadStream(media).pipe(response)
    return
  }

  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('no such page')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`page server on http://127.0.0.1:${server.address().port}/ep1`)
})
