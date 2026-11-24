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

import { canonicalPage } from '../shared/page.ts'
import { isYouTubeEmbedAddress } from '../shared/youtube.ts'
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

/** The four facts one `pageAddress` is judged by (ADR-048, T105). */
export interface PageFollowFields {
  /** The top document's address as the bridge announced it, or `null` when none. */
  address: string | null
  /** The room's committed page (§4.1), or `null` in a file room or a room with no page. */
  roomPage: string | null
  /** This window's own staged page (`pendingPreview.page`), or `null`. */
  previewPage: string | null
  /** Whether this window holds control (ADR-024, ADR-030). */
  controller: boolean
}

/** What one announced address means for this window: nothing, stage it, or put the view back. */
export type PageFollow = 'ignore' | 'stage' | 'return'

/**
 * T105 / ADR-048: the room follows the page's **own** navigation, not only the
 * address bar. A controller that lands on a new address stages it through the
 * ordinary `setPage` — the same five-second window and Cancel a typed address
 * gets (ADR-032) — and a window that does not hold control puts its site view
 * back on the room's page instead. The comparison is `canonicalPage`'s: a case
 * difference is the same address and never a second stage, while a query or a
 * fragment is part of the page since ADR-052, so a change to either is a change
 * — and the navigation this window's own preview caused never is a second stage.
 *
 * The decision lives here so a unit test can hold it: this project has no DOM
 * test, so a rule kept only inside the component is a rule nothing checks (the
 * same arrangement `pageSide` above keeps).
 */
export function pageFollowOutcome(fields: PageFollowFields): PageFollow {
  const address = fields.address === null ? null : canonicalPage(fields.address)
  if (address === null) return 'ignore'
  // ADR-051, ticket 156b: the app's own embed is the picture for the room's
  // YouTube page, not a page of its own. It is ignored by the stage and never
  // put back, or the first press of play (which changes the embed's own address
  // or loads it) would stage the embed and move the whole room five seconds
  // later.
  if (isYouTubeEmbedAddress(address)) return 'ignore'
  const room = fields.roomPage === null ? null : canonicalPage(fields.roomPage)
  if (room !== null && room === address) return 'ignore'
  const preview = fields.previewPage === null ? null : canonicalPage(fields.previewPage)
  if (preview !== null && preview === address) return 'ignore'
  return fields.controller ? 'stage' : 'return'
}

/**
 * ADR-050's bound on the put-back: one window makes at most this many put-backs
 * for one stray address and one room page. The fourth try is a `stop`.
 */
export const PUT_BACK_LIMIT = 3

/**
 * What one window remembers about its put-backs (ADR-050). It is the window's
 * own record and never crosses the wire: the room's state, the authority and
 * every command are untouched by it.
 *
 * The key is the pair the count belongs to - the **origin of the stray address**
 * and the room's page, both canonical. Since ticket 160 a room page keeps its
 * query (ADR-052), so a site whose own redirect adds or changes a parameter
 * announces a different address on every load; keyed on the whole address each
 * one started a fresh count and the measured loop came back (ticket 161). The
 * origin is the part a site does not rewrite, so an origin's redirects that vary
 * their query, fragment or path share one count, while the room page keeps two
 * rooms on the same site apart. A different pair starts from zero; a commit
 * clears the record entirely (`NO_PUT_BACKS`), so a real page change still puts
 * the guest back once.
 */
export interface PutBackRecord {
  /** `strayOrigin\nroom` of the last pair, or null before the first put-back. */
  key: string | null
  /** Put-backs this window has made for that pair. */
  count: number
  /** The bound was reached and the line was said; later tries are silent. */
  stopped: boolean
}

/** The record of a window that has put nothing back yet. */
export const NO_PUT_BACKS: PutBackRecord = { key: null, count: 0, stopped: false }

/**
 * The origin an address belongs to (`https://example.com:8443`), or `''` when it
 * cannot be shared. It is taken from the canonical form, so a case difference or
 * a dropped credential cannot make one origin look like two.
 */
function originOf(raw: string | null): string {
  if (raw === null) return ''
  const canonical = canonicalPage(raw)
  if (canonical === null) return ''
  return new URL(canonical).origin
}

/**
 * The pair a put-back count belongs to: the stray address's origin and the
 * room's page (canonical). Keyed on the origin rather than the whole address,
 * because a redirect that varies the query is the site leaving again, not a
 * person choosing another episode (ticket 161, ADR-052's cost).
 */
function putBackKey(fields: PageFollowFields): string {
  const room = fields.roomPage === null ? '' : (canonicalPage(fields.roomPage) ?? '')
  return `${originOf(fields.address)}\n${room}`
}

/**
 * One announced address and the bound together (ADR-050). The decision is
 * `pageFollowOutcome`'s; this only counts the put-backs it asks for:
 *
 * - `putBack` — the ordinary return, and the record counts it;
 * - `stop` — the bound was already reached. `announce` is true on the first
 *   stop only, so one line says the site keeps leaving the room and a repeat
 *   of the same stray address says nothing more;
 * - `ignore` and `stage` leave the record exactly as it was.
 *
 * The decision lives here so a unit test can hold it (the same arrangement as
 * `pageFollowOutcome` above): four announces of one stray address are three
 * put-backs and a stop, and a cleared record puts the guest back once again.
 */
export type PageFollowStep =
  | { kind: 'ignore'; record: PutBackRecord }
  | { kind: 'stage'; record: PutBackRecord }
  | { kind: 'putBack'; record: PutBackRecord }
  | { kind: 'stop'; record: PutBackRecord; announce: boolean }

export function pageFollowStep(fields: PageFollowFields, record: PutBackRecord): PageFollowStep {
  const outcome = pageFollowOutcome(fields)
  if (outcome !== 'return') return { kind: outcome, record }

  const key = putBackKey(fields)
  const count = record.key === key ? record.count : 0
  const stopped = record.key === key ? record.stopped : false
  const kept: PutBackRecord = { key, count, stopped }
  if (stopped) return { kind: 'stop', record: kept, announce: false }
  if (count >= PUT_BACK_LIMIT) return { kind: 'stop', record: { ...kept, stopped: true }, announce: true }
  return { kind: 'putBack', record: { key, count: count + 1, stopped: false } }
}
