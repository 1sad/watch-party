/**
 * §4.3 invariant 5, §10.3 and ADR-052: the room stores the page address as
 * pasted — query string and fragment included. `room.page` is the address every
 * other app navigates to, and an episode that lives in the query is what the
 * sender meant by the link; a tokenised link therefore travels with it, which
 * the owner accepted on 2026-11-24 (ADR-052).
 *
 * One function, because both halves of the app need the same answer: the
 * authority before it stores an address (ticket 03), and the page before it
 * previews one (03b). If this rule is ever needed twice, one copy is wrong.
 */

import type { Playback, SetPageFrame } from './protocol.ts'
import { YOUTUBE_PAGE, youtubeVideoId } from './youtube.ts'

/**
 * ADR-032's window, in milliseconds: how long the authority holds a staged page
 * before it commits. The authority owns the number — §5's `setPage.stageMs` is a
 * suggestion it never reads, and a client that could shorten the window would
 * own the undo - but the initiator's bar counts the same five seconds down
 * (R29), so it is written once, here, and imported by both.
 *
 * Five, not two, since 2026-11-24: the owner found two seconds too short to
 * reach Cancel (ADR-032's amendment, R31).
 */
export const PAGE_STAGE_MS = 5000

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
 * - **the query string and the fragment are kept, exactly as sent** (ADR-052):
 *   they are part of what the sender meant by the page, so an episode in the
 *   query reaches every window and the put-back restores it. Any `user:pass@`
 *   in front of the host is still dropped — it is a credential the site reads,
 *   not part of the page's name.
 * - trailing `?` and `#` with nothing after them are not kept: the URL parser
 *   reads them as an empty query and fragment, which is the address without
 *   them.
 * - **a YouTube video address is `https://www.youtube.com/watch?v=<id>` and
 *   nothing else** (ADR-051): one form for one film, so `youtu.be/<id>`,
 *   `?t=30` and a tracking parameter all reach the room as the same page.
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

  // ADR-051 is the one exception to the rule above: on YouTube the query is the
  // film, not a session token, so a video address is stored in one form for one
  // film - `https://www.youtube.com/watch?v=<id>`. Rebuilding it from the id
  // drops `t=`, a playlist index and every tracking parameter, which is what
  // "one video per address" means. It is asked last, after every refusal, and
  // answers null for any other host, so every other page below is byte-identical
  // to what it was before this exception existed.
  const videoId = youtubeVideoId(url.href)
  if (videoId !== null) return `${YOUTUBE_PAGE}${videoId}`

  // Built field by field rather than by returning `url.href`: what is not named
  // here cannot travel, so `user:pass@` is dropped by construction and the five
  // parts that name a page — scheme, host, path, query and fragment (ADR-052) —
  // are the only ones that do.
  return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`
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

/**
 * §5's `pageCommitted` row: "the room's playback resets to position 0, paused —
 * a new page is a new film" (T07 item 4, T16). One rule, one function, because
 * both halves of the app need the same answer: the authority makes it when it
 * commits (`room.ts`'s `commitDuePage`), and the page makes it when the frame
 * arrives, since the frame carries only the commit instant and not the reset
 * playback. A realignment afterwards therefore aims at nothing: a page change
 * resets, a player replacement realigns.
 */
export function playbackAfterPageCommit(at: number): Playback {
  return { playing: false, position: 0, updatedAt: at, rate: 1 }
}
