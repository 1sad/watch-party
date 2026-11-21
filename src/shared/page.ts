/**
 * §4.3 invariant 5 and §10.3: the room never stores a tokenised or private URL.
 * `room.page` is the address every other app navigates to, so it travels to
 * people the sender never meant to hand a link to — a query string carrying a
 * token must never make that trip.
 *
 * One function, because both halves of the app need the same answer: the
 * authority before it stores an address (ticket 03), and the page before it
 * previews one (03b). If this rule is ever needed twice, one copy is wrong.
 */

import type { SetPageFrame } from './protocol.ts'

/** An explicit scheme, as RFC 3986 writes one: `https:`, `ftp:`, `javascript:`. */
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** `https://…` — the only two schemes a room page may use (§10.3). */
const WEB_SCHEME = /^https?:\/\//i

/**
 * `example.com:8443`, `localhost:3000`, `192.168.1.5:8080` — a host and a port,
 * not a scheme. Without this a host written with a port reads as a scheme called
 * `example.com` and would be refused for the wrong reason.
 */
const HOST_AND_PORT = /^[a-z0-9.-]+:\d+/i

/**
 * The room's canonical form of an address, or `null` when it cannot be shared.
 *
 * - a bare host is `https://` (§10.3's sites are all https; the picker offers no
 *   way to type `http://`, and a plain-http page would be blocked anyway);
 * - only `http` and `https` survive — `ftp:`, `file:`, `javascript:` and
 *   `data:` are refused, because every app in the room would run them;
 * - the host is lowercased, since `Example.COM` and `example.com` are one site;
 * - **the query string and the fragment are dropped** (invariant 5), and so is
 *   any `user:pass@` in front of the host, for the same reason: it is a secret
 *   in an address that is about to be handed to five machines.
 *
 * The result is idempotent — canonical in, the same canonical out — so a stored
 * page can be compared with a fresh one by string equality.
 */
export function canonicalPage(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  // Chromium's URL parser and Node's disagree about whitespace in the host:
  // the page's engine turns `https://not a url` into `https://not%20a%20url/`
  // while Node throws. This function is the one answer both halves must give
  // (ticket 03 drops an unshareable address silently, 03b refuses it out
  // loud), so whitespace is refused here, before either parser sees it.
  // "not a url" is a sentence, not a link.
  if (/\s/.test(trimmed)) return null

  if (EXPLICIT_SCHEME.test(trimmed) && !WEB_SCHEME.test(trimmed) && !HOST_AND_PORT.test(trimmed)) {
    return null
  }

  const candidate = WEB_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname.length === 0) return null

  // Built field by field rather than by clearing `search`/`hash` on `url.href`:
  // what is not named here cannot travel, which is the point of the function.
  return `${url.protocol}//${url.host}${url.pathname}`
}

/**
 * The one thing Enter in the address bar sends (03b), or `null` when nothing
 * may leave this window at all.
 *
 * The authority drops an unshareable address silently (ticket 03), so a page
 * that sent one would show no refusal and send a frame nobody acts on. The
 * decision belongs here, with `canonicalPage`, where a unit test can hold it:
 * blank and unusable both mean "no frame", which is a fact about this function
 * and not about the event handler that calls it.
 */
export function setPageFrame(raw: string, epoch: number): SetPageFrame | null {
  const page = canonicalPage(raw)
  if (page === null) return null
  return { type: 'setPage', page, epoch }
}
