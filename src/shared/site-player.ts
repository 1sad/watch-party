/**
 * `spec.md` §6.2, §6.3, §6.6 and ADR-029: the site view's half of the room, as
 * pure functions (T06). `player.ts` elects the element; this decides what the
 * room asks that element to do, and whether one of its events is ours.
 *
 * The file-mode adapter is `ui/Player.svelte`, and this is the same shape: a
 * `state` frame goes in, the one write it asks for comes out; an event goes in,
 * and §6.6's set says whether it was ours. The difference is that the element
 * lives in another control and is reached through the host's relay, so the
 * command is a message and the echo entry is recorded here, before the message
 * leaves — strictly before the element can be touched.
 *
 * No DOM and no clock of its own: instants go in, answers come out, so
 * `node --test` drives all of it.
 */

import type { CommandFrame, Playback, PlaybackReason, ReportFrame } from './protocol.ts'
import type { PlayerCandidate, PlayerReason } from './player.ts'
import {
  SEEK_AHEAD_SECONDS,
  SEEK_SKIP_SECONDS,
  expected,
  nudgeRateAt,
  nudgeSettled,
  type NudgeHold,
} from './timing.ts'
import { createEchoSet, type EchoKind } from './echo.ts'

/** Across frames, a player's identity is `(source, id)` — `player.ts`'s own key. */
export interface PlayerTarget {
  /** The frame's URL, as the host names the sender (`e.Source`). */
  source: string
  /** The element's id inside its own frame. */
  id: number
}

function keyOf(target: PlayerTarget): string {
  return `${target.source}\u0000${target.id}`
}

/**
 * §6.6's set, one per element. The file player has one `<video>` and can keep a
 * single set; a site has ads, preloads and the real player, and an entry left by
 * one element must never swallow another's event.
 */
export interface SiteEchoes {
  /** Record the events `entries` are about to cause, before the command is posted. */
  expect(target: PlayerTarget, entries: readonly EchoEntry[]): void
  /**
   * True and consumed when this event is one of ours; false means it is real.
   *
   * T21: `position` is the event's own `currentTime`. A `seeked` at the position
   * this element was last moved **to** is ours even when it lands after §6.6's
   * window — 09b measured a replaced mirror firing it 2.33 s after the write, past
   * both that window and the bridge's own `caused` entry, and the seek that
   * landed was still the one the page performed to get on the room's position
   * (ADR-029). A listen-for-the-event entry cannot carry that: it is a guess
   * about *when*, and a slow mirror does not keep the appointment.
   */
  consume(target: PlayerTarget, kind: EchoKind, atMs: number, position?: number): boolean
  /**
   * Forget what `target` still owes (T15). One plan is in flight per element and
   * a newer command supersedes it, so a cancelled hold's predicted `play` cannot
   * sit here and swallow the person's next real one.
   */
  clear(target: PlayerTarget): void
}

/** One event a command will cause, and the instant it is expected. */
export interface EchoEntry {
  kind: EchoKind
  atMs: number
  /**
   * For `seeked`, the media position the write aimed at (T21). The event's own
   * `t` is matched against it, so a seek that lands late is still claimed.
   */
  t?: number
}

