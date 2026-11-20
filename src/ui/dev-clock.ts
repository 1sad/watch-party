/**
 * T5's dev-only clock skew, and nothing else.
 *
 * A window cannot see a true clock, so the only way to check the estimator
 * against a *known* error is to give this page one. `?clockSkew=137` makes this
 * window's clock read 137 ms slow — the state a laptop is in after waking, which
 * is exactly what §6.1's jump rule is for.
 *
 * The sign is deliberate: the number is how far *behind* the authority this
 * clock is, so a positive skew leaves `authorityNow()` ahead of `Date.now()`,
 * and T5's check reads `authorityNow()` being ahead as the right sign.
 *
 * A shipped page never reaches this file: `App.svelte` imports it only inside
 * an `import.meta.env.DEV` branch, which Vite replaces with `false` at build
 * time, so the reader and the overlay are dropped from `dist/` (T5: "absent in
 * a production build, and never able to alter what a member's page believes").
 */
export const CLOCK_SKEW_PARAM = 'clockSkew'

/** The skew this page was asked for, in millis; anything unreadable is none. */
export function readClockSkew(search: string): number {
  const raw = new URLSearchParams(search).get(CLOCK_SKEW_PARAM)
  if (raw === null) return 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}
