/**
 * T176 / R52: the room's code, as the page the sidecar served carries it.
 *
 * `/discovery` is loopback-only (ADR-044), so a browser guest who reloads `/`
 * cannot ask it for the room - it would answer 403 and the page would draw "The
 * room process is not answering." The code the guest needs is in the `wp_key`
 * cookie, which is HttpOnly. So the served page itself carries it, in one
 * `<meta>` the sidecar writes (`src/server/app.ts`) for a caller that is not
 * this machine's own window, and this module is the page's reader of it.
 *
 * The page's bootstrap prefers, in order: the code in its own address (the
 * invite link), this code, and only then `/discovery` - which is the app's own
 * window's route (`App.svelte`'s `onMount`).
 */
import { isRoomCode } from '../shared/room-code.ts'

/** The `<meta name>` the sidecar writes; a unit test holds it to `app.ts`'s. */
export const ROOM_CODE_META = 'watch-party-room'

/**
 * The tag's `content`, when it is a room code. Anything else - no tag, an empty
 * one, a stale or hand-edited page - is `null`, and the page falls through to
 * the next source rather than dialing a room that cannot exist.
 */
export function servedRoomCode(content: string | null | undefined): string | null {
  if (typeof content !== 'string') return null
  const code = content.trim().toUpperCase()
  return isRoomCode(code) ? code : null
}
