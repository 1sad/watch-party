/**
 * T26 and ADR-038: a room's committed state is either a site or a file, and with
 * no page there is no site view — except for the staged preview. A room that
 * holds a file may take a page (ADR-038, amended 2026-11-22), and for the
 * stage's two seconds both views are up while the room's fields still say file
 * (`page` is `null`, `media` is set): the staged page is a window-local preview
 * of a page the room has not committed, not a second kind of media. A pick
 * clears the room's page in the sidecar (`setMedia`, §4.2) and the authority
 * then sends **only** a `media` frame — no `state` ever carries `page: null` —
 * so the window has to read the rule off the room's own fields and tell the host
 * to take the pane away.
 *
 * The state itself lives in the app view (`roomPage`, `pendingPreview`, `media`);
 * the decision lives here so a unit test can hold it. This project has no DOM
 * test, so a rule kept only inside the component is a rule nothing checks (the
 * same arrangement `ui/preview.ts` keeps).
 */

import type { Media } from '../shared/protocol.ts'

/** The two fields of a room snapshot that decide what the window shows (§4.1, §4.2). */
export interface RoomPageFields {
  page: string | null
  media: Media | null
}

/**
 * What the page side of the window is:
 *
 * - `file` — the room holds a file, so it has no committed page; at rest the
 *   host is told to hide the site view and the app view fills the window
 *   exactly as in M1 (ADR-038). A `file` side is not "no preview", though: a
 *   page staged over the file room shows at once, with the file's picture docked
 *   beside it, until the commit or the cancel.
 * - `site` — the room is on this page and the site view shows it.
 * - `none` — a room that has neither yet: nothing to show, and no pane to hide.
 */
export type PageSide = { kind: 'file' } | { kind: 'site'; page: string } | { kind: 'none' }

/**
 * The one message that takes the site view away. It stays inside the window — the
 * host reads it in `OnWebMessageReceived` and nothing crosses the wire (§5 has no
 * such frame) — and it is named here so the unit test can hold the ask itself,
 * not just the state that leads to it.
 */
export const HIDE_SITE_MESSAGE = { kind: 'hideSite' } as const

/**
 * The rule, for both frames that can state it: `welcome`'s snapshot and the one
 * `media` frame a pick sends. A room that somehow carried both is read as a
 * file: `setMedia` clears `page` when it takes a file (§4.2), so the file is
 * what the picture really is and the stale address must not keep a site view up.
 */
export function pageSide(room: RoomPageFields): PageSide {
  if (room.media !== null) return { kind: 'file' }
  return room.page === null ? { kind: 'none' } : { kind: 'site', page: room.page }
}

/**
 * T37 / ADR-038's 2026-11-22 amendment, §4.2: a room that held a file **may take
 * a page**, and the page commit clears the file in every window. The frame that
 * commits a page carries the page and nothing else (§5), so each window writes
 * the page and drops its own `media` in the same step — from that instant the
 * room is a site, the file picture is gone, and T26's gate on site events no
 * longer silences the view the commit asks for.
 *
 * The window's current fields are a parameter so the rule is the thing the case
 * holds: a window that holds a file goes into the commit and comes out a site.
 */
export function pageCommitFields(room: RoomPageFields, page: string): RoomPageFields {
  return { ...room, page, media: null }
}

/** What a closed socket means: the two facts the page holds at that instant (§14, §6). */
export interface CloseFacts {
  /** The room's own last word, `roomOver`, was seen on this connection (§14). */
  sawRoomOver: boolean
  /** The socket has closed. */
  closed: boolean
}

/**
 * T98 / ADR-047 and `spec.md` §6's "connection drops": only the room's own word
 * ends a room. The sidecar broadcasts one `roomOver` frame when the owner's
 * socket goes and then closes every socket (`src/server/socket.ts`), so a close
 * that follows that frame is the end of the room - but a bare close, with no
 * `roomOver`, is a dropped connection, which §6 says must leave the room alone
 * and wait for a rejoin (M3's job, section 13). The page therefore has to tell
 * the two closes apart rather than reading every close as an ending.
 */
export type CloseOutcome = 'connected' | 'ended' | 'lost'

/**
 * The rule, kept here so a unit test can hold it (this project has no DOM test).
 * The room's own word wins even if a close is overdue, because a room that said
 * it ended cannot be made live again by a later event; a close with no word is
 * `lost`, and a socket that has not closed is still `connected`.
 */
export function closeOutcome(facts: CloseFacts): CloseOutcome {
  if (facts.sawRoomOver) return 'ended'
  return facts.closed ? 'lost' : 'connected'
}

/** The two facts that decide which of the app's two screens is on show (ADR-047). */
export interface ScreenFields {
  /** The window has entered its room - `Start a room`, or (ticket 110) its first `welcome`. */
  entered: boolean
  /** The room itself has ended (§14, T9b), so there is nothing to watch. */
  roomEnded: boolean
}

/** ADR-047: the first screen is the room's front door, or the room is on show. */
export type Screen = 'first' | 'watching'

/**
 * T95 / ADR-047: the page shows exactly one of two screens. The first screen is
 * the room's **front door** - the room is live from the sidecar's boot, so it is
 * not a pre-room state - and the window stays on it until it has **entered** its
 * room; a room that has ended puts the window back on the first screen, because
 * there is nothing left to watch. The flag is window-local and never crosses the
 * wire (ADR-047); `enteredRoom` in `App.svelte` is a different flag (it says the
 * boot poll has connected this page) and is not this one.
 *
 * The decision lives here so a unit test can hold it: this project has no DOM
 * test, so a rule kept only inside the component is a rule nothing checks (the
 * same arrangement `pageSide` above keeps).
 */
export function screenFor(screen: ScreenFields): Screen {
  return screen.entered && !screen.roomEnded ? 'watching' : 'first'
}

/** Where the site view goes when a staged preview ends without committing. */
export type SiteRestore = { kind: 'show'; page: string } | { kind: 'hide' }

/**
 * T27 / ADR-032's amendment: a preview that ends without a commit. Cancel and a
 * refused `setPage` are the same ending for the picture — the address the bar
 * sent never became the room's page, so the site view goes back to the page the
 * room did commit, or, in a room whose page was never set, there is no site view
 * at all and T26's hide path takes the pane away.
 *
 * The staged address is not a parameter on purpose: it lives only in
 * `pendingPreview` until `pageCommitted` writes it to `roomPage` (§5), so the
 * committed page is the only address this decision can be given, and the preview
 * cannot be what the window is left showing.
 */
export function siteAfterPreview(roomPage: string | null): SiteRestore {
  return roomPage === null ? { kind: 'hide' } : { kind: 'show', page: roomPage }
}
