/**
 * T7b2's dev-only disturbance, and nothing else.
 *
 * The milestone gate (`spec.md` §7 layer C) needs one window to fall behind on
 * purpose while the other keeps playing, and no real network on one machine will
 * do that. So this window is given the fault by URL:
 *
 * - `?stall=5` freezes the local element for 5 s, two seconds after playback
 *   begins. The freeze is a local pause through §6.6's echo set, so it sends the
 *   room **no** command: the room keeps playing and this window is behind, which
 *   is exactly what a stall looks like from the authority's side.
 * - `?nudge=0.95:4000` applies a nudge this window never received — the
 *   *lost message* T7b2's Safety line is about — so the deadline can be watched
 *   with the authority silent. It is here, not in the page's real path, because
 *   the real path is what the authority's `correction` log lines already prove.
 *
 * Both are read once, at load, and only in a dev build: `App.svelte` imports this
 * file inside an `import.meta.env.DEV` branch, which Vite replaces with `false`
 * at build time, so the reader and both parameters are dropped from `dist/`
 * (`npm run dev` builds `vite build`; `npm run build:dev` is the build that keeps
 * them, as T5's clock skew does). A shipped window has no way to be asked to
 * drift.
 */

export const STALL_PARAM = 'stall'
export const NUDGE_PARAM = 'nudge'

/**
 * How long after playback first begins the disturbance lands. Two seconds is
 * enough for the room to have decided it is playing and for the other window to
 * have applied the same `state`; a stall that began before the room played would
 * be a stall of nothing.
 */
export const DEV_ARM_MS = 2000

/** The most a switch may inject, so a typo cannot park the gate for an hour. */
export const MAX_DEV_STALL_SECONDS = 120

export interface DevPlay {
  /** Freeze this window's element for this many seconds; 0 is "no stall". */
  stallSeconds: number
  /**
   * A nudge this window never received: the rate to hold and how long, in
   * milliseconds, before its `untilAuthorityMs`. `null` is "none".
   */
  nudge: { rate: number; milliseconds: number } | null
}

const NONE: DevPlay = { stallSeconds: 0, nudge: null }

/**
 * What this page was asked to do, in millis; anything unreadable is none. A
 * negative or absurd stall is refused rather than clamped, because a clamp would
 * quietly turn a typo into a different experiment.
 */
export function readDevPlay(search: string): DevPlay {
  const params = new URLSearchParams(search)

  const stall = Number(params.get(STALL_PARAM))
  const stallSeconds =
    Number.isFinite(stall) && stall > 0 && stall <= MAX_DEV_STALL_SECONDS ? stall : 0

  return { stallSeconds, nudge: readNudge(params.get(NUDGE_PARAM)) }
}

/** `rate:ms`, the half of the switch that rehearses a lost nudge (§6.3). */
function readNudge(raw: string | null): DevPlay['nudge'] {
  if (raw === null) return NONE.nudge
  const [rateText, msText] = raw.split(':')
  const rate = Number(rateText)
  const milliseconds = Number(msText)
  if (!Number.isFinite(rate) || !Number.isFinite(milliseconds)) return null
  if (milliseconds <= 0 || milliseconds > MAX_DEV_STALL_SECONDS * 1000) return null
  // The ladder's two rates are the page's rule, not this reader's; `nudgeRateAt`
  // refuses anything else at the moment of holding it.
  return { rate, milliseconds }
}
