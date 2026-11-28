/**
 * `spec.md` §6's arithmetic and nothing else (T5), plus §6.2's `expected()` and
 * §5's duplicate-seek window (T6a).
 *
 * Pure on purpose: no clock of its own, no socket, no I/O, no import from the
 * page or the sidecar. Instants go in as numbers and values come out, so the
 * page can run the loop and the tests can feed it a stopwatch they control.
 * §6 says it once, here (AGENTS.md: a number from this module that appears a
 * second time is a copy, and one of the two is wrong).
 */

import type { Member, Playback } from './protocol.ts'

/** §6.1: the `ping` every 5 s is both the liveness beat and the clock sample. */
export const PING_INTERVAL_MS = 5000

/** §5: `report` is a measurement every 3 s while playing (T7b1's cadence, T7b2 sends it). */
export const REPORT_INTERVAL_MS = 3000

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

/**
 * §5: "a seek within 0.3 s of current position is skipped". The window is what
 * turns a human seek plus the site's own echo into one move — the second
 * arrival is closer to where the room already is than to anything a person
 * could have meant.
 */
export const SEEK_SKIP_SECONDS = 0.3

/**
 * §6.2, the one function that says where the playhead is. `position` is where
 * it was at `updatedAt` (§4.3 invariant 3), so a playing room has moved on by
 * the elapsed time times the rate, and a paused room has not moved at all.
 *
 * §6.2's own line is `position + (now - updatedAt) / 1000 * rate`; the elapsed
 * time is held at zero here so a member whose clock is behind the authority's
 * never reads a position *before* the last one. Negative elapsed time is skew,
 * not a rewind.
 *
 * This is the only place a position is worked out: the authority uses it to
 * skip duplicate seeks, and the page (T6b) uses it to steer the player. A
 * second copy elsewhere is a bug even while it agrees (AGENTS.md).
 */
export function expected(playback: Playback, nowMs: number): number {
  if (!playback.playing) return playback.position
  const elapsedMs = Math.max(0, nowMs - playback.updatedAt)
  return playback.position + (elapsedMs / 1000) * playback.rate
}

/**
 * §5's idempotency rule for `seek`, in the one place that owns the window: a
 * target within `SEEK_SKIP_SECONDS` of where the room already expects the
 * playhead is the second arrival of a seek that already happened.
 */
export function seekIsDuplicate(playback: Playback, nowMs: number, target: number): boolean {
  return Math.abs(target - expected(playback, nowMs)) <= SEEK_SKIP_SECONDS
}

/**
 * §4.5: the two halves of the one offset sign. `targetFor` is where *this*
 * member's copy should be; `reportFrom` turns the member's own playhead back
 * into room time before it is compared. The offset is always 0 in M1 (file
 * mode), but the pair ships now because implementing the sign twice is the
 * silent, permanent desync §4.5 warns about.
 */
export function targetFor(
  playback: Playback,
  member: Pick<Member, 'timelineOffset'>,
  nowMs: number,
): number {
  return expected(playback, nowMs) + member.timelineOffset
}

export function reportFrom(position: number, member: Pick<Member, 'timelineOffset'>): number {
  return position - member.timelineOffset
}

/**
 * §6.4, corrected 2026-11-20: `now + max(2 × maxRtt, 1.5 s)`. The 1.5 s floor
 * dominates any group whose worst round trip is under 750 ms — which, on a
 * home LAN, is all of them. `maxRtt` is the largest `rtt` from §5's reports.
 */
export const MIN_SCHEDULED_START_MS = 1500

export function scheduledStartAt(nowMs: number, maxRttMs: number): number {
  return nowMs + Math.max(2 * Math.max(0, maxRttMs), MIN_SCHEDULED_START_MS)
}

/**
 * §4.5: every seek lands in `[0, duration − 0.25]`. The quarter second keeps a
 * player from seeking exactly to the end, where some browsers fire `ended`
 * before the room says to.
 */
export function clampToMedia(position: number, duration: number): number {
  const upper = Math.max(0, duration - 0.25)
  return Math.min(Math.max(0, position), upper)
}