export function createSiteEchoes(): SiteEchoes {
  const sets = new Map<string, ReturnType<typeof createEchoSet>>()
  /**
   * The positions this element was moved to, per key: one write, one landing
   * (T21). Each is honoured for as long as the app calls an alignment overdue —
   * past that the write is not coming, and a person's seek to the same place is
   * theirs again.
   */
  const seeks = new Map<string, Array<{ t: number; atMs: number }>>()
  return {
    expect(target, entries) {
      const key = keyOf(target)
      let set = sets.get(key)
      if (set === undefined) {
        set = createEchoSet()
        sets.set(key, set)
      }
      for (const entry of entries) {
        set.expect(entry.kind, entry.atMs)
        if (entry.kind === 'seeked' && typeof entry.t === 'number') {
          const declared = seeks.get(key)
          if (declared === undefined) seeks.set(key, [{ t: entry.t, atMs: entry.atMs }])
          else declared.push({ t: entry.t, atMs: entry.atMs })
        }
      }
    },
    consume(target, kind, atMs, position) {
      const key = keyOf(target)
      const set = sets.get(key)
      if (kind === 'seeked' && typeof position === 'number') {
        const live = (seeks.get(key) ?? []).filter((one) => atMs - one.atMs < ALIGN_TOLERANCE_MS)
        if (live.length === 0) seeks.delete(key)
        else seeks.set(key, live)
        const index = live.findIndex((one) => Math.abs(one.t - position) <= SEEK_SKIP_SECONDS)
        if (index !== -1) {
          live.splice(index, 1)
          // The predict-the-instant entry this write also left has done its job.
          if (set !== undefined) set.consume('seeked', atMs)
          return true
        }
      }
      return set === undefined ? false : set.consume(kind, atMs)
    },
    clear(target) {
      sets.delete(keyOf(target))
      seeks.delete(keyOf(target))
    },
  }
}

/**
 * One write the page is asked to make. `kind` is what the host routes on: a
 * `playerCommand` goes to the frame named by `source`, because a cross-origin
 * player frame is not reachable from the top document (T01b's measurement).
 */
export interface PlayerPageCommand {
  kind: 'playerCommand'
  /** `PlayerTarget.source` and the frame's own `location.href`, both: the first routes, the second guards. */
  source: string
  href: string
  id: number
  /**
   * §5's reason, carried so the one `player:` line names the same state the room
   * sent. Absent for a rate, which no `state` asked for — the ladder is its own
   * reason (§6.3).
   */
  reason?: PlaybackReason
  action: 'play' | 'pause' | 'seek' | 'rate'
  /** Media seconds to put in `currentTime` first; absent when the element is already there. */
  target?: number
  /** Millis to the beat, for §6.4's scheduled start; absent means now. */
  leadMs?: number
  /** For a seek the room plays through: `play()` once the seek is done. */
  resume?: boolean
  /**
   * For `action: 'rate'` (T14): the `playbackRate` to write. §6.3's nudge and
   * its restore to 1 are the only reasons this is ever present.
   */
  rate?: number
  /**
   * The room's revision the `state` carried. Nothing on the page orders by it —
   * the relay delivers in order — but the command is the state's own number, so
   * a reader of a message can tell which room state produced it. Absent for a
   * rate, which no room state carried.
   */
  revision?: number
}

/** A command and the §6.6 events it will cause, which the caller records before posting. */
export interface PagePlan {
  command: PlayerPageCommand
  echoes: EchoKind[]
  /** Millis from now to the beat (§6.4), or 0 when the command is applied at once. */
  beatMs: number
}

/**
 * The instants to record a plan's echoes at, on the caller's own monotonic clock.
 * A scheduled play's event arrives at the **beat**, up to 1.5 s after the
 * command, so its echo entry is recorded for that instant rather than for now
 * — `echo.ts` expires an entry a second after the instant it names, and an
 * entry recorded for "now" would be gone before the play it describes.
 */
export function echoEntries(plan: PagePlan, localNowMs: number): EchoEntry[] {
  const target = plan.command.target
  return plan.echoes.map((kind) => ({
    kind,
    atMs: kind === 'play' && plan.beatMs > 0 ? localNowMs + plan.beatMs : localNowMs,
    // T21: a seek also declares *where* it went, which is what a slow mirror's
    // late `seeked` is matched on.
    ...(kind === 'seeked' && typeof target === 'number' ? { t: target } : {}),
  }))
}

/**
 * What a `state` frame asks the elected element to do. `null` means nothing:
 * no player has been elected yet, or the write would change nothing.
 *
 * §4.3 invariant 9's skip applies here too (`SEEK_SKIP_SECONDS`): a target the
 * element is already at (within §5's 0.3 s window) is the second arrival of a
 * move that already happened, so no `currentTime` is written. The echo list is
 * the events the write will really cause, judged from the element's last report
 * — the report the election itself keeps — because §6.6's set must hold the
 * event before it can arrive.
 */
