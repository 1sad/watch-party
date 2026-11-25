/**
 * T177 / R56: the sentence a browser that cannot run the page keeps.
 *
 * The sidecar writes this line into the page it serves (`src/server/app.ts`),
 * before the bundle has run, so a browser too old to start the page shows a
 * sentence naming a current one instead of a blank picture. The page removes it
 * as soon as its own code takes over (`App.svelte`'s `onMount`). Both halves
 * read the id from here, so the sentence cannot be served and then never
 * removed, or removed from a page that never carried it.
 */

/** The element's id in the served markup. */
export const BOOT_SENTENCE_ID = 'watch-party-boot'

/** One plain sentence, visible without the bundle. */
export const BOOT_SENTENCE =
  'If this line stays, open this address in a current browser (Chrome, Edge, Firefox or Safari).'
