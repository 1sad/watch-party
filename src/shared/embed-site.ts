/**
 * T179 / R54, ADR-054 and ADR-006 as amended: the app-owned YouTube embed carried
 * by a page with **no window host**.
 *
 * The embed the sidecar serves (`/embed/youtube.html?id=<id>`, ADR-051) is the
 * same page the app's own window loads in its site view. There the window host
 * injects `shared/player-bridge.js`, which owns the whole site-player transport -
 * the candidate report, the play/pause/seek events, §6.6's provenance - and
 * speaks to the window over `window.chrome.webview`. A plain browser has neither
 * that host nor that bridge, so the embed's bridge returns silently on its second
 * line (T157's adapter never runs).
 *
 * What the embed does publish, on its own top document, is `window.__wpYouTube`:
 * the YouTube IFrame Player API behind one small object (`src/server/embed.ts`,
 * ADR-051). A page of the same origin can therefore carry the embed in an iframe
 * of its picture area and drive it through that object - a cooperating player
 * driven through the API it publishes, which is exactly what ADR-006's
 * 2026-11-26 amendment permits.
 *
 * This module is that driver and nothing else. It reads the API's numbers into
 * the **same bridge-shaped messages** the site view posts (`playerReport`,
 * `playerEvent`, T157's shapes) and applies the room's `playerCommand` payloads
 * to the API's methods. The app view's own path - `onSiteEvent`, the election,
 * the follower rule, `reportFromSite` - is unchanged and never learns which
 * transport carried the message, so the window host's path stays exactly as it
 * was. Every position in a report is the API's own `getCurrentTime()`; the
 * expected position, the deadband, the ladder and the report are computed in
 * `shared/site-player.ts` and `shared/timing.ts`, never here.
 *
 * Read from disk by `tests/unit/embed-site.test.ts`.
 *
 * T187 / R54: the browser's autoplay rule is the guest's own. A fresh profile has
 * had no gesture in this document, so YouTube's `playVideo()` is refused and the
 * picture sits at the room's position behind a silent centred play button (the
 * owner saw it, 2026-11-26; ticket 179 measured the refusal). The room keeps
 * asking - a paused follower of a playing room is asked to play on every report -
 * and the API answers none of them, so this module remembers the first unanswered
 * ask and `needsPress()` reports it once the wait is over. The picture area then
 * says so in one line and offers the press; `join()` is that press, which the
 * browser answers because it happens inside the person's gesture.
 */

/**
 * The object the sidecar's embed page publishes on its own top document
 * (`src/server/embed.ts`, ADR-051): the IFrame Player API behind these methods.
 */
export interface EmbedPlayerApi {
  play(): void
  pause(): void
  seek(seconds: number): void
  now(): number | null
  state(): number | null
  duration(): number | null
  setVolume(level: number): void
  volume(): number | null
  muted(): boolean | null
  rate(): number | null
  setRate(rate: number): void
  onStateChange(listener: (state: number) => void): void
}

/** One look at the embed: its player and the frame's own viewport. */
export interface EmbedFrame {
  api: EmbedPlayerApi
  /** The frame's CSS width and height - the bridge's `w`/`h`, and §10.1's area. */
  w: number
  h: number
}

/**
 * T157's id for the app's embed player, in `player-bridge.js` and here alike: one
 * number no `<video>` element can have, so a report of the API and a report of an
 * element never collide. The page only has to agree with itself, but the same
 * number keeps a bridge log and a page log readable side by side.
 */
export const EMBED_PLAYER_ID = 1000000

/**
 * One beat of the transport in millis. The bridge polls at `PLAYBACK_POLL_MS`
 * (500 ms, T157); a report itself is no faster than the numbers below.
 */
export const EMBED_POLL_MS = 500

/**
 * T187 / R54: how long a play this page asked for may go unanswered before the
 * picture says to press once. A player that starts on its own is playing well
 * inside this - the API fires its `1` a beat or two after `playVideo()` - while a
 * browser's autoplay rule leaves the player where it was for ever (ticket 179
 * measured Chrome refusing `playVideo()` in a throwaway profile). The player stays
 * paused either way, so time is the only thing that separates "starting" from
 * "refused"; this is one beat and a half of `EMBED_POLL_MS`, which is how soon the
 * page could have asked its next question anyway.
 */