export function planFromState(
  playback: Playback,
  revision: number,
  reason: PlaybackReason,
  elected: PlayerCandidate | null,
  nowMs: number,
): PagePlan | null {
  if (elected === null) return null

  const startAt = playback.startAt
  const scheduled =
    playback.playing && typeof startAt === 'number' && Number.isFinite(startAt) && startAt > nowMs
  const target = expected(playback, scheduled ? startAt : nowMs)
  const leadMs = scheduled ? startAt - nowMs : undefined
  const offTarget =
    elected.readyState >= 1 && Math.abs(elected.t - target) > SEEK_SKIP_SECONDS
  const first = { source: elected.source, href: elected.href, id: elected.id, reason, revision }

  if (!playback.playing) {
    if (reason === 'seek') {
      // §6.3's paused snap: a targeted `state` moves the playhead and nothing else.
      if (!offTarget) return null
      return {
        command: { ...first, kind: 'playerCommand', action: 'seek', target },
        echoes: ['seeked'],
        beatMs: 0,
      }
    }
    // A pause is not a seek: the room's position is where the presser was, and a
    // window a little behind is the ladder's to fix, not a second jump here.
    return {
      command: { ...first, kind: 'playerCommand', action: 'pause' },
      echoes: elected.paused ? [] : ['pause'],
      beatMs: 0,
    }
  }

  // A playing room. Two things can be needed: the playhead moved (`offTarget`),
  // and/or the element must be *playing* at the beat. §6.4 says never "play
  // now": a scheduled state is preceded by a hold, so an element that is
  // already playing is paused and started again at the beat — exactly what the
  // file adapter does, and why the window that pressed play does not run a
  // second and a half ahead of everyone else.
  const needsSeek = offTarget
  const mustPlay = scheduled || elected.paused
  if (!needsSeek && !mustPlay) return null

  return {
    command: {
      ...first,
      kind: 'playerCommand',
      action: needsSeek ? 'seek' : 'play',
      ...(needsSeek ? { target, resume: true } : {}),
      ...(leadMs === undefined ? {} : { leadMs }),
    },
    echoes: [
      ...(scheduled && !elected.paused ? (['pause'] as const) : []),
      ...(needsSeek ? (['seeked'] as const) : []),
      ...(mustPlay ? (['play'] as const) : []),
    ],
    beatMs: leadMs ?? 0,
  }
}

/**
 * T07, ADR-029 rule 1: what a **newly elected** player is asked, before it is
 * allowed to say anything to the room. The room's expected position, written
 * into the page whatever the page chose — the page's own `currentTime` is never
 * adopted. This is `planFromState`'s sibling with one difference: a paused room
 * carries the target too, because a player that has just appeared is at 0, and
 * the only thing allowed to start there is a new film (§5's `pageCommitted`).
 *
 * A `readyState` below 1 is still a seek if the position is off: an element
 * with no metadata reports `t = 0` whether it is at the beginning or not, and a
 * `currentTime` written before metadata becomes the default start position.
 *
 * The reason is the caller's last `state`, so the one `player: applied` line
 * names the room state that asked for the apply rather than a word invented
 * here.
 */
