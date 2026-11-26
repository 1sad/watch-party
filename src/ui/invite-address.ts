/**
 * T185 / R51 as amended, ADR-056: one invitation, on every screen.
 *
 * The address a screen shows is always the **room's** plain
 * `http://<address>:<port>/join?c=<code>` address - never the window's own
 * connection. A guest's page is served from its own loopback sidecar, so
 * `location.origin` there names the guest's port and not the room's; the
 * address it joined by is the one that reaches the room (ticket 183's evidence
 * picture shows a joined guest printing 56313 while the room ran on 51390, and
 * a friend sent that address would reach the guest's empty room).
 *
 * Three screens carry the invitation (ADR-056), and they learn the room's
 * address from three places:
 *
 *   front-door     the owner's own `/discovery` answer, already composed
 *   app-guest      the origin this window dialled (`connect`'s host and port)
 *   browser-guest  the page's own origin - the room's port, because the sidecar
 *                  that served this page is the room's own (`app.ts`)
 *
 * Pure, like `join.ts` and the timing maths: no DOM, no socket, so `node --test`
 * can hold the three screens to one address for one room.
 */

/** The three screens a person can read the invitation on. */
export type InviteSurface = 'front-door' | 'app-guest' | 'browser-guest'

export interface InviteAddressInput {
  surface: InviteSurface
  /** The room's code, as this window last heard it. */
  code: string | null
  /** The owner's plain address from its own `/discovery` answer (`InviteLinks.raw`). */
  ownAddress: string | null
  /** The origin this window dialled: the address an app guest joined by. */
  roomOrigin: string | null
  /** The page's own origin, for a browser guest the room's sidecar served. */
  pageOrigin: string | null
}

/** The room's one invitation for this screen, or `null` while there is no address to print. */
export function invitationAddress(input: InviteAddressInput): string | null {
  // The owner's address is composed by the sidecar from its own discovery
  // verdict (`invite.ts`), so it is printed exactly as built: re-deriving it
  // here from `location` would print the owner's loopback port instead.
  if (input.surface === 'front-door') return input.ownAddress

  const code = (input.code ?? '').trim().toUpperCase()
  if (code.length === 0) return null
  const origin = input.surface === 'app-guest' ? input.roomOrigin : input.pageOrigin
  if (origin === null || origin.length === 0) return null
  return `${origin.replace(/\/+$/, '')}/join?c=${code}`
}