export const PRESS_AFTER_MS = 1500

/** A non-negative whole number, or 0: a viewport a frame cannot state is no area. */
function viewport(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.round(value)
}

/**
 * The embed's API out of a window that should be carrying it, or `null` when it
 * is not there yet (the player's own `<script>` has not run) or is not the shape
 * ADR-051 publishes. Every read is defensive: a frame that has not navigated yet,
 * or one whose document is not ours, is "no player", never a broken page.
 */
export function embedFrameOf(win: unknown): EmbedFrame | null {
  if (typeof win !== 'object' || win === null) return null
  const frame = win as { __wpYouTube?: unknown; innerWidth?: unknown; innerHeight?: unknown }
  let api: unknown
  try {
    api = frame.__wpYouTube
  } catch {
    return null
  }
  if (typeof api !== 'object' || api === null) return null
  const player = api as Partial<EmbedPlayerApi>
  if (typeof player.now !== 'function' || typeof player.state !== 'function') return null
  return {
    api: player as EmbedPlayerApi,
    w: viewport(frame.innerWidth),
    h: viewport(frame.innerHeight),
  }
}

export interface EmbedSiteOptions {
  /** The embed's own address: the report's `href`, and the `source` the app view routes by. */
  source: string
  /** One look at the embed, or `null` before the API exists. */
  frame(): EmbedFrame | null
  /** Where the bridge-shaped messages go - the app view's `onSiteEvent`. */
  post(payload: Record<string, unknown>): void
  /** This page's clock in millis; `Date.now` unless a test says otherwise. */
  now?(): number
}

export interface EmbedSite {
  /** One beat of the transport: subscribe once, then the seek, the lost seek and the report. */
  poll(): void
  /** One `playerCommand` payload from the room (the app view's `siteCommand`). */
  apply(payload: unknown): void
  /**
   * T187 / R54: the room is playing and this player would not start - the browser
   * refused the play, because nothing in this document has been pressed yet. The
   * picture area then says so in one line, instead of leaving a silent centred
   * play button (ticket 179's `NOT DONE`, the owner's own report).
   */
  needsPress(): boolean
  /**
   * T187: the person's press in the picture. A play asked for inside their
   * gesture, so the browser's rule answers it, at the position the room's ladder
   * has already put the picture in. Not a command: a browser guest is not a
   * controller, and `Player.svelte`'s `joinPlayback` is the same local move on the
   * room's file.
   */
  join(): void
}

/** This document's own name, so a report can be told from a reload's (T07's token). */
function documentToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // A browser that broke `crypto` gets the fallback below, not a silent page.
  }
  return `${String(Date.now())}-${String(Math.random()).slice(2)}`
}

/** A finite number, or the fallback. The API answers `null` until the player exists. */
function seconds(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The transport, in one object: the T157 adapter's page-side half.
 *
 * `apply` is the room's hand on the player (`playVideo`, `pauseVideo`, `seekTo`,
 * `setPlaybackRate`), and every write it makes is recorded first, so the API's
 * own state event that follows is tagged `caused` and §6.6 drops it. `poll` is
 * the page's look: the API's numbers become one candidate, a playhead that moved
 * further than a player can is a `seeked`, and a position the room asked for
 * before the duration was known is written once the player can take it.
 */