/**
 * §6.3's numbers, in the one place they exist (AGENTS.md: a number from this
 * module that appears a second time is a copy). The bands are the spec's:
 *
 * | drift                    | action |
 * | < the deadband           | none   |
 * | deadband – 4 s           | nudge  |
 * | > 4 s, or > 1.75 behind  | seek   |
 * | paused                   | snap   |
 *
 * The deadband is a quarter of a second (ADR-039), not Syncplay's 0.1 s: a
 * healthy window sits 0.086-0.112 s behind, so 0.1 s fired on jitter alone.
 */
export const CORRECTION_DEADBAND_SECONDS = 0.25
export const SEEK_AHEAD_SECONDS = 4
export const SEEK_BEHIND_SECONDS = 1.75
/** §6.3: two consecutive bad reports before any correction. */
export const STRIKES_BEFORE_CORRECTION = 2
/** §6.3: at most one correction per client per 5 s. */
export const CORRECTION_SPACING_MS = 5000
export const SLOW_DOWN_RATE = 0.95
export const SPEED_UP_RATE = 1.05
/**
 * How often a held nudge is re-examined. It is a polling interval, not a §6.3
 * number: 200 ms is well inside the deadband's closing time (2 s at 5 %) and
 * cheap enough to run in every window. It lives here because both holders
 * (the file player and the site view, T14) watch their hold at this rate, and
 * two copies of a number is how they would come to disagree.
 */
export const NUDGE_WATCH_MS = 200

/**
 * Where a held nudge ends, in seconds: **inside** the deadband, not on its edge
 * (T198). ADR-039's deadband is untouched - this is the margin a correction
 * aims for once one has been decided, derived from the deadband so one edit
 * moves both.
 *
 * Measured on 2026-11-28 (T198): an Android media clock loses 0.24-0.33 s to
 * its start ramp on every scheduled start, so a phone lands on the line. A
 * client 0.26 s behind is nudged; the nudge closes at 5 %; and with the stop
 * test on the deadband itself the hold ends the instant the *client's* own
 * reading is under 0.25 s - on the edge, where the next report is a coin flip
 * whether the authority still reads it as bad. The gate run
 * (`evidence/181-report.md` §5) parked a phone at 0.255-0.277 s with `strikes`
 * climbing to 10 and a nudge every 5 s that closed nothing. Half the band
 * leaves ~0.13 s of margin for both readings, so one correction settles a
 * client instead of parking it on the line.
 */
export const NUDGE_SETTLE_SECONDS = CORRECTION_DEADBAND_SECONDS / 2

/**
 * True when a held nudge has done its job: the gap is inside the band by the
 * margin above. Both holders - the file player (`Player.svelte`) and the site
 * view (`site-player.ts`) - end their hold on this one answer, so the two cannot
 * disagree about where "closed" is. A gap that is not a number is never
 * settled: the hold's own bound is what restores that rate.
 */
export function nudgeSettled(gapSeconds: number): boolean {
  return Math.abs(gapSeconds) <= NUDGE_SETTLE_SECONDS
}

export type CorrectionAction = 'none' | 'nudge' | 'seek' | 'snap'

/**
 * One report's inputs to the ladder. `drift` is **signed seconds the member is
 * ahead of the room**: positive means its playhead is past `target`, so it must
 * slow down; negative means it is behind, so it must speed up. Keeping the sign
 * here, once, is what stops §4.5's two halves from disagreeing.
 */
export interface CorrectionInput {
  drift: number
  /** §6.3's paused row: a paused room snaps rather than nudges. */
  playing: boolean
  /** §6.7: `< 3` is buffering, and a rate change makes a starved client worse. */
  readyState: number
  /** Consecutive bad reports **including** the one being decided. */
  driftStrikes: number
  /** The authority instant of the last correction for this member, or `null`. */
  lastCorrectionAt: number | null
  nowMs: number
  /** Where the member's playhead should be now (`targetFor`). */
  target: number
}

