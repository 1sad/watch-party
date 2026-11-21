/**
 * R37 and ADR-038: the one line the top row shows when a page asked for a
 * window and the host refused it.
 *
 * The *event* belongs to the host (a site's `window.open` is cancelled there),
 * the *sentence* belongs to this page (ADR-034, ADR-038). The decision kept here
 * is the one a picture cannot check twice — how many times one refusal is worth
 * saying — so it lives in a module a unit test can hold, the same arrangement as
 * `preview.ts` in this folder.
 *
 * Two rules, and the reasons for them:
 *
 * - **One line for one host per page.** A site can ask for a window from a link
 *   three times in three seconds; three lines would read as three problems and
 *   push the address bar around. The first refusal in a navigation is the news;
 *   the rest are the same news. A host already announced in this navigation is
 *   never announced again, even after the line has cleared, because the person
 *   has already been told what this page does.
 * - **It clears itself, after `POPUP_NOTICE_MS`.** A notice that stays until
 *   dismissed is a block the person has to answer; a notice that fades a few
 *   seconds after the click is a fact about the click, not a demand. Nothing
 *   else clears it: not moving the mouse, not the next chat line.
 */

/** How long the line stays, from the popup it reports. Ten seconds: long enough
 * to read after the click that caused it, short enough that it is gone before
 * the person looks at the address bar for anything else. */
export const POPUP_NOTICE_MS = 10_000

/** One popup the host refused: which host asked, and which navigation asked. */
export interface PopupEvent {
  /** The host the page asked for, as the engine reported it (`ads.example`). */
  host: string
  /** The host's count of site-view navigations, so a new page starts afresh. */
  nav: number
}

/** The line as it is shown, with the instant it arrived (this page's clock). */
export interface PopupNotice {
  host: string
  nav: number
  at: number
}

/** What the top row knows about popups: this navigation, what it already said, the line up now. */
export interface PopupState {
  /** The navigation the announced hosts belong to; `-1` before any popup event. */
  nav: number
  /** Hosts already announced in that navigation, in the order they were shown. */
  announced: string[]
  /** The line on screen, or `null` between notices. */
  notice: PopupNotice | null
}

/** No popup has been heard of: the state a window starts in and `connect` returns to. */
export function noPopups(): PopupState {
  return { nav: -1, announced: [], notice: null }
}

/**
 * One popup event folded into the state. The same object comes back when the
 * event has nothing new to say — same host, same navigation — so the caller can
 * test identity and leave the line and its timer exactly where they are.
 */
export function notePopup(state: PopupState, event: PopupEvent, now: number): PopupState {
  // A navigation the page has not heard from starts a fresh list: the same host
  // on a new page is a new fact, even if the line it replaced had not cleared.
  const announced = event.nav === state.nav ? state.announced : []
  if (announced.includes(event.host)) return state

  return {
    nav: event.nav,
    announced: [...announced, event.host],
    notice: { host: event.host, nav: event.nav, at: now },
  }
}

/**
 * The line clearing itself. `POPUP_NOTICE_MS` after it arrived, and not before;
 * the announced host is kept, so the same page cannot say the same thing twice.
 */
export function expirePopup(state: PopupState, now: number): PopupState {
  const notice = state.notice
  if (notice === null || now - notice.at < POPUP_NOTICE_MS) return state
  return { ...state, notice: null }
}

/**
 * R37's sentence. It names the host the page asked for — the difference between
 * "something tried to open a window" and a fact the person can act on — and it
 * says what happened in the same breath ("stays in one"), so the line cannot be
 * read as an ad being blocked or as a window that is coming later.
 */
export function popupSentence(host: string): string {
  return `${host} asked to open another window; Watch Party stays in one.`
}
