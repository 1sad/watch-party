/**
 * `spec.md` §10.1's frame election, as pure functions (T05).
 *
 * A page has several videos — ads, hidden preloads, parked mirrors — and on 6 of
 * 11 sites E2 tested the real one is in a cross-origin frame. The bridge
 * (`player-bridge.js`, injected into every frame of the site view) reports what
 * each frame can see; these functions score those reports and keep one winner.
 * No DOM here on purpose: this is the half that can be tested without a browser,
 * and the only half that decides anything.
 */

/**
 * The only two kinds the bridge may post. The host's relay refuses every other
 * kind (`MainForm.RelaySiteEvent`), because a page can run this script too —
 * ADR-038's cost note.
 */
export const PLAYER_MESSAGE_KINDS = ['playerReport', 'playerEvent'] as const

/** One `<video>` as its own frame reported it. `id` is that frame's stable number for the element. */
export interface FrameCandidate {
  id: number
  /** The element's visible box in CSS pixels: 0 on either axis is the hidden-preload case. */
  w: number
  h: number
  readyState: number
  hasSrc: boolean
  playing: boolean
  /** 0 when the element has no duration yet, or a live stream's Infinity. */
  duration: number
  /** The element's own `currentTime`, which 06 reports and corrects against the room. */
  t: number
  /**
   * The three fields §5's `report` needs beyond `t` and `readyState` (T06):
   * whether the element is paused, its buffered end and its own rate. Optional
   * in the type because the election never reads them, but the bridge always
   * sends them, and the report the room receives is made from them.
   */
  paused?: boolean
  buffered?: number
  rate?: number
}

/** What one frame posts, plus where it came from and when it was heard. */
export interface FrameReport {
  /** The frame document's URL, as the host reports the sender (`e.Source`). */
  source: string
  /** The frame's own `location.href`, which the line names. */
  href: string
  seq: number
  candidates: readonly FrameCandidate[]
  /** This window's clock, for {@link PLAYER_REPORT_TTL_MS}. */
  receivedAt: number
}

/** A candidate with the frame it lives in: across frames, identity is `(source, id)`. */
export interface PlayerCandidate extends FrameCandidate {
  source: string
  href: string
}

/** §7.1: the four ways a winner is chosen. */
export type PlayerReason = 'appeared' | 'removed' | 'replaced' | 'outscored'

/** §7.1: an element that reloads its source after it was playing is a new player in the same slot. */
export type PlayerEventKind = 'emptied' | 'loadstart'

export interface PlayerEvent {
  source: string
  id: number
  event: PlayerEventKind
  t: number
}

/** A frame that stops reporting is gone: its videos are not candidates any more. */
export const PLAYER_REPORT_TTL_MS = 5000

export interface Election {
  /** The winner as the latest report describes it, or null when nothing on the page is a player. */
  elected: PlayerCandidate | null
  /**
   * Why the winner changed. `null` means nothing changed, and that is the
   * distinction the one `player:` line is written on.
   */
  reason: PlayerReason | null
  score: number
}

/**
 * §10.1's order, as one number: visible area first, then `readyState >= 3`, then
 * having a source, then currently playing. The lower three only break an area
 * tie, which is why they are worth 4, 2 and 1 against an area that steps by 8.
 *
 * A 0×0 (or hidden) video scores 0 and can never be elected: that is §10.1's
 * hidden-preload case, and "a hidden candidate never wins" is tested.
 */
export function scoreCandidate(
  candidate: Pick<FrameCandidate, 'w' | 'h' | 'readyState' | 'hasSrc' | 'playing'>,
): number {
  const area = candidate.w > 0 && candidate.h > 0 ? candidate.w * candidate.h : 0
  if (area === 0) return 0
  return area * 8
    + (candidate.readyState >= 3 ? 4 : 0)
    + (candidate.hasSrc ? 2 : 0)
    + (candidate.playing ? 1 : 0)
}

/** `(source, id)`: two frames can each have an element 1, and they are not the same video. */
function identity(candidate: Pick<PlayerCandidate, 'source' | 'id'>): string {
  return `${candidate.source}\u0000${candidate.id}`
}

/**
 * Every live frame's candidates as one list. A frame whose last report is older
 * than {@link PLAYER_REPORT_TTL_MS} contributes nothing — the bridge reports at
 * least once a second, so a silent frame is a frame that went away, and its
 * videos have to stop holding the election.
 */
export function mergeReports(reports: Iterable<FrameReport>, now: number): PlayerCandidate[] {
  const merged: PlayerCandidate[] = []
  for (const report of reports) {
    if (now - report.receivedAt > PLAYER_REPORT_TTL_MS) continue
    for (const candidate of report.candidates) {
      merged.push({ ...candidate, source: report.source, href: report.href })
    }
  }
  return merged
}

/**
 * §10.1: keep the winner; re-elect only when it disappears, is replaced in its
 * own slot, or is outscored. A tie keeps the incumbent, so two equal ads do not
 * make the election flip back and forth.
 *
 * `events` are what the frames posted since the last election. An
 * `emptied`/`loadstart` on the incumbent counts only if the incumbent was
 * playing: a preload that starts loading before playback is not a replacement.
 */
export function elect(
  previous: PlayerCandidate | null,
  candidates: readonly PlayerCandidate[],
  events: readonly PlayerEvent[] = [],
): Election {
  const incumbent = previous === null ? null : identity(previous)
  const replaced = incumbent !== null && previous !== null && previous.playing
    && events.some((event) => identity(event) === incumbent)

  let winner: PlayerCandidate | null = null
  let winnerScore = 0
  for (const candidate of candidates) {
    if (replaced && identity(candidate) === incumbent) continue
    const score = scoreCandidate(candidate)
    if (score === 0) continue
    if (winner === null || score > winnerScore) {
      winner = candidate
      winnerScore = score
      continue
    }
    // A tie keeps the incumbent: equal scores never move the election.
    if (score === winnerScore && identity(candidate) === incumbent) {
      winner = candidate
    }
  }

  if (previous === null) {
    return winner === null
      ? { elected: null, reason: null, score: 0 }
      : { elected: winner, reason: 'appeared', score: winnerScore }
  }

  if (replaced) return { elected: winner, reason: 'replaced', score: winnerScore }
  if (winner !== null && identity(winner) === incumbent) {
    // Same element, and the current reading of it: a winner that was elected
    // before it had a source must still be recognised as playing when the page
    // later reloads it (05b measured the placeholder case on bingebang.sx).
    return { elected: winner, reason: null, score: winnerScore }
  }
  // Gone from its frame's own DOM: the element was removed (a mirror switch
  // that rebuilds the player), so whatever is left is a fresh election.
  if (!candidates.some((candidate) => identity(candidate) === incumbent)) {
    return { elected: winner, reason: 'removed', score: winnerScore }
  }
  // Still there, still a player, and something else now scores higher.
  if (winner !== null) return { elected: winner, reason: 'outscored', score: winnerScore }

  // Nothing scores at all now. If the incumbent is still in the DOM it has
  // stopped being a player (0×0, source gone); either way the player we had is
  // gone, which is the `removed` case.
  return { elected: null, reason: 'removed', score: 0 }
}