export interface Correction {
  action: CorrectionAction
  /** The rate the member should hold: 0.95/1.05 for a nudge, 1 otherwise. */
  rate: number
  /** For a nudge, a seek or a snap: where the playhead belongs. */
  target?: number
  /** For a nudge: the authority instant by which it must be over (§6.3). */
  untilAuthorityMs?: number
}

/**
 * §6.3's table plus the three guards from the phase slice's §6:
 *
 * 1. two consecutive bad reports before correcting;
 * 2. at most one correction per client per 5 s;
 * 3. never nudge a client whose `readyState < 3` (§6.7).
 *
 * A paused member snaps only after those same guards: an unguarded snap on a
 * single stale report would let a report the room is about to overwrite move
 * one window (the existing "a raw report moves nothing" check). The buffering
 * branch returns `none` for a seek too: §6.7 says "correct only by hard seek at
 * an idle moment, or wait", and the authority cannot see idle, so it waits.
 *
 * The nudge's `untilAuthorityMs` is the time the member needs to close the gap
 * at the extra 5 %: `|drift| / 0.05` seconds from now. It is a bound, not the
 * primary stop — the page restores to 1.0 once the gap is inside the settle
 * margin (`nudgeSettled`).
 */
export function decideCorrection(input: CorrectionInput): Correction {
  const drift = Number.isFinite(input.drift) ? input.drift : 0
  if (Math.abs(drift) < CORRECTION_DEADBAND_SECONDS) return { action: 'none', rate: 1 }

  if (input.driftStrikes < STRIKES_BEFORE_CORRECTION) return { action: 'none', rate: 1 }
  if (
    input.lastCorrectionAt !== null &&
    input.nowMs - input.lastCorrectionAt < CORRECTION_SPACING_MS
  ) {
    return { action: 'none', rate: 1 }
  }

  if (!input.playing) return { action: 'snap', rate: 1, target: input.target }
  if (input.readyState < 3) return { action: 'none', rate: 1 }

  const behind = drift < 0
  const beyondNudge =
    Math.abs(drift) > SEEK_AHEAD_SECONDS || (behind && -drift > SEEK_BEHIND_SECONDS)
  if (beyondNudge) return { action: 'seek', rate: 1, target: input.target }

  const rate = behind ? SPEED_UP_RATE : SLOW_DOWN_RATE
  const untilAuthorityMs =
    input.nowMs + Math.ceil((Math.abs(drift) / Math.abs(rate - 1)) * 1000)
  return { action: 'nudge', rate, target: input.target, untilAuthorityMs }
}

/**
 * A nudge the page is holding: the rate to play at, and the authority instant by
 * which it must be over (`nudge.untilAuthorityMs`). This is the page's half of
 * T7b1's correction, and it is pure so the bound can be tested at exact instants
 * instead of by waiting.
 *
 * §6.3's last rule is "always restore `playbackRate = 1` afterwards", and the
 * safety line T7b2 has to keep is stronger: a *lost* restore cannot leave a
 * window sped up. So the deadline is the frame's own number on the authority's
 * clock, not a countdown the page starts on arrival — a message that arrives
 * already stale holds nothing, and a hold never survives its bound.
 */
export interface NudgeHold {
  /** One of `SLOW_DOWN_RATE` / `SPEED_UP_RATE`; anything else is refused. */
  rate: number
  /** Authority-clock instant the nudge is over by. */
  untilAuthorityMs: number
}

/** The rate in force at `nowMs`: the hold's rate before the bound, `1` at and after it. */
export function nudgeRateAt(hold: NudgeHold, nowMs: number): number {
  // A rate the ladder never chooses is not a nudge (§6.3: 0.95 or 1.05), and a
  // bound that is not a number cannot expire, so neither may be held.
  if (hold.rate !== SLOW_DOWN_RATE && hold.rate !== SPEED_UP_RATE) return 1
  if (!Number.isFinite(hold.untilAuthorityMs)) return 1
  return nowMs < hold.untilAuthorityMs ? hold.rate : 1
}
