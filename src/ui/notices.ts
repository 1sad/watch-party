/**
 * ADR-049: the room's transient lines are notices, not chat.
 *
 * A notice is a line the page raises about the person's own state - chat is
 * muted for ten seconds, the flood warning, the site's player has not caught up,
 * this window was put back - drawn between the messages and the input. It is
 * never a `ChatMessage`: it does not enter the ring buffer, it is not replayed
 * to a late joiner, and it does not scroll away with the messages.
 *
 * The decision kept here is the one a picture cannot check twice - **when the
 * line goes** - so it lives in a module a unit test can hold, the same
 * arrangement as `popup-notice.ts` and `preview.ts` in this folder. Ticket 147
 * reuses it for the put-back line, so the shape is the contract:
 *
 * - `until` is an instant on the page's own clock (`performance.now()`): the
 *   line is gone at that instant, whether or not anyone is looking. The mute is
 *   timed from the server's `retryAfterMs`, so the window the sidecar began is
 *   the window this page counts.
 * - `when` is a condition re-checked on every tick: the line **stays while it
 *   is true** and goes the first tick it is false. The condition is therefore
 *   the state the line is about, not its end - "this window is still waiting"
 *   for the sync line, "the room is still on that page" for the put-back, "no
 *   message has been accepted since" for the flood warning. A notice may carry
 *   both `until` and `when`, and is removed by whichever end arrives first.
 * - `dismiss` is the person's own end, at once. Every notice can be dismissed;
 *   nothing else on screen is a demand, so the line never becomes one.
 */

/** One line between the messages and the input. */
export interface Notice {
  /** Stable name for this line (`mute`, `flood`, `align`, `putback`): raising
   *  it again replaces it rather than stacking a second copy. */
  id: string
  /** The sentence as shown; ASCII is not required, the page renders it. */
  text: string
  /** Gone at this instant (the page's clock), or never, when absent. */
  until?: number
  /** Gone the first tick this returns false, or never, when absent. */
  when?: () => boolean
}

/**
 * One notice raised. A notice already on screen under the same `id` is replaced
 * in place - the news is the sentence, not a count - so a condition that fires
 * twice an evening cannot leave two lines saying the same thing.
 */
export function raiseNotice(list: Notice[], notice: Notice): Notice[] {
  const at = list.findIndex((entry) => entry.id === notice.id)
  if (at === -1) return [...list, notice]
  const next = list.slice()
  next[at] = notice
  return next
}

/** The person's dismiss: the line with this id is gone now, and only it. */
export function dismissNotice(list: Notice[], id: string): Notice[] {
  if (!list.some((entry) => entry.id === id)) return list
  return list.filter((entry) => entry.id !== id)
}

/**
 * One tick of the lifetime: every notice whose end has arrived is dropped. The
 * same array comes back when nothing ended, so the caller can leave the DOM (and
 * the person's scroll position) exactly where it is.
 */
export function reapNotices(list: Notice[], now: number): Notice[] {
  const kept = list.filter(
    (entry) =>
      (entry.until === undefined || now < entry.until) && (entry.when === undefined || entry.when()),
  )
  return kept.length === list.length ? list : kept
}
