/**
 * T7a item 1: a player with no DOM and no `<video>` — the four numbers §5's
 * `report` carries, plus a clock the tests can bend.
 *
 * It never computes a position of its own. Where the playhead is comes from
 * `expected()` in `src/shared/timing.ts` (AGENTS.md: the timing maths lives
 * only there), and the clock-to-authority conversion from `authorityNow()`, so
 * an injected skew is handled by the same arithmetic the page uses.
 */

import type { Playback } from '../../src/shared/protocol.ts'
import { authorityNow, expected, type OffsetEstimate, emptyEstimate } from '../../src/shared/timing.ts'

/** The real wall clock the fake ones are measured against (never faked). */
const wall = (): number => Date.now()

export interface FakeClockOptions {
  /** Millis this clock reads **slow** — T5's `?clockSkew=<ms>` meaning. */
  skewMs?: number
  /** Millis late this client's player hears about a frame it has received. */
  delayMs?: number
  /** The real clock underneath; `Date.now` unless a test brings its own. */
  wall?: () => number
}

/**
 * A machine clock that can be wrong on purpose, with the sign the project
 * already uses (T5): positive `skewMs` means this clock reads *behind* the
 * authority, so the offset it should estimate is `+skewMs`.
 */
export class FakeClock {
  skewMs: number
  delayMs: number
  #wall: () => number

  constructor(options: FakeClockOptions = {}) {
    this.skewMs = options.skewMs ?? 0
    this.delayMs = options.delayMs ?? 0
    this.#wall = options.wall ?? wall
  }

  /** What this machine's clock says now, in millis. */
  now(): number {
    return this.#wall() - this.skewMs
  }
}

export interface FakePlayerOptions {
  clock?: FakeClock
  /** `member.timelineOffset` is 0 in M1 (§4.5); it is carried, not used. */
  duration?: number
  readyState?: number
  /** The client's clock estimate, read at the instant a position is needed. */
  estimate?: () => OffsetEstimate
}

/**
 * A scripted player: it obeys `state` frames and nothing else (§4.3 invariant
 * 1), and it can be stalled without a browser to stall.
 */
export class FakePlayer {
  readonly clock: FakeClock
  duration: number
  playbackRate = 1
  readyState: number
  /** Seconds of media held ahead of the playhead — `report.buffered` (§5). */
  buffered = 0

  #estimate: () => OffsetEstimate
  /** The last `playback` it was told about, in the authority's instants. */
  #playback: Playback | null = null
  /** Where a stall froze it, and until when (this clock's millis). */
  #frozenAt: number | null = null
  #stallUntil = 0

  constructor(options: FakePlayerOptions = {}) {
    this.clock = options.clock ?? new FakeClock()
    this.duration = options.duration ?? 600
    this.readyState = options.readyState ?? 4
    this.#estimate = options.estimate ?? (() => emptyEstimate())
  }

  /** §6.2 read through this clock: the authority's instant, not the local one. */
  get currentTime(): number {
    if (this.#frozenAt !== null) return this.#frozenAt
    if (this.#playback === null) return 0
    const at = authorityNow(this.clock.now(), this.#estimate())
    return Math.max(0, Math.min(this.duration, expected(this.#playback, at)))
  }

  /** Applies one `state`'s playback, the only writer of where this player is. */
  apply(playback: Playback): void {
    this.#playback = { ...playback }
    this.playbackRate = playback.rate
  }

  /**
   * Stalls the player for `seconds` of its own clock: `readyState` drops to 2
   * and `currentTime` stops where it was, the way a buffering `<video>` does.
   *
   * It resumes **from the frozen frame**, not by jumping back onto the room's
   * timeline: a real stalled player starts playing again where it stopped and
   * is now the stall's length behind. That lag is what §6.3's ladder exists to
   * remove, so the fake player must keep it (T7b1).
   */
  injectStall(seconds: number): void {
    this.#frozenAt = this.currentTime
    this.#stallUntil = this.clock.now() + seconds * 1000
    this.readyState = 2
    const until = this.#stallUntil
    const timer = setTimeout(() => {
      if (this.#stallUntil !== until) return
      const resumedAt = this.#frozenAt ?? this.currentTime
      this.#frozenAt = null
      this.readyState = 4
      if (this.#playback !== null) {
        // Re-anchor the room timeline at the instant playback resumes, so the
        // player carries the frozen position forward instead of snapping.
        this.#playback = {
          ...this.#playback,
          position: resumedAt,
          updatedAt: authorityNow(this.clock.now(), this.#estimate()),
        }
      }
    }, seconds * 1000)
    timer.unref?.()
  }

  /** §5's `report` payload, from the member's own measurements. */
  report(): { position: number; readyState: number; buffered: number; rate: number; duration: number } {
    return {
      position: this.currentTime,
      readyState: this.readyState,
      buffered: this.buffered,
      rate: this.playbackRate,
      duration: this.duration,
    }
  }
}
