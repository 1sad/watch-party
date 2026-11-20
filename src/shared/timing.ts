/**
 * `spec.md` §6's arithmetic and nothing else (T5).
 *
 * Pure on purpose: no clock of its own, no socket, no I/O, no import from the
 * page or the sidecar. Instants go in as numbers and values come out, so the
 * page can run the loop and the tests can feed it a stopwatch they control.
 * §6 says it once, here (AGENTS.md: a number from this module that appears a
 * second time is a copy, and one of the two is wrong).
 */

/** §6.1: the `ping` every 5 s is both the liveness beat and the clock sample. */
export const PING_INTERVAL_MS = 5000

/**
 * §6.1: a sample this far from the filter's mean is a sleeping laptop or a
 * clock step, not a better measurement. The estimator is **reset**, not fed —
 * the Safety line of T5.
 */
export const JUMP_RESET_MS = 2000

/**
 * The most weight the filter keeps, in units of one zero-RTT sample. It is what
 * stops an old offset from being believed forever after a real clock change,
 * while a sample with 300 ms of round trip still counts for almost nothing
 * (`weightFor` falls off with the square of the RTT).
 */
export const MAX_WEIGHT = 8

/** One picture of a round trip: the four instants the two ends saw (§6.1). */
export interface Sample {
  /** `(t3 − t0) − (t2 − t1)`, the round trip without the authority's think time. Millis. */
  rtt: number
  /** `((t1 − t0) + (t2 − t3)) / 2`, the authority's clock minus ours. Millis. */
  offset: number
}

/**
 * The one place `rtt` and `offset` are worked out from a `pong`'s instants —
 * `t0` and `t3` from this window, `t1` and `t2` from the authority — so their
 * arithmetic cannot drift from the filter that consumes them.
 *
 * `null` when the numbers are not four instants: a frame is untrusted input,
 * and a NaN must never reach the estimate (it would poison the mean forever).
 * A negative round trip is a clock that moved mid-measurement; it is clamped
 * to zero rather than trusted, because the offset it implies is still the best
 * of a bad pair.
 */
export function sampleFrom(t0: number, t1: number, t2: number, t3: number): Sample | null {
  if (![t0, t1, t2, t3].every((value) => Number.isFinite(value))) return null
  const rtt = t3 - t0 - (t2 - t1)
  const offset = ((t1 - t0) + (t2 - t3)) / 2
  return { rtt: Math.max(0, rtt), offset }
}

/**
 * §6.1's EWMA: the weighted mean of every sample since the last reset, each
 * weighted by `weightFor(rtt)` — a min-RTT filter, because a slow round trip
 * is the one that was queued behind something else.
 */
export interface OffsetEstimate {
  /** Millis to add to this window's clock: `authorityNow = local + offset`. */
  offset: number
  /** The newest accepted sample's round trip, millis — what `report` carries. */
  rtt: number
  /** Accepted since the last reset; 0 on a fresh estimator, which is "no answer yet". */
  samples: number
  /** Total weight the mean holds, capped at `MAX_WEIGHT`. 0 on a fresh estimator. */
  weight: number
}

/**
 * A fresh estimator, and also a reset: `samples: 0` is the honest "I do not
 * know yet", so a page that has not heard a `pong` never adds a stale offset to
 * anything (§6.1: reset on reconnect).
 */
export function emptyEstimate(): OffsetEstimate {
  return { offset: 0, rtt: 0, samples: 0, weight: 0 }
}

/** `1 / (1 + rtt)²`: a 300 ms sample counts for about 1/90000 of a fast one. */
function weightFor(rtt: number): number {
  const denominator = 1 + Math.max(0, rtt)
  return 1 / (denominator * denominator)
}

/**
 * Folds one sample into the estimate (§6.1).
 *
 * - a fresh estimator (or a reconnect) takes the sample as it is;
 * - a sample more than `JUMP_RESET_MS` from the mean **replaces** the filter
 *   instead of dragging it, so a laptop waking up cannot bias the answer;
 * - otherwise the sample joins the weighted mean, and the mean's weight is
 *   decimated so the window of memory stays `MAX_WEIGHT`.
 */
export function estimateOffset(sample: Sample, previous: OffsetEstimate): OffsetEstimate {
  const weight = weightFor(sample.rtt)
  const jumped = previous.samples > 0 && Math.abs(sample.offset - previous.offset) > JUMP_RESET_MS
  if (previous.samples === 0 || jumped) {
    return { offset: sample.offset, rtt: sample.rtt, samples: 1, weight }
  }

  // The new sample is never decimated: a mean that cannot move is not a filter.
  const kept = Math.min(previous.weight, Math.max(0, MAX_WEIGHT - weight))
  const total = kept + weight
  return {
    offset: (previous.offset * kept + sample.offset * weight) / total,
    rtt: sample.rtt,
    samples: previous.samples + 1,
    weight: total,
  }
}

/**
 * §6.1: `authorityNow() = Date.now() + offset`. The caller supplies its own
 * `Date.now()` (here, through the dev skew) because this module keeps no clock;
 * the loops measure their intervals on `performance.now()`, which no clock step
 * disturbs.
 */
export function authorityNow(localNowMs: number, estimate: OffsetEstimate): number {
  return localNowMs + estimate.offset
}