export function realignPlan(
  playback: Playback,
  revision: number,
  reason: PlaybackReason,
  elected: PlayerCandidate | null,
  nowMs: number,
): PagePlan | null {
  if (elected === null) return null

  const startAt = playback.startAt
  const scheduled =
    playback.playing && typeof startAt === 'number' && Number.isFinite(startAt) && startAt > nowMs
  const target = expected(playback, scheduled ? startAt : nowMs)
  const leadMs = scheduled ? startAt - nowMs : undefined
  const offTarget = elected.readyState < 1 || Math.abs(elected.t - target) > SEEK_SKIP_SECONDS
  const first = { source: elected.source, href: elected.href, id: elected.id, reason, revision }

  if (!playback.playing) {
    // §6.3's paused row, and the target with it: the playhead snaps and the
    // element stops. The bridge writes `target` for a pause as well, so one
    // command covers an autoplaying page that has to be moved and stopped.
    const mustPause = !elected.paused
    if (!offTarget && !mustPause) return null
    return {
      command: { ...first, kind: 'playerCommand', action: 'pause', ...(offTarget ? { target } : {}) },
      echoes: [...(offTarget ? (['seeked'] as const) : []), ...(mustPause ? (['pause'] as const) : [])],
      beatMs: 0,
    }
  }

  // A playing room: place the playhead, then play at the beat (§6.4). An
  // element the page started by itself is moved before it is allowed to run.
  const mustPlay = scheduled || elected.paused
  if (!offTarget && !mustPlay) return null
  return {
    command: {
      ...first,
      kind: 'playerCommand',
      action: offTarget ? 'seek' : 'play',
      ...(offTarget ? { target, resume: true } : {}),
      ...(leadMs === undefined ? {} : { leadMs }),
    },
    echoes: [
      ...(scheduled && !elected.paused ? (['pause'] as const) : []),
      ...(offTarget ? (['seeked'] as const) : []),
      ...(mustPlay ? (['play'] as const) : []),
    ],
    beatMs: leadMs ?? 0,
  }
}

/**
 * T14: §6.3's nudge for the site view — the file adapter's `held` hold, with
 * the element behind the bridge. The shape is `Player.svelte`'s on purpose: one
 * hold, one deadline, one watch, and **one owner of `playbackRate`**, so nothing
 * else writes a rate and nothing else restores one (§6.3's last rule).
 *
 * A rate is not a `state`: it never becomes a `PagePlan`, because §6.6's set is
 * about play/pause/seek and a rate has no event the room must hear. The caller
 * posts these commands *outside* `postToSite`, which would clear an element's
 * echo entries; and a `rate` event is already not a room command
 * (`decidePageEvent`), so this cannot become an outbound frame.
 *
 * The hold's bound is the frame's own `untilAuthorityMs` on this window's clock,
 * not a countdown started here: a nudge that arrives stale is never applied and
 * a hold cannot outlive its bound. The caller owns the timers — `step()` is what
 * a deadline and a watch tick both call, so the two cannot restore separately.
 */
export interface SiteNudge {
  /** The hold in force and the element it was written to, or null. */
  current(): { hold: NudgeHold; target: Pick<PlayerCandidate, 'source' | 'href' | 'id'> } | null
  /**
   * §6.3 from the authority: hold `rate` on the elected element until
   * `untilAuthorityMs`. A frame already past its bound, or a rate the ladder
   * never chooses, holds nothing and ends whatever was held (`nudgeRateAt`). No
   * elected element writes nothing; a newer nudge replaces an older one outright
   * rather than stacking a second deadline — only a *different* element needs
   * its old rate put back first.
   */
  apply(
    rate: number,
    untilAuthorityMs: number,
    elected: PlayerCandidate | null,
    nowMs: number,
  ): PlayerPageCommand[]
  /**
   * One watch tick. The restore comes out here when the bound has passed, and
   * when the gap is back under §6.3's deadband — the two ways a nudge ends
   * without a message. A replacement element cannot be judged against another
   * element's hold, so it never shortens one; the deadline still ends it.
   *
   * T21: `readingAgeMs` is how old `elected`'s numbers are — the element reports
   * at most once a second, and it is the last report, not a fresh look. The gap
   * belongs to the instant the numbers describe (`nowMs - readingAgeMs`), so the
   * age is not charged to the drift. Without that, a 1.151 s lead read as about
   * 0.2 s at a tick a second after its report, the rate went back to 1 four
   * seconds in, and 09b measured exactly that every five seconds for 100 s.
   */
  step(
    elected: PlayerCandidate | null,
    playback: Playback | null,
    nowMs: number,
    readingAgeMs: number,
  ): PlayerPageCommand[]
  /**
   * The room moved the playhead (a `state`: pause, seek or snap), so the rate
   * goes back to exactly 1 with it. Returns the restore once, then nothing.
   */
  end(): PlayerPageCommand[]
}

