/**
 * ADR-051, R46: a YouTube address is the room's page like any other, played in
 * the app's own embed page (`/embed/youtube.html?id=<id>`), and the room stores
 * it in **one form for one film** - `https://www.youtube.com/watch?v=<id>` - so
 * a share link with a tracking parameter and a typed link are the same page.
 *
 * One parser, here, because two halves of the app need the same answer: the
 * authority normalises every address through `canonicalPage` (which asks this),
 * and the sidecar builds the embed page from an id it read the same way. If this
 * rule is ever needed twice, one copy is wrong.
 *
 * The id is the film: `t=` and every other parameter are not carried (ADR-051,
 * "one video per address").
 */

/** An 11-character video id, the one shape YouTube uses. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/** The hosts whose `/watch`, `/shorts` and `/embed` paths name a film. */
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com'])

/** The whole address of a `youtu.be` link is its path. */
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])

/** `/shorts/<id>` and `/embed/<id>`: the id is the first path segment after the word. */
const PATH_ID = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/

/** The one form the room stores, and the address bar shows (ADR-051). */
export const YOUTUBE_PAGE = 'https://www.youtube.com/watch?v='

/** Is `value` a video id and nothing else? The sidecar refuses `/embed` without one. */
export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID.test(value)
}

/**
 * The video id an address names, or `null` when it is not one of YouTube's
 * video addresses.
 *
 * Accepted, with or without `www.`, over http or https: `youtube.com/watch?v=<id>`,
 * `youtu.be/<id>`, `youtube.com/shorts/<id>`, `youtube.com/embed/<id>`. Anything
 * else - another host, a playlist, a channel, a watch link with no `v=` - is
 * `null`, so `canonicalPage` leaves it exactly as it is.
 */
export function youtubeVideoId(address: string): string | null {
  const trimmed = address.trim()
  if (trimmed.length === 0) return null

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase()

  if (SHORT_HOSTS.has(host)) {
    const id = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    return VIDEO_ID.test(id) ? id : null
  }

  if (!WATCH_HOSTS.has(host)) return null

  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? ''
    return VIDEO_ID.test(id) ? id : null
  }

  const match = PATH_ID.exec(url.pathname)
  return match === null ? null : (match[1] as string)
}