export function createEmbedSite(options: EmbedSiteOptions): EmbedSite {
  const clock = options.now ?? (() => Date.now())
  const doc = documentToken()

  // T157's cadence and its two thresholds, from `player-bridge.js`: a report while
  // the player is idle is no faster than a second, half a second while it plays, a
  // change may go after a quarter; a person seeking inside YouTube fires no event
  // this page can hear, so the playhead's own jump is it - backwards past this, or
  // forwards past a buffer's worth.
  const REPORT_MS = 1000
  const PLAYING_REPORT_MS = 500
  const CHANGE_GAP_MS = 250
  const CAUSED_EXPIRY_MS = 1000
  const SEEK_BACK_SECONDS = 1.5
  const SEEK_AHEAD_SECONDS = 5

  let seq = 0
  let watched = false
  /** The API's own number (never buffering, which is a layer over it). */
  let state: number | null = null
  /** The last playhead this page looked at, and when: the seek detector's two halves. */
  let seenT: number | null = null
  let seenAt = 0
  let lastSentAt = 0
  let lastShape: string | null = null
  /** A position the room asked for before the player had a duration (T146, ADR-050). */
  let lostSeek: number | null = null
  /**
   * T187: the instant this page first asked the player to play and it has not
   * started since, or `null`. The room asks again on every report, so the first
   * ask is kept rather than the latest - otherwise a refused play would reset its
   * own wait for ever.
   */
  let askedAt: number | null = null
  /** The beat of a scheduled start (§6.4), so a later command can cancel it. */
  let hold: ReturnType<typeof setTimeout> | undefined
  /** event kind -> the instants of this page's own writes, spent by the event they cause. */
  const caused: Record<string, number[]> = {}

  function post(payload: Record<string, unknown>): void {
    seq += 1
    options.post({ ...payload, seq, doc, href: options.source, top: true })
  }

  function arm(kind: string): void {
    const list = caused[kind] ?? (caused[kind] = [])
    list.push(clock())
  }

  function disarm(kind: string): void {
    const list = caused[kind]
    if (list !== undefined) list.length = 0
  }

  /** True when this event is one of this page's writes, one entry spent (T15's provenance). */
  function takeCaused(kind: string): boolean {
    const list = caused[kind]
    if (list === undefined || list.length === 0) return false
    const now = clock()
    const live = list.filter((at) => now - at < CAUSED_EXPIRY_MS)
    caused[kind] = live
    if (live.length === 0) return false
    live.shift()
    return true
  }

  function apiState(api: EmbedPlayerApi): number | null {
    try {
      const value = api.state()
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    } catch {
      return null
    }
  }

  function apiPosition(api: EmbedPlayerApi): number {
    try {
      return seconds(api.now())
    } catch {
      return 0
    }
  }

  function apiDuration(api: EmbedPlayerApi): number {
    try {
      return seconds(api.duration())
    } catch {
      return 0
    }
  }

  function apiRate(api: EmbedPlayerApi): number {
    try {
      return seconds(api.rate !== undefined ? api.rate() : 1, 1) || 1
    } catch {
      return 1
    }
  }

  function playing(api: EmbedPlayerApi): boolean {
    const now = apiState(api) ?? state
    return now === 1 || now === 3
  }

  /**
   * One candidate from the API's numbers, in the shape `measure` builds from an
   * element (T06). ADR-051's state table: `1` playing, `2` paused, `3` buffering,
   * `0` ended, `-1` unstarted. Buffering reports a `readyState` below 3, so §6.7
   * holds the ladder's rate off a starved player.
   */
  function measure(frame: EmbedFrame): Record<string, unknown> | null {
    const api = frame.api
    const now = apiState(api)
    if (now === null) return null
    let t: number | null
    try {
      t = api.now()
    } catch {
      return null
    }
    if (typeof t !== 'number' || !Number.isFinite(t)) return null
    const duration = apiDuration(api)
    return {
      id: EMBED_PLAYER_ID,
      w: frame.w,
      h: frame.h,
      readyState: now === 3 ? 2 : duration > 0 ? 4 : 0,
      hasSrc: duration > 0,
      playing: now === 1,
      duration,
      t,
      paused: now !== 1 && now !== 3,
      // The API has no buffered range; a player cannot be past what it decoded.
      buffered: t,
      rate: apiRate(api),
    }
  }

  /** The candidate set as one string, without the moving parts: a change is not the poll. */
  function shapeOf(candidate: Record<string, unknown>): string {
    return [
      candidate.id,
      candidate.w,
      candidate.h,
      candidate.readyState,
      candidate.hasSrc === true ? 1 : 0,
      candidate.playing === true ? 1 : 0,
      Math.round(seconds(candidate.duration)),
    ].join(':')
  }

  function send(candidate: Record<string, unknown>, now: number): void {
    lastShape = shapeOf(candidate)
    lastSentAt = now
    post({ kind: 'playerReport', candidates: [candidate] })
  }

  /**
   * One `play`/`pause` for this page, tagged exactly as an element's event is -
   * `caused` while a write of this page's own is unspent, so §6.6 drops it and a
   * person's press is the room's. `wasPlaying` is for a seek the poll saw.
   */
  function postPlayback(kind: 'play' | 'pause' | 'seeked', api: EmbedPlayerApi, wasPlaying: boolean): void {
    const message: Record<string, unknown> = {
      kind: 'playerEvent',
      event: kind,
      id: EMBED_PLAYER_ID,
      t: apiPosition(api),
      caused: takeCaused(kind),
    }
    if (kind === 'seeked' && wasPlaying) message.wasPlaying = true
    post(message)
  }

  /**
   * The API's own `onStateChange`. Buffering is a layer over the state it was in,
   * not a state of its own, so it is remembered as nothing: a player that buffers
   * between two beats of a playing video is not a second `play`.
   */
  function onApiState(raw: unknown): void {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return
    const previous = state
    if (raw !== 3) state = raw
    if (previous === null || raw === previous || raw === 3) return
    const look = options.frame()
    if (look === null) return
    if (raw === 1) postPlayback('play', look.api, false)
    else if (raw === 2 || raw === 0) postPlayback('pause', look.api, false)
  }

  /**
   * The seek the API never fires an event for. The playhead should have moved by
   * the elapsed time while the player is moving, and a jump past what that can
   * explain is a person's seek - posted as `seeked`, with this page's own writes
   * spent first, so a seek the room asked for stays an echo.
   */
  function checkSeek(api: EmbedPlayerApi): void {
    const nowState = apiState(api)
    let t: number | null
    try {
      t = api.now()
    } catch {
      return
    }
    if (nowState === null || typeof t !== 'number' || !Number.isFinite(t)) return
    const now = clock()
    if (seenT === null) {
      seenT = t
      seenAt = now
      return
    }
    const moving = state === 1 || state === 3
    const elapsed = Math.max(0, now - seenAt) / 1000
    const jump = t - seenT - (moving ? elapsed : 0)
    seenT = t
    seenAt = now
    if (jump > -SEEK_BACK_SECONDS && jump < SEEK_AHEAD_SECONDS) return
    postPlayback('seeked', api, moving)
  }

  /**
   * T146, ADR-050: `seekTo` on the app's player, with the bridge's rule kept - a
   * seek asked for before the duration is known is remembered and written once
   * the API can take it, rather than dropping the room's position.
   */
  function writeSeek(api: EmbedPlayerApi, target: number): void {
    if (!(apiDuration(api) > 0)) {
      lostSeek = target
      return
    }
    lostSeek = null
    const moved = Math.abs(apiPosition(api) - target) > 0.001
    if (moved) arm('seeked')
    try {
      api.seek(target)
    } catch {
      // A seek the player refuses is not coming; the ladder's next look tries again.
      if (moved) disarm('seeked')
    }
  }

  function cancelHold(): void {
    if (hold === undefined) return
    clearTimeout(hold)
    hold = undefined
    disarm('play')
  }

  /**
   * T187: one play asked for. The first ask of an unanswered stretch is the one
   * that starts the wait (`needsPress`); every later ask is the room's report
   * cadence, not new information, and must not restart it. `arm('play')` before
   * the write is the same provenance the element bridge keeps (T15): the API's own
   * `1` that follows is this page's, and §6.6 drops it.
   */
  function askPlay(api: EmbedPlayerApi): void {
    if (askedAt === null) askedAt = clock()
    arm('play')
    try {
      api.play()
    } catch {
      // A refused play leaves the player where it was; the wait below says so.
    }
  }

  /**
   * T157: one `playerCommand` for the app's player. The room asks for exactly what
   * it asks any site - play, pause, seek, or the ladder's rate - and only the hands
   * differ: `play`, `pause`, `seek`, `setRate`.
   */
  function apply(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return
    const command = payload as Record<string, unknown>
    if (command.kind !== 'playerCommand') return
    // The bridge's own guard: a command aimed at another frame's address is not
    // this page's, and a stray id must not move a different player.
    if (typeof command.href === 'string' && command.href !== options.source) return
    if (command.id !== EMBED_PLAYER_ID) return
    const look = options.frame()
    if (look === null) return
    const api = look.api

    const from = apiPosition(api)
    const target = typeof command.target === 'number' && Number.isFinite(command.target) ? command.target : from
    const lead = typeof command.leadMs === 'number' && Number.isFinite(command.leadMs) ? Math.max(0, command.leadMs) : 0
    const action = command.action
    const scheduled = lead > 0

    if (action === 'rate') {
      const nextRate = typeof command.rate === 'number' && Number.isFinite(command.rate) ? command.rate : 1
      try {
        api.setRate(nextRate)
      } catch {
        // A player that froze its own rate reports its number; the ladder's
        // deadline still restores, and that restore simply does not take.
      }
      return
    }

    if (action !== 'pause' && action !== 'play' && action !== 'seek') return

    // T15 item 2: a beat still waiting is older than this command.
    cancelHold()

    const moving = playing(api)
    if (action === 'pause' || (scheduled && moving)) {
      if (moving) arm('pause')
      try {
        api.pause()
      } catch {
        // A player that will not stop is reported by the room's next look.
      }
      // T187: a paused room has nothing to press play for; the temporary stop
      // before a scheduled beat keeps the ask it is about to answer.
      if (action === 'pause') askedAt = null
    }

    if (typeof command.target === 'number') writeSeek(api, target)

    if (action === 'pause') {
      // Nothing more: a paused room's playhead is the ladder's to snap.
    } else if (action === 'seek' && command.resume !== true) {
      // A paused snap: the playhead moved and the player stays paused.
    } else if (scheduled) {
      hold = setTimeout(() => {
        hold = undefined
        askPlay(api)
      }, lead)
    } else {
      askPlay(api)
    }

    // T06's one line per applied command, in the same shape an element's is.
    post({
      kind: 'playerEvent',
      event: 'applied',
      id: EMBED_PLAYER_ID,
      action,
      reason: typeof command.reason === 'string' ? command.reason : '(none)',
      target,
      from,
    })
  }

  /**
   * One beat. The first look subscribes to the API's own state and takes the
   * playhead as the seek detector's baseline; every later one writes a position
   * the player could not take yet, reads the seek, and reports. Volume is the
   * window's own (ADR-050 item 3) and is not carried: this page has no level
   * store, and a browser guest's player keeps the level its own controls set.
   */
  function poll(): void {
    const look = options.frame()
    if (look === null) return
    const api = look.api
    if (!watched) {
      watched = true
      const first = apiState(api)
      if (first !== null) state = first
      let t: number | null
      try {
        t = api.now()
      } catch {
        t = null
      }
      seenT = typeof t === 'number' && Number.isFinite(t) ? t : null
      seenAt = clock()
      try {
        api.onStateChange(onApiState)
      } catch {
        // A player that will not take a listener still reports; only its events
        // are lost, and the room corrects it like any other follower.
      }
    } else {
      if (lostSeek !== null && apiDuration(api) > 0) {
        const target = lostSeek
        writeSeek(api, target)
      }
      checkSeek(api)
    }

    const candidate = measure(look)
    if (candidate === null) return
    const now = clock()
    const shape = shapeOf(candidate)
    if (shape !== lastShape) {
      if (now - lastSentAt >= CHANGE_GAP_MS) send(candidate, now)
      // A change inside the gap is not lost: the next beat sees it again.
      return
    }
    const busy = candidate.playing === true
    if (now - lastSentAt >= (busy ? PLAYING_REPORT_MS : REPORT_MS)) send(candidate, now)
  }

  /**
   * T187 / R54: is the picture waiting for the person's one press? True when this
   * page asked the player to play, the player has still not started, and the wait
   * `PRESS_AFTER_MS` has passed since the first ask. A player that does start - on
   * its own, or because the person pressed YouTube's own button in the embed -
   * ends the wait however it started, so the line never outlives the refusal.
   */
  function needsPress(): boolean {
    if (askedAt === null) return false
    const look = options.frame()
    const nowState = look === null ? null : apiState(look.api)
    if (nowState === 1 || nowState === 3) {
      askedAt = null
      return false
    }
    return clock() - askedAt >= PRESS_AFTER_MS
  }

  /**
   * T187: the person's press in the picture - a local start, not a command (see
   * `EmbedSite.join`). The wait is re-armed from this press, so a press the
   * browser still refuses leaves the line up rather than claiming success.
   */
  function join(): void {
    const look = options.frame()
    if (look === null) return
    askedAt = clock()
    askPlay(look.api)
  }

  return { poll, apply, needsPress, join }
}