export function createSiteNudge(): SiteNudge {
  type Held = {
    hold: NudgeHold
    target: Pick<PlayerCandidate, 'source' | 'href' | 'id'>
  }
  let held: Held | null = null

  /** The one write this object makes, always aimed at the element it rated. */
  function write(rate: number): PlayerPageCommand[] {
    if (held === null) return []
    const total = held
    return [
      {
        kind: 'playerCommand',
        source: total.target.source,
        href: total.target.href,
        id: total.target.id,
        action: 'rate',
        rate,
      },
    ]
  }

  function end(): PlayerPageCommand[] {
    const commands = write(1)
    held = null
    return commands
  }

  function apply(
    rate: number,
    untilAuthorityMs: number,
    elected: PlayerCandidate | null,
    nowMs: number,
  ): PlayerPageCommand[] {
    const hold: NudgeHold = { rate, untilAuthorityMs }
    if (nudgeRateAt(hold, nowMs) !== hold.rate) return end()
    if (elected === null) return []

    // A newer nudge replaces an older one outright: two deadlines for one
    // element would let the first restore a rate the second just set. A hold on
    // a different element is restored first, so a swap cannot leave 1.05 behind.
    const previous = held
    const replaced =
      previous !== null &&
      (previous.target.source !== elected.source || previous.target.id !== elected.id)
    const restore = replaced ? end() : []
    held = { hold, target: { source: elected.source, href: elected.href, id: elected.id } }
    return [...restore, { kind: 'playerCommand', source: elected.source, href: elected.href, id: elected.id, action: 'rate', rate }]
  }

  function step(
    elected: PlayerCandidate | null,
    playback: Playback | null,
    nowMs: number,
    readingAgeMs: number,
  ): PlayerPageCommand[] {
    const current = held
    if (current === null) return []
    // The bound first: a late tick must not keep a stale rate alive.
    if (nudgeRateAt(current.hold, nowMs) !== current.hold.rate) return end()
    const target = current.target
    // T21: the reading describes an earlier instant, so the room's position is
    // taken there too (see `step`'s contract). A reading that is not this
    // element's says nothing about this hold.
    const readingAt = nowMs - Math.max(0, readingAgeMs)
    if (
      elected !== null &&
      playback !== null &&
      elected.source === target.source &&
      elected.id === target.id &&
      // T198: inside the deadband by a margin, not on its edge, so this holder
      // and the file player cannot disagree about where a nudge is "closed".
      nudgeSettled(elected.t - expected(playback, readingAt))
    ) {
      return end()
    }
    return []
  }

  return { current: () => held, apply, step, end }
}

/**
 * The room's tolerance for a follower that is visibly out of place, in
 * milliseconds — and the same quantity as §6.3's hard-seek threshold, past which
 * the ladder jumps rather than nudges, not a second 4. It is derived from
 * `SEEK_AHEAD_SECONDS`, the ladder's one home, so one edit moves both: an
 * alignment still outstanding after it is worth one line in the app view.
 */
export const ALIGN_TOLERANCE_MS = SEEK_AHEAD_SECONDS * 1000

/** Whether an alignment that started at `startedAtMs` has taken too long. */
export function alignmentOverdue(startedAtMs: number | null, nowMs: number): boolean {
  return startedAtMs !== null && nowMs - startedAtMs >= ALIGN_TOLERANCE_MS
}

/** What one report means for the follower (T07). */
export interface FollowerInput {
  /** The election's reason, `null` when the winner did not change. */
  reason: PlayerReason | null
  /** The report came from a document this window had not seen for that frame: a navigation completed. */
  newDocument: boolean
  /** ADR-032 as amended: a staged change is pending, so this page is a preview — not a follower. */
  previewPending: boolean
  /** This window was already waiting to put the elected player on the room. */
  unaligned: boolean
  playback: Playback | null
  revision: number
  /** The last `state`'s reason, which the apply's one line repeats. */
  stateReason: PlaybackReason
  elected: PlayerCandidate | null
  nowMs: number
}

