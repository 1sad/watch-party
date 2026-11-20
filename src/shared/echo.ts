/**
 * `spec.md` §6.6: a programmer's `play()`, `pause()` and `currentTime=` fire the
 * same events as a person clicking. This is the set that absorbs our own.
 *
 * The rule, in full: before the player calls `play()`, `pause()` or sets
 * `currentTime`, it puts the event it is about to cause in this set; the event
 * handler consumes it and returns without sending a command. One entry, one
 * event — and an entry that is never claimed expires, because an event the
 * browser coalesced or dropped must not swallow the *next* real one, one second
 * later, and turn a person's pause into a no-op.
 *
 * No DOM here and no clock of its own: instants go in, the answer comes out, so
 * `node --test` can drive it without a window (the same shape as `timing.ts`).
 */

/** §6.6's "~1 s". The number lives here so the player cannot invent a second one. */
export const ECHO_EXPIRY_MS = 1000

/** The three events a room command can be mistaken for (§6.6). */
export type EchoKind = 'play' | 'pause' | 'seeked'

export interface EchoSet {
  /** Record the event `play()/pause()/currentTime=` is about to cause, at this instant. */
  expect(kind: EchoKind, atMs: number): void
  /** True and consumed when this event is one of ours; false means it is real. */
  consume(kind: EchoKind, atMs: number): boolean
}

/** See `docs/spec.md` §6.6. All instants are `performance.now()`, millis. */
export function createEchoSet(): EchoSet {
  let entries: Array<{ kind: EchoKind; at: number }> = []

  /** An entry older than the window is gone whether or not it was claimed. */
  const prune = (atMs: number): void => {
    entries = entries.filter((entry) => atMs - entry.at < ECHO_EXPIRY_MS)
  }

  return {
    expect(kind, atMs) {
      prune(atMs)
      entries.push({ kind, at: atMs })
    },

    consume(kind, atMs) {
      prune(atMs)
      const index = entries.findIndex((entry) => entry.kind === kind)
      if (index === -1) return false
      // Consumed once: the same kind twice is two of our calls or one ours and
      // one real; only an entry we put there may be spent.
      entries.splice(index, 1)
      return true
    },
  }
}
