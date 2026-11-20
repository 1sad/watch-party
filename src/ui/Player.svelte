<script lang="ts">
  import type { CommandFrame, NudgeFrame, Playback, ReportFrame } from '../shared/protocol.ts'
  import {
    CORRECTION_DEADBAND_SECONDS,
    REPORT_INTERVAL_MS,
    SEEK_SKIP_SECONDS,
    expected,
    nudgeRateAt,
    type NudgeHold,
  } from '../shared/timing.ts'
  import { createEchoSet } from '../shared/echo.ts'
  import { untrack } from 'svelte'
  import { DEV_ARM_MS, type DevPlay } from './dev-drift.ts'

  interface Props {
    /** The room's `playback`, from the last `welcome` or `state` (§4.1). */
    playback: Playback
    /** The room's `revision`, held beside it (§4.3 invariant 2). */
    revision: number
    /**
     * The authority's clock as §6.1 measures it, supplied by the page. The
     * player never calls `Date.now()` itself: every "when" in this window is
     * the estimate App owns.
     */
    clock: () => number
    /** §5's commands and §5's `report`. The page sends them; the player never touches a socket. */
    send: (frame: CommandFrame | ReportFrame) => void
    /** T5's rtt estimate, which every `report` carries for §6.4's `maxRtt` (T8). */
    rtt: () => number
    /** Bumped when the room refused a command or a `welcome` replaced the room. */
    realign: number
    /** The authority's latest nudge for this window, or null (§6.3, T7b2). */
    nudge: NudgeFrame | null
    /** Dev-only disturbance from `dev-drift.ts`; null in a shipped page. */
    devPlay: DevPlay | null
  }

  let { playback, revision, clock, send, rtt, realign, nudge, devPlay }: Props = $props()

  // §6.6's set: the events this component's own play/pause/seek calls cause.
  const echoes = createEchoSet()

  /**
   * How often a held nudge is re-examined. It is a polling interval, not a
   * §6.3 number: 200 ms is well inside the 0.1 s band's closing time (2 s at
   * 5 %) and cheap enough to run in every window.
   */
  const NUDGE_WATCH_MS = 200

  let video = $state<HTMLVideoElement | null>(null)
  let duration = $state(0)
  /** Where the bar shows the playhead. `timeupdate` follows it, a drag moves it. */
  let scrub = $state(0)
  let scrubbing = $state(false)
  /**
   * §14: "autoplay blocked — 'click to join playback' overlay; that click
   * retries". Only a refused `play()` sets this; a room that is paused never
   * shows it.
   */
  let blocked = $state(false)

  /** The last revision applied to the element; -1 means "apply the next one whatever it is". */
  let appliedRevision = -1
  /** §6.4's scheduled start: a state may name an instant up to 1.5 s away. */
  let startTimer: ReturnType<typeof setTimeout> | undefined
  /** The instant the pending timer is for, or null; also the dev log's subject. */
  let startBeat: number | null = null
  /** For `seek{wasPlaying}`: whether the element was playing when a seek began. */
  let wasPlayingBeforeSeek = false

  function clearStart(): void {
    if (startTimer !== undefined) clearTimeout(startTimer)
    startTimer = undefined
    startBeat = null
  }

  // §6.3's one correction the page can apply: a rate, held until the authority's
  // bound. It is not a second way to move the playhead — a seek or a paused snap
  // arrives as a `state` and goes through `applyState()` like every other.
  let held: NudgeHold | null = null
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Watches the two ways a nudge ends without a message: the gap closing
   * (restore as soon as it is under 0.1 s) and the bound passing (the deadline
   * timer's job, repeated here because a sleeping window throttles timers and a
   * window must never come back at 0.95×).
   */
  let nudgeWatch: ReturnType<typeof setInterval> | undefined
  /** The last `nudge` frame applied, so a re-render cannot re-apply one. */
  let lastNudge: NudgeFrame | null = null
  /** Dev-only: the switch fired once per page load, never in a loop. */
  let devFired = false

  /** Back to 1× (§6.3's last rule), whichever way the hold ended. */
  function endNudge(): void {
    if (nudgeTimer !== undefined) clearTimeout(nudgeTimer)
    nudgeTimer = undefined
    if (nudgeWatch !== undefined) clearInterval(nudgeWatch)
    nudgeWatch = undefined
    held = null
    if (video !== null) video.playbackRate = 1
  }

  /**
   * Apply §6.3's nudge, to this window only. `untilAuthorityMs` is the bound on
   * the authority's clock, not a countdown started here: a frame that arrives
   * already past it is not applied at all, and a held rate can never outlive it
   * (`nudgeRateAt`, which `npm test` pins at exact instants).
   */
  function applyNudge(frame: NudgeFrame): void {
    const hold: NudgeHold = { rate: frame.rate, untilAuthorityMs: frame.untilAuthorityMs }
    if (nudgeRateAt(hold, clock()) !== hold.rate) {
      endNudge()
      return
    }
    const element = video
    if (element === null) return

    // A newer nudge replaces an older one outright: two deadlines for one
    // playhead would let the first one restore a rate the second just set.
    endNudge()
    held = hold
    element.playbackRate = hold.rate
    nudgeTimer = setTimeout(() => {
      nudgeTimer = undefined
      endNudge()
    }, Math.max(0, hold.untilAuthorityMs - clock()))
    nudgeWatch = setInterval(() => {
      if (held === null) return
      // The bound first: a late tick must not keep a stale rate alive.
      if (nudgeRateAt(held, clock()) !== held.rate) {
        endNudge()
        return
      }
      if (video === null) return
      if (Math.abs(video.currentTime - expected(playback, clock())) <= CORRECTION_DEADBAND_SECONDS) {
        endNudge()
      }
    }, NUDGE_WATCH_MS)
  }

  // §5's `report`, every 3 s while the room plays: a measurement, never a
  // command. It is the only way the authority can see this window's playhead
  // (§4.3 invariant 4 — it holds no clock of ours, and no offset).
  let reportTimer: ReturnType<typeof setInterval> | undefined

  function sendReport(): void {
    const element = video
    if (element === null || !playback.playing) return
    let buffered = 0
    try {
      if (element.buffered.length > 0) buffered = element.buffered.end(element.buffered.length - 1)
    } catch {
      // A detached or empty TimeRanges has no end; 0 is the honest answer.
    }
    send({
      type: 'report',
      position: element.currentTime,
      readyState: element.readyState,
      buffered,
      rate: element.playbackRate,
      duration: Number.isFinite(element.duration) ? element.duration : undefined,
      origin: location.origin,
      rtt: rtt(),
    })
  }

  /**
   * T7b2's dev-only disturbance, from `dev-drift.ts`. The stall uses
   * `pauseElement()`/`playElement()` — the §6.6 echo path — so it is a local
   * fault the room never hears about, which is what a real stall is.
   */
  function disturb(): void {
    // The one statically-false line the shipped page has here: `vite build`
    // replaces `import.meta.env.DEV` with `false` and `MODE` with
    // `'production'`, so the guard folds to `return` and everything below it —
    // the parameter lookups included — is dropped from `dist/`. The switch is
    // absent from Release, not merely unarmed (`dev-drift.ts`).
    if (!(import.meta.env.DEV || import.meta.env.MODE === 'development')) return
    if (devPlay === null || devFired) return
    devFired = true
    setTimeout(() => {
      if (devPlay === null) return
      if (devPlay.nudge !== null) {
        applyNudge({
          type: 'nudge',
          target: 0,
          rate: devPlay.nudge.rate,
          untilAuthorityMs: clock() + devPlay.nudge.milliseconds,
        })
      }
      if (devPlay.stallSeconds <= 0) return
      pauseElement()
      setTimeout(() => playElement(), devPlay.stallSeconds * 1000)
    }, DEV_ARM_MS)
  }

  /**
   * §4.3 invariant 9's one move: put the element where the room says, and no
   * other place. A target within §5's 0.3 s window is the second arrival of a
   * move that already happened, so it is skipped — that is what keeps the
   * `state` echo of our own seek from becoming a visible second jump.
   */
  function seekTo(seconds: number): void {
    const element = video
    if (element === null) return
    const last = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : seconds
    const target = Math.max(0, Math.min(seconds, last))
    if (element.readyState < 1) return
    if (Math.abs(element.currentTime - target) <= SEEK_SKIP_SECONDS) return
    echoes.expect('seeked', performance.now())
    element.currentTime = target
  }

  /** A programmatic pause: on a paused element it is already true, so it is a no-op. */
  function pauseElement(): void {
    const element = video
    if (element === null || element.paused) return
    echoes.expect('pause', performance.now())
    element.pause()
  }

  /**
   * A programmatic play. §5: `play()` on a playing element is a no-op. §14: if
   * the policy still refuses it, the window must offer the click — a silent
   * pause that nobody can explain is the bug this overlay exists to avoid.
   */
  function playElement(): void {
    const element = video
    if (element === null || !element.paused) return
    echoes.expect('play', performance.now())
    void element.play().then(
      () => {
        blocked = false
      },
      () => {
        blocked = true
      },
    )
  }

  /**
   * Apply the room's `playback`. Called for `welcome`, for every `state`, and
   * again when the element loads — the three moments §4.3 invariant 9 names.
   *
   * `startAt` is §6.4's scheduled start: a state that says "playing, from here,
   * at this authority instant" is not "play now". The playhead is put where it
   * will be at that instant and `play()` waits for it, so five windows start on
   * the same beat instead of on their own packet arrival.
   */
  function applyState(): void {
    const element = video
    if (element === null) return
    // §4.3 invariant 2: an older revision is not news, and applying it would
    // undo a command that arrived first.
    if (revision < appliedRevision) return
    appliedRevision = revision

    // A `state` is the room moving the playhead (§4.3 invariant 9) — and a
    // targeted hard seek or paused snap is a `state` too (T7b2), which is the
    // whole point of the authority sending it that way. So the nudge ends here:
    // the playhead has just been put where it belongs, and §6.3's last rule
    // restores the rate with it.
    endNudge()

    clearStart()
    const nowMs = clock()
    const startAt = playback.startAt
    const scheduled =
      playback.playing && typeof startAt === 'number' && Number.isFinite(startAt) && startAt > nowMs

    seekTo(scheduled ? expected(playback, startAt) : expected(playback, nowMs))

    if (!playback.playing) {
      pauseElement()
      return
    }
    if (scheduled) {
      // Item 3: `play()` waits for the beat, so a resume after a seek does not
      // start on packet arrival either. A window already playing holds the
      // pressed frame until the timer, which is the one place §6.4 spends its
      // 1.5 s. `pauseElement()` goes through §6.6's set, so it sends no command.
      pauseElement()
      startBeat = startAt
      startTimer = setTimeout(() => {
        startTimer = undefined
        playElement()
      }, startAt - nowMs)
      return
    }
    playElement()
  }

  /** Invariant 9 again, for a load or a reconnect: ignore the revision guard and re-apply. */
  function forceAlign(): void {
    appliedRevision = -1
    applyState()
  }

  let lastRealign = realign
  $effect(() => {
    // Every input of the application is read here, so a new frame, a newly
    // bound element, or a refusal re-runs it — and nothing else does.
    void playback
    void revision
    void video
    if (realign !== lastRealign) {
      lastRealign = realign
      appliedRevision = -1
    }
    // `applyState` reads the clock, and the clock reads §6.1's offset estimate,
    // which moves on every `pong`. That is a measurement, not a new application
    // of the room's playback: tracking it would make every pong a second way to
    // move the playhead — a local snap the ladder never decided. T7b2 measured
    // exactly that on the two-window gate: a stalled window put itself back on
    // the room 3 s in, with no `state` and no correction in the log. Untracked,
    // the only moves are `welcome`, `state`, a load and a refusal (§4.3
    // invariant 9).
    untrack(() => applyState())
  })

  // §5's report loop starts once the element exists and stops with it; the
  // cadence is the room's, and a paused room is the page's silence.
  $effect(() => {
    if (video === null) return
    reportTimer = setInterval(sendReport, REPORT_INTERVAL_MS)
    return () => {
      if (reportTimer !== undefined) clearInterval(reportTimer)
      reportTimer = undefined
    }
  })

  // The authority's own frames: only a *new* nudge object is applied, so a
  // re-render of the page cannot restart one.
  $effect(() => {
    const next = nudge
    if (next === null || next === lastNudge) return
    lastNudge = next
    applyNudge(next)
  })

  function onLoadedMetadata(): void {
    const element = video
    if (element === null) return
    duration = Number.isFinite(element.duration) ? element.duration : 0
    forceAlign()
  }

  function onTimeUpdate(): void {
    const element = video
    if (element === null) return
    if (!scrubbing) scrub = element.currentTime
  }

  /**
   * A person's gesture, so this is a room command and not an echo. §6.6's set
   * is not consulted here; the event handler is what asks the room.
   */
  function togglePlay(): void {
    const element = video
    if (element === null) return
    if (element.paused) {
      void element.play().then(
        () => {
          blocked = false
        },
        () => {
          blocked = true
        },
      )
    } else {
      element.pause()
    }
  }

  function onPlay(): void {
    blocked = false
    // T7b2's dev switch arms from the first real playback of this window, and
    // from nothing else: a stall before the room plays would be a stall of
    // nothing (dev-drift.ts).
    disturb()
    // Consumed: our own `playElement()`. Not consumed: a person or the site,
    // which is a room action (§6.6, ADR-029).
    if (echoes.consume('play', performance.now())) return
    if (video === null) return
    send({ type: 'play', position: video.currentTime })
  }

  function onPlaying(): void {
    const beat = startBeat
    if (beat === null) return
    startBeat = null
    // The gate's one line per window: the local instant of this `playing`
    // event against §6.4's instant. Dev builds only, so `dist/` has no log.
    if (!(import.meta.env.DEV || import.meta.env.MODE === 'development')) return
    const localNow = Date.now()
    console.info(`scheduled-start startAt=${beat} playingAt=${localNow} deltaMs=${localNow - beat}`)
  }

  function onPause(): void {
    if (echoes.consume('pause', performance.now())) return
    if (video === null) return
    send({ type: 'pause', position: video.currentTime })
  }

  function onSeeking(): void {
    wasPlayingBeforeSeek = video !== null && !video.paused
  }

  function onSeeked(): void {
    if (echoes.consume('seeked', performance.now())) return
    if (video === null) return
    // §5: `wasPlaying` lets the room resume a seek that interrupted playback.
    send({ type: 'seek', position: video.currentTime, wasPlaying: wasPlayingBeforeSeek })
  }

  /** Dragging only moves the thumb; releasing is the one seek this makes. */
  function onScrubInput(event: Event): void {
    scrubbing = true
    scrub = Number((event.currentTarget as HTMLInputElement).value)
  }

  function onScrubChange(event: Event): void {
    scrubbing = false
    const element = video
    if (element === null) return
    // No `expect()`: a person moved the playhead, so the `seeked` event this
    // causes is the command. One release, one seek, one `state` — a hard drag
    // is a burst of `input` events and still exactly one of these.
    element.currentTime = Number((event.currentTarget as HTMLInputElement).value)
  }

  /**
   * §14: the click retries the play the policy refused. The room is already
   * playing (that is why the overlay is here), so this is a local alignment,
   * not a command: `forceAlign()` puts the playhead on the room and calls
   * `play()` inside the gesture.
   */
  function joinPlayback(): void {
    blocked = false
    forceAlign()
  }

  function clockText(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const whole = Math.floor(seconds)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${Math.floor(whole / 60)}:${pad(whole % 60)}`
  }
</script>

<section class="player" aria-label="Player">
  <div class="frame">
    <!-- T6b: the committed clip, served by the sidecar at /fixture. T9a swaps a
         picked file in; until then this is what every check presses play on. -->
    <video
      bind:this={video}
      src="/fixture"
      preload="auto"
      playsinline
      onloadedmetadata={onLoadedMetadata}
      ontimeupdate={onTimeUpdate}
      onplay={onPlay}
      onplaying={onPlaying}
      onpause={onPause}
      onseeking={onSeeking}
      onseeked={onSeeked}
    ></video>

    {#if blocked}
      <div class="autoplay" role="alertdialog" aria-label="Playback did not start">
        <p>Windows did not let the film start on its own.</p>
        <button type="button" onclick={joinPlayback}>Click to join playback</button>
      </div>
    {/if}
  </div>

  <div class="controls">
    <button type="button" class="toggle" onclick={togglePlay}>
      {playback.playing ? 'Pause' : 'Play'}
    </button>
    <input
      type="range"
      aria-label="Seek"
      min="0"
      max={duration}
      step="0.01"
      value={scrub}
      oninput={onScrubInput}
      onchange={onScrubChange}
    />
    <span class="time">{clockText(scrub)} / {clockText(duration)}</span>
  </div>
</section>

<style>
  .player {
    margin: 0 0 1.5rem;
  }

  .frame {
    position: relative;
    background: #000;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    overflow: hidden;
  }

  video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
  }

  .autoplay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: rgba(10, 10, 14, 0.82);
    text-align: center;
    padding: 1rem;
  }

  .autoplay p {
    margin: 0;
    font-size: 1.05rem;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .toggle {
    min-width: 5rem;
  }

  input[type='range'] {
    flex: 1 1 auto;
    min-width: 0;
    accent-color: #3ec78a;
  }

  .time {
    font-family: Consolas, monospace;
    font-size: 0.85rem;
    color: #9a9aab;
    white-space: nowrap;
  }
</style>
