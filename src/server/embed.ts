/**
 * ADR-051, R46: the picture for a YouTube room page is the **sidecar's own embed
 * page**, not youtube.com. It is served here rather than read from `dist/`, so
 * the development sidecar and the built and packaged copy serve the same bytes -
 * the page is sidecar code, and ADR-043 keeps the packaged app to its own folder.
 *
 * The page owns the YouTube IFrame Player API and exposes `window.__wpYouTube` on
 * its **own top document**. That half is not a convenience: the nested
 * `www.youtube.com/embed` iframe is another origin, which `cdp.mjs` cannot
 * address, so the parent page is the only thing a check can talk to (ticket 156),
 * and 156b's bridge will talk to the same object.
 *
 * The id is validated before it reaches this string, so a page with no id is a
 * page with a message and no player rather than a broken one.
 */

import { isYouTubeVideoId } from '../shared/youtube.ts'

/** The one path the session view loads for a YouTube page (ADR-051). */
export const YOUTUBE_EMBED_PATH = '/embed/youtube.html'

/** The page's own `<script>`, inline: one page, and nothing to fetch from us. */
const SCRIPT = `
(function () {
  var videoId = __VIDEO_ID__
  var player = null
  var message = document.getElementById('message')

  function show(text) {
    message.textContent = text
    message.style.display = 'block'
  }

  // Defined before the player exists: a caller may read it while the API is
  // still loading, and a method that throws would be a page that looks broken.
  // Before the player exists each answer is null, which is the truth.
  window.__wpYouTube = {
    play: function () { if (player) player.playVideo() },
    pause: function () { if (player) player.pauseVideo() },
    seek: function (seconds) { if (player) player.seekTo(Number(seconds), true) },
    now: function () { return player ? player.getCurrentTime() : null },
    state: function () { return player ? player.getPlayerState() : null },
    duration: function () { return player ? player.getDuration() : null },
    setVolume: function (level) { if (player) player.setVolume(Number(level)) }
  }

  if (!videoId) {
    show('No video.')
    return
  }

  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player('player', {
      videoId: videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        // The API needs an http(s) origin, and it must be this sidecar's own.
        origin: window.location.origin,
        enablejsapi: 1,
        playsinline: 1,
        rel: 0
      },
      events: {
        onError: function (event) {
          // 101 and 150: the owner forbids embedding (ADR-051). One line, and
          // the room stays on the address.
          if (event && (event.data === 101 || event.data === 150)) {
            show('This video does not allow embedding. The room stays on its page.')
          }
        }
      }
    })
  }

  var api = document.createElement('script')
  api.src = 'https://www.youtube.com/iframe_api'
  document.head.appendChild(api)
})()
`

/** The embed page for `id`, or for no video when the id is not one. */
export function youtubeEmbedPage(id: string): string {
  const videoId = isYouTubeVideoId(id) ? id : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch Party - YouTube</title>
<style>
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
#player { position: absolute; inset: 0; }
#player iframe { width: 100%; height: 100%; border: 0; }
#message { position: absolute; inset: 0; display: none; margin: 0; padding: 1rem; color: #eee; font: 16px system-ui, sans-serif; background: #000; }
</style>
</head>
<body>
<div id="player"></div>
<p id="message"></p>
<script>${SCRIPT.replace('__VIDEO_ID__', JSON.stringify(videoId))}</script>
</body>
</html>
`
}
