/**
 * T178 / R54, ADR-054: what the picture area shows, decided by what the room is
 * on and who is looking.
 *
 * A room can be on a file (§4.2), on a YouTube video, or on an ordinary website,
 * and the page can be driven by the app's window host (ADR-034) or opened by a
 * plain browser that has none (`App.svelte`'s `host` is null there). Those two
 * facts pick one of four outcomes:
 *
 * - a file room is the player's picture, in the app and in a browser alike: the
 *   guest's own `<video>` is fed the owner's media address with the code
 *   (`shared/media.ts`, R53 - ticket 182 proves the picture itself);
 * - a YouTube room in the app's window is the window host's site view, which
 *   carries the app-owned embed (ADR-051);
 * - a YouTube room in a plain browser is the same embed, carried in the page's
 *   picture area and driven through the player's own API (ticket 179,
 *   `shared/embed-site.ts`, ADR-006 as amended);
 * - a website room is one plain sentence naming the app, because a page cannot
 *   script a cross-origin frame and the app's window works only because the
 *   window host injects the bridge into its site view (ADR-006 as amended,
 *   ADR-054). It is never "Waiting for the host to pick something" (R54).
 *
 * The decision lives here so a unit test can hold it: this project has no DOM
 * test, so a rule kept only inside the component is a rule nothing checks (the
 * same arrangement `ui/room-view.ts` keeps).
 */

import { youtubeVideoId } from '../shared/youtube.ts'
import type { Media } from '../shared/protocol.ts'

/** The three facts of a room and a page that decide the picture area. */
export interface PictureFields {
  /** The room's committed page (§4.1), or `null` when the room is on nothing. */
  page: string | null
  /** §4.2's file, or `null`. */
  media: Media | null
  /** A window host is driving this page, so the app's own site view is the picture (ADR-034). */
  host: boolean
}

/**
 * What the picture area holds:
 *
 * - `player` - the page's own player. `Player.svelte` draws the room's file when
 *   there is one and its own empty line when there is not, which is the room
 *   that is on nothing at all;
 * - `site` - the window host's site view, which is the app's embed for a YouTube
 *   page; the page's picture area is not where that picture is drawn;
 * - `youtube` - a YouTube room with no window host: the page's picture area
 *   carries the app-owned embed itself (ticket 179, ADR-054);
 * - `words` - one plain sentence in the picture area, ASCII (R54).
 */
export type PictureArea =
  | { kind: 'player' }
  | { kind: 'site' }
  | { kind: 'youtube' }
  | { kind: 'words'; text: string }

/**
 * R54's sentence for a room on an ordinary website, seen by a viewer with no
 * window host. One sentence, ASCII, naming the app as the way to watch the room
 * (ADR-054: the browser cannot be shown the site, ADR-006's cross-origin frame).
 */
export const BROWSER_SITE_SENTENCE =
  'Watch this room in the Watch Party app - a browser cannot play the website it is on.'

/**
 * The rule, in one place. A file wins: `setMedia` clears the page when it takes a
 * file (§4.2), and a room that somehow carried both is read as the file, which is
 * what the picture really is (`pageSide`'s rule in `ui/room-view.ts`).
 */
export function pictureFor(fields: PictureFields): PictureArea {
  if (fields.media !== null) return { kind: 'player' }
  // A room that is on nothing yet (no file, no page): the player's own empty
  // line - "Pick a page or a file to start." / "Waiting for the host to pick
  // something." (T150) - is the picture area's words, in either role.
  if (fields.page === null) return { kind: 'player' }
  if (fields.host) return { kind: 'site' }
  if (youtubeVideoId(fields.page) !== null) return { kind: 'youtube' }
  return { kind: 'words', text: BROWSER_SITE_SENTENCE }
}
