// E10's probe. The host registers this file with
// `AddScriptToExecuteOnDocumentCreatedAsync`, so the engine runs it in every
// document it creates — the top page and each child frame, cross-origin or not.
// That is the thing this spike measures: whether `window.chrome.webview` exists
// inside a cross-origin player frame, whether a message posted from it reaches
// the host with that frame's URL in `e.Source`, and whether the element's own
// `currentTime` can be read and set from there.
//
// Nothing here ships: the host reads this file only in a Debug build and only
// when `WATCHPARTY_SPIKE_URL` names a page to open.
//
// A frame with no <video> reports once, so the log shows the frame exists and
// how many players it can see (E2: 0 in the top frame, 1 in the player frame);
// after that it stays quiet until a player appears, and frames that have one
// report every 1000 ms.
(() => {
  const bridge = window.chrome && window.chrome.webview
  if (!bridge || window.__watchPartySpike) return
  window.__watchPartySpike = true

  /** The largest <video> in this document by on-screen area, or null. */
  function largestVideo() {
    let best = null
    let bestArea = -1
    for (const video of document.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect()
      const area = Math.max(0, rect.width) * Math.max(0, rect.height)
      if (area > bestArea) {
        best = video
        bestArea = area
      }
    }
    return best
  }

  function report() {
    const video = largestVideo()
    const rect = video ? video.getBoundingClientRect() : null
    const duration = video ? video.duration : null
    const position = video ? video.currentTime : null

    bridge.postMessage({
      kind: 'spike',
      href: location.href,
      count: document.querySelectorAll('video').length,
      w: rect ? Math.round(rect.width) : null,
      h: rect ? Math.round(rect.height) : null,
      readyState: video ? video.readyState : null,
      duration: Number.isFinite(duration) ? duration : null,
      t: Number.isFinite(position) ? position : null,
    })
  }

  // The command path. The host (or a shell through the Debug DevTools endpoint)
  // posts `{kind:'spikeSetTime', t}`; the frame that owns the player sets it.
  bridge.addEventListener('message', (event) => {
    const message = event.data
    if (!message || message.kind !== 'spikeSetTime') return
    const video = largestVideo()
    if (!video) return
    const t = Number(message.t)
    if (!Number.isFinite(t) || t < 0) return
    video.currentTime = t
  })

  report()
  setInterval(() => {
    if (document.querySelectorAll('video').length > 0) report()
  }, 1000)
})()
