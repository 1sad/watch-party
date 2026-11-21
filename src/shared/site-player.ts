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
import type { PlayerCandidate } from './player.ts'
import { SEEK_SKIP_SECONDS, expected } from './timing.ts'
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
  /** True and consumed when this event is one of ours; false means it is real. */
  consume(target: PlayerTarget, kind: EchoKind, atMs: number): boolean
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
}

export function createSiteEchoes(): SiteEchoes {
  const sets = new Map<string, ReturnType<typeof createEchoSet>>()
  return {
    expect(target, entries) {
      const key = keyOf(target)
      let set = sets.get(key)
      if (set === undefined) {
        set = createEchoSet()
        sets.set(key, set)
      }
      for (const entry of entries) set.expect(entry.kind, entry.atMs)
    },
    consume(target, kind, atMs) {
      const set = sets.get(keyOf(target))
      return set === undefined ? false : set.consume(kind, atMs)
    },
    clear(target) {
      sets.delete(keyOf(target))
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
  /** §5's reason, carried so the one `player:` line names the same state the room sent. */
  reason: PlaybackReason
  action: 'play' | 'pause' | 'seek'
  /** Media seconds to put in `currentTime` first; absent when the element is already there. */
  target?: number
  /** Millis to the beat, for §6.4's scheduled start; absent means now. */
  leadMs?: number
  /** For a seek the room plays through: `play()` once the seek is done. */
  resume?: boolean
  /**
   * The room's revision the `state` carried. Nothing on the page orders by it —
   * the relay delivers in order — but the command is the state's own number, so
   * a reader of a message can tell which room state produced it.
   */
  revision: number
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
  return plan.echoes.map((kind) => ({
    kind,
    atMs: kind === 'play' && plan.beatMs > 0 ? localNowMs + plan.beatMs : localNowMs,
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
 * is the room's, so it is dropped; one no echo entry and no flag accounts for is
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
  // T15: the bridge's own provenance is asked first, because it was measured on
  // the element by the frame that moved it — right even when the report the plan
  // was built from is half a second old. That is the play press whose hold is
  // the app's pause, not a second person's. The set is still spent, so an entry
  // this event has just made good cannot sit here and swallow a person's next.
  const predicted = event.event === 'rate' ? false : echoes.consume(target, event.event, nowMs)
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
