/**
 * R31 and ADR-032 (amended 2026-11-21): the initiator's own two seconds.
 *
 * When this window's Enter sends `setPage`, its site view is moved to that
 * address at once — the preview — while the authority holds the change for its
 * window and everyone else keeps watching the old page. A preview is **not a
 * follower yet**: it applies no `state` frame (a command aimed at the old film
 * must not move the preview), and it sends no `report` (a position measured on
 * the preview's page would describe a film the room is not playing).
 *
 * Two things are deliberately **not** held, because they are about the room and
 * not about the film on screen: chat and the roster arrive as usual, and
 * `pageCommitted` ends the preview — it is the frame the window is waiting for.
 *
 * The state itself lives in the app view (`pendingPreview`), because it belongs
 * to that one window; the decision lives here so a unit test can hold it. This
 * project has no DOM test, so a rule kept only inside the component is a rule
 * nothing checks.
 */

/** One staged page, from the moment its `setPage` leaves until the window ends. */
export interface PendingPreview {
  /** The canonical address the bar sent and the site view was moved to (§10.3). */
  page: string
  /** §5's epoch the `setPage` carried, so that a Cancel names the same era. */
  epoch: number
  /** This window's clock when it left; the countdown is drawn from it, nothing else. */
  sentAt: number
}

/**
 * Whether a preview holds a frame of this `type` back — `state` arriving from
 * the authority, `report` leaving this window. Every other type crosses, chat
 * and `pageCommitted` included.
 */
export function previewHolds(pending: PendingPreview | null, type: string): boolean {
  if (pending === null) return false
  return type === 'state' || type === 'report'
}