export interface FollowerStep {
  /** The apply to make: record its echoes, then post it. `null` when nothing needs writing. */
  realign: PagePlan | null
  /** Whether §5's `report` may go to the room from this page yet. */
  report: boolean
  /** Carried into the next step. */
  unaligned: boolean
}

/**
 * T07's one rule, in one place: a player that has just been elected, or whose
 * document has just navigated, is **unaligned**. It is put on the room's
 * position first, and the first report the ladder sees is the one after that.
 * The page's own position is never sent, so it can never be adopted (ADR-029
 * rule 1). A pending preview is the exception ADR-032 keeps: it is not a
 * follower until the commit, and the commit's own page starts the wait.
 */
export function followerStep(input: FollowerInput): FollowerStep {
  if (input.previewPending) {
    // No apply and no report from a preview; the flag is left as it was so the
    // committed page still has to be found and realigned.
    return { realign: null, report: false, unaligned: input.unaligned }
  }

  const waiting = input.unaligned || input.reason !== null || input.newDocument
  if (!waiting) return { realign: null, report: true, unaligned: false }

  // Nothing to aim at yet: no room state, or nobody elected. Keep waiting and
  // keep quiet — a position measured on the page is not the room's.
  if (input.playback === null || input.elected === null) {
    return { realign: null, report: false, unaligned: true }
  }

  return {
    realign: realignPlan(input.playback, input.revision, input.stateReason, input.elected, input.nowMs),
    report: false,
    unaligned: false,
  }
}

/** A `play`/`pause`/`seeked` the page actually fired, as the bridge posts it. */
export interface PlayerActionEvent extends PlayerTarget {
  /**
   * `play`, `pause`, `seeked` — and `rate`, which is a kind the bridge's flag
   * covers but the room has no command for (§6.3's rate is the ladder's own).
   */
  event: EchoKind | 'rate'
  /** The element's `currentTime` at the event. */
  t: number
  /** For `seeked`: whether the element was playing when the seek began (§5's `wasPlaying`). */
  wasPlaying?: boolean
  /**
   * T15: `true` when the bridge's own write caused this event, `false` or absent
   * when a person or the page did. This is the frame's own provenance, and it
   * decides before anything predicted from a report.
   */
  caused?: boolean
  /**
   * T17: `true` when the element was no longer in its document when the event
   * fired. That is the browser's own pause for an element the page removed — Blink
   * runs `RemovedFrom` -> `OnRemovedFromDocumentTimerFired`, which pauses only an
   * element that is *not* connected — so it is the page's DOM change, not a press,
   * and `caused` is false for it. Sent only when true, so every other message keeps
   * its shape.
   */
  detached?: boolean
}

export type PageDecision =
  | { kind: 'ignore' }
  | { kind: 'echo' }
  /** A person's action on the room's controller: this becomes a room command. */
  | { kind: 'send'; command: CommandFrame }
  /** Anyone else's: not broadcast; the room's own position is put back instead. */
  | { kind: 'correct' }

/**
 * §6.6, at the one place a page event can become a room command. An event whose
 * `(source, id)` is not the elected player is ignored — an ad playing in a
 * neighbouring frame is not somebody's pause. An event the bridge says it caused
 * is the room's, so it is dropped, and so is the pause a removed element fires
 * (T17: the page moved its own DOM, nobody pressed); one no echo entry and no
 * flag accounts for is
 * a person: the controller's becomes a `play`/`pause`/`seek`, and anybody else's
 * is answered by re-applying the room (ADR-030: one writer, and a follower that
 * drifted is corrected rather than obeyed).
 */
