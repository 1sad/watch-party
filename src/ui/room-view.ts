/**
 * T26 and ADR-038: a room is either a site or a file, never both, and "with no
 * page, there is no site view". A pick clears the room's page in the sidecar
 * (`setMedia`, §4.2) and the authority then sends **only** a `media` frame — no
 * `state` ever carries `page: null` — so the window has to read the rule off the
 * room's own fields and tell the host to take the pane away.
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
 * - `file` — the room holds a file, so there is no page, no preview and no site
 *   view (ADR-038); the host is told to hide it and the app view fills the
 *   window exactly as in M1.
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