export function decidePageEvent(
  event: PlayerActionEvent,
  elected: PlayerCandidate | null,
  echoes: SiteEchoes,
  nowMs: number,
  canControl: boolean,
): PageDecision {
  if (elected === null || elected.source !== event.source || elected.id !== event.id) {
    return { kind: 'ignore' }
  }
  const target = { source: event.source, id: event.id }
  // T17: a removal is not a pause. A playing element the page takes out of the
  // DOM is paused by the browser itself (Blink pauses a *detached* element), and
  // 07b measured the room taking that pause as a person's 7 ms after a mirror
  // switch. The bridge's `detached` names the element gone, so this is the page's
  // change, dropped like any other event of ours. It is decided before the press
  // rule below, which still has every connected element: a person who presses
  // pause just before a swap was connected when they pressed, so their pause is
  // still the room's.
  if (event.event === 'pause' && event.detached === true) return { kind: 'echo' }
  // T15: the bridge's own provenance is asked first, because it was measured on
  // the element by the frame that moved it — right even when the report the plan
  // was built from is half a second old. That is the play press whose hold is
  // the app's pause, not a second person's. The set is still spent, so an entry
  // this event has just made good cannot sit here and swallow a person's next.
  const predicted = event.event === 'rate' ? false : echoes.consume(target, event.event, nowMs, event.t)
  if (event.caused === true || predicted) return { kind: 'echo' }
  // A rate is not a room command: §6.3's rate is the ladder's own, and ADR-030
  // keeps a personal speed in this window. Only `caused` has anything to say.
  if (event.event === 'rate') return { kind: 'ignore' }
  if (!canControl) return { kind: 'correct' }
  if (event.event === 'seeked') {
    return {
      kind: 'send',
      command: { type: 'seek', position: event.t, wasPlaying: event.wasPlaying === true },
    }
  }
  return { kind: 'send', command: { type: event.event, position: event.t } }
}

/**
 * What the elected element just reported, in the fields §5's `report` and the
 * `player: drift` line need. The bridge measures these on the element itself;
 * `paused` is carried because a site's own pause is a real state the room must
 * hear about, and because a report from a paused element is not a playing one.
 */
export interface PlayerReading {
  t: number
  paused: boolean
  readyState: number
  buffered: number
  rate: number
}

/**
 * §5's `report`, from the elected element's own numbers. The field names are
 * the point: `t` becomes `position`, `buffered` and `rate` pass through, and
 * `paused` stays here — the frame has no such field, and the room learns of a
 * pause as the `pause` command it caused, not as a measurement.
 */
export function reportFromPlayer(
  reading: PlayerReading,
  extras: { duration?: number; origin?: string; rtt: number },
): ReportFrame {
  const frame: ReportFrame = {
    type: 'report',
    position: reading.t,
    readyState: reading.readyState,
    buffered: reading.buffered,
    rate: reading.rate,
    rtt: extras.rtt,
  }
  if (extras.duration !== undefined) frame.duration = extras.duration
  if (extras.origin !== undefined) frame.origin = extras.origin
  return frame
}

/** How often one `player: drift` line may be written, whatever the report rate. */
export const PLAYER_DRIFT_LOG_INTERVAL_MS = 1000

/** One report's three numbers, for the line 09 quotes the worst of. */
export interface DriftReading {
  /** `expected(playback, now)`, media seconds. */
  expected: number
  /** The element's own `currentTime`, media seconds. */
  actual: number
  /** `actual - expected` in whole millis: positive is ahead of the room. */
  deltaMs: number
}

export function driftFromPlayer(reading: PlayerReading, playback: Playback, nowMs: number): DriftReading {
  const target = expected(playback, nowMs)
  return { expected: target, actual: reading.t, deltaMs: Math.round((reading.t - target) * 1000) }
}

/** True when the next report may write a drift line; at most one a second (§6). */
export function driftLogDue(lastAtMs: number | null, nowMs: number): boolean {
  return lastAtMs === null || nowMs - lastAtMs >= PLAYER_DRIFT_LOG_INTERVAL_MS
}
