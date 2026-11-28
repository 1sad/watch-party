<script lang="ts">
  import type { CommandFrame, Media, NudgeFrame, Playback, ReportFrame } from '../shared/protocol.ts'
  import {
    NUDGE_WATCH_MS,
    REPORT_INTERVAL_MS,
    SEEK_SKIP_SECONDS,
    clampToMedia,
    expected,
    nudgeRateAt,
    nudgeSettled,
    type NudgeHold,
  } from '../shared/timing.ts'
  import { createEchoSet } from '../shared/echo.ts'
  import { untrack } from 'svelte'
  import { DEV_ARM_MS, type DevPlay } from './dev-drift.ts'
  import { PRESS_PLAY_BUTTON, hiddenPicture } from './picture-area.ts'

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
    /**
     * §4.2's file, as the room holds it (T9a3). Its `duration` is what the
     * owner's page measured at pick time, and this player's bar uses it rather
     * than measuring again — the room has one answer (T9a2 item 3).
     */
    media: Media | null
    /**
     * Where to load that file: the owner's `/media/<id>`, built by the page.
     * `null` means the room has no file yet, so there is nothing to play.
     */
    src: string | null
    /** Dev-only disturbance from `dev-drift.ts`; null in a shipped page. */
    devPlay: DevPlay | null
    /**
     * T150: what the empty picture says while the room has no file. The page
     * owns the words, because which line is right depends on whether this
     * window is the room's owner - the guest waits for the host, the owner is
     * the one who picks.
     */
    emptyLine: string
    /**
     * T187: the one line the picture shows when a play was refused - the same
     * sentence in the file room and the YouTube embed, composed by
     * `ui/picture-area.ts`'s `pressPlaySentence` so the subject (Windows, or the
     * browser) is named by the page that knows it.
     */
    blockedLine: string
  }

  let { playback, revision, clock, send, rtt, realign, nudge, media, src, devPlay, emptyLine, blockedLine }: Props =
    $props()

  // §6.6's set: the events this component's own play/pause/seek calls cause.
  const echoes = createEchoSet()

  let video = $state<HTMLVideoElement | null>(null)
  /**
   * The bar's length, and the room's answer to "how long" (T9a3, T9a2 item 3):
   * the owner measured it once at pick time and no window measures it again.
   */
  const duration = $derived(media === null ? 0 : media.duration)
  /** Where the bar shows the playhead. `timeupdate` follows it, a drag moves it. */
  let scrub = $state(0)
  let scrubbing = $state(false)
  /**
   * §14: "autoplay blocked — 'click to join playback' overlay; that click
   * retries". Only a refused `play()` sets this; a room that is paused never
   * shows it.
   */
  let blocked = $state(false)

  // T106 / R41 / ADR-030: the volume is this window's own and never the room's.
  // One key holds the person's level; the element is the source of truth for
  // what the controls show, so a command or a replacement element cannot leave
  // them disagreeing with the picture.
  const VOLUME_KEY = 'watchparty.volume'
  /** The picture's level, 0-1, read back from the element. */
  let volume = $state(1)
  /** Whether the speaker has silenced the picture, read back from the element. */
  let muted = $state(false)
  /**
   * T135: silence has two shapes here - the speaker's own `muted`, and a
   * slider at 0, which leaves `muted` false while nothing is heard. Both read
   * "Unmute", because a control labelled Mute must never unmute the film.
   */
  const silent = $derived(muted || volume === 0)
  /** The level to return to on unmute; not stored, so a reload comes back audible. */
  let lastVolume = 1

  /** The remembered level, clamped because storage is not trusted (T106 item 3). */
  function storedVolume(): number {
    try {
      const raw = localStorage.getItem(VOLUME_KEY)
      if (raw === null) return 1
      const value = Number(raw)
      if (!Number.isFinite(value)) return 1
      return Math.min(1, Math.max(0, value))
    } catch {
      return 1
    }
  }

  function rememberVolume(value: number): void {
    try {
      localStorage.setItem(VOLUME_KEY, String(value))
    } catch {
      // Storage refused; the control still works for this session.
    }
  }

  /** Both controls read the element, so the picture and the controls cannot drift apart. */
  function onVolumeChange(): void {
    const element = video
    if (element === null) return
    volume = element.volume
    muted = element.muted
    if (element.volume > 0) lastVolume = element.volume
  }

  /** The slider writes the element's `volume` and remembers it for the next film. */
  function onVolumeInput(event: Event): void {
    const element = video
    if (element === null) return
    const value = Math.min(1, Math.max(0, Number((event.currentTarget as HTMLInputElement).value) / 100))
    element.volume = value
    // A level above zero is a request to hear it, so the speaker's mute lifts.
    if (value > 0) element.muted = false
    rememberVolume(value)
  }

  /** The speaker writes `muted`, and silences the element so `volume` reads 0 too. */
  function toggleMute(): void {
    const element = video
    if (element === null) return
    if (element.muted || element.volume === 0) {
      element.muted = false
      element.volume = lastVolume > 0 ? lastVolume : 1
      return
    }
    lastVolume = element.volume
    element.muted = true
    element.volume = 0
  }

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
   * (restore as soon as it is back under the deadband) and the bound passing (the deadline
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
      // T198: inside the deadband by a margin, not on its edge (`nudgeSettled`).
      // A hold that ends on the line parks this window where the authority reads
      // it as bad again on the next report, and every later nudge ends at once.
      if (nudgeSettled(video.currentTime - expected(playback, clock()))) {
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
   * The upper bound `clampToMedia` uses (§4.5). It is the room's duration —
   * the owner measured it once, and the room has one answer — except when the
   * element itself reports something shorter, which is the only case where
   * trusting the room would place the playhead past the media. With no
   * duration known yet there is no upper bound to apply.
   */
  function seekBound(): number {
    const element = video
    const measured =
      element !== null && Number.isFinite(element.duration) && element.duration > 0
        ? element.duration
        : 0
    if (duration <= 0) return measured > 0 ? measured : Number.POSITIVE_INFINITY
    return measured > 0 ? Math.min(duration, measured) : duration
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
    const target = clampToMedia(seconds, seekBound())
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
    // Nothing to place before the file's metadata is in: `loadedmetadata` calls
    // `forceAlign()` below, so the room's position arrives then. Calling
    // `play()` on a still-empty element would only raise an error this page
    // would show as "autoplay blocked", which would be a lie (T9a3).
    if (element.readyState < 1) return
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

  /**
   * T199: what the picture says and does when its page's visibility changes. A
   * picture behind a hidden page can stay unloaded for good (measured on a real
   * Chrome guest: `readyState` 0, no request to the room, no error), so the line
   * explains the dark picture and the show puts the element back on the room - a
   * returning guest must not wait for a `state` frame the room has no reason to
   * send. The rule itself is `ui/picture-area.ts`'s `hiddenPicture`, so a unit
   * test holds it.
   */
  let waitingLine = $state<string | null>(null)

  $effect(() => {
    const onVisibility = (): void => {
      const element = video
      if (element === null) return
      const decision = hiddenPicture({
        hidden: document.visibilityState === 'hidden',
        loaded: element.readyState >= 1,
        roomPlaying: playback.playing,
      })
      waitingLine = decision.saying
      if (decision.resume) forceAlign()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  })

  // T106: the remembered level belongs to the element, so it is written when the
  // element binds; after that `volumechange` is what the controls read.
  $effect(() => {
    const element = video
    if (element === null) return
    const stored = storedVolume()
    element.volume = stored
    element.muted = false
    volume = stored
    muted = false
    lastVolume = stored > 0 ? stored : 1
  })

  function onLoadedMetadata(): void {
    // The duration shown is the room's (the `duration` above) — this element's
    // own measurement is not news and must not overwrite it (T9a3).
    // T199: the file is in, so the hidden page's line has done its work.
    waitingLine = null
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
    // is a burst of `input` events and still exactly one of these. §4.5's bound
    // applies here too: the bar's far end is the exact end of the media, which
    // no seek may take (§4.5; the room would clamp it anyway).
    element.currentTime = clampToMedia(
      Number((event.currentTarget as HTMLInputElement).value),
      seekBound(),
    )
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
    <!-- T9a3: the owner's one file, at `/media/<id>` on the owner's address.
         There is no clip of our own: with no file the room shows the picker
         state and nothing plays (the T6b fixture is the tests' now). -->
    {#if src !== null}
      <video
        bind:this={video}
        {src}
        preload="auto"
        playsinline
        onloadedmetadata={onLoadedMetadata}
        ontimeupdate={onTimeUpdate}
        onplay={onPlay}
        onplaying={onPlaying}
        onpause={onPause}
        onseeking={onSeeking}
        onseeked={onSeeked}
        onvolumechange={onVolumeChange}
      ></video>
    {:else}
      <p class="empty">{emptyLine}</p>
    {/if}

    {#if waitingLine !== null}
      <!-- T199: the page was hidden while the room's film was due, and a picture
           behind a hidden page can stay unloaded (measured), so this is the one
           sentence that explains the dark frame instead of silence. It goes the
           moment the file's metadata arrives. -->
      <p class="waiting" role="status" data-hidden-wait>{waitingLine}</p>
    {/if}

    {#if blocked}
      <div class="autoplay" role="alertdialog" aria-label="Playback did not start" data-press-play>
        <p>{blockedLine}</p>
        <button type="button" onclick={joinPlayback}>{PRESS_PLAY_BUTTON}</button>
      </div>
    {/if}
  </div>

  {#if src !== null}
    <!-- T155 / R49: the row is icons, not commands - play/pause, then the scrub
         with a clock at its start, the time readout, the volume range and the
         speaker. The buttons call exactly what the text buttons called, and each
         keeps its label and a tooltip so the glyph never has to be guessed.
         Row order: play, scrub, time, volume, mute. -->
    <div class="controls">
      <button
        type="button"
        class="glyph toggle"
        data-play
        aria-label={playback.playing ? 'Pause' : 'Play'}
        title={playback.playing ? 'Pause' : 'Play'}
        onclick={togglePlay}
      >
        {#if playback.playing}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="3.5" y="2.5" width="3.5" height="11" rx="0.5" fill="currentColor" />
            <rect x="9" y="2.5" width="3.5" height="11" rx="0.5" fill="currentColor" />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M4 2.5 13 8 4 13.5Z" fill="currentColor" />
          </svg>
        {/if}
      </button>
      <span class="seek">
        <svg
          class="time-glyph"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M8 4.5V8l2.5 1.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
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
      </span>
      <span class="time">{clockText(scrub)} / {clockText(duration)}</span>
      <!-- T106 / R41: the speaker and the volume slider are this window's own;
           neither sends a frame (ADR-030). -->
      <input
        type="range"
        class="volume"
        aria-label="Volume"
        data-volume
        min="0"
        max="100"
        step="1"
        value={Math.round(volume * 100)}
        oninput={onVolumeInput}
      />
      <button
        type="button"
        class="glyph mute"
        data-mute
        aria-label={silent ? 'Unmute' : 'Mute'}
        title={silent ? 'Unmute' : 'Mute'}
        onclick={toggleMute}
      >
        {#if silent}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M2 6h2.5L8 3v10L4.5 10H2Z" fill="currentColor" />
            <path
              d="M10.5 6 14 9.5M14 6l-3.5 3.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M2 6h2.5L8 3v10L4.5 10H2Z" fill="currentColor" />
            <path
              d="M10.2 5.6a3.4 3.4 0 0 1 0 4.8M12.2 3.6a6 6 0 0 1 0 8.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        {/if}
      </button>
    </div>
  {/if}
</section>

<style>
  .player {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    /* T96 / ADR-047: the film's shape. Where the picture area is given a height
       (the wide layout) this is ignored; where the area sizes to its content
       (the narrow one), it is what makes the box 16:9 before the host's bound
       caps it. The video below is drawn inside it at its own shape either way. */
    aspect-ratio: 16 / 9;
  }

  /* T96 / ADR-047: the frame takes every pixel the picture area leaves above
     the controls, and the video is drawn inside it at its own shape - the black
     around it is the frame's own background, so a 16:9 film in a taller area is
     letterboxed rather than cropped or stretched. */
  .frame {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    background: #000;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    overflow: hidden;
  }

  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }

  .empty {
    margin: 0;
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    color: #9a9aab;
    text-align: center;
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

  /* T199: one line along the top of the picture, the shape the press strip keeps
     (T187 in `App.svelte`) - the picture stays there to be seen, and the line is
     read by whoever reaches the tab. */
  .waiting {
    position: absolute;
    inset: 0 0 auto 0;
    margin: 0;
    padding: 0.45rem 0.75rem;
    background: rgba(10, 10, 14, 0.82);
    color: #e9e9ef;
    font-size: 0.95rem;
    text-align: center;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  /* T155: the scrub owns what the row leaves, and the clock sits at its start. */
  .seek {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }

  input[type='range'] {
    flex: 1 1 auto;
    min-width: 0;
    accent-color: #3ec78a;
  }

  .seek input[type='range'] {
    width: 100%;
  }

  .time-glyph {
    flex: 0 0 auto;
    color: #9a9aab;
  }

  /* T155 / R49: a glyph button is a 16 px drawing in a small box; the words it
     replaces were what took the timeline's width in a 380 px column. */
  .glyph {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    color: #e9e9ef;
    background: transparent;
    border: 1px solid #3a3b46;
    border-radius: 6px;
    cursor: pointer;
  }

  .glyph:hover {
    color: #3ec78a;
    border-color: #3ec78a;
  }

  .glyph:focus-visible {
    outline: 2px solid #3ec78a;
    outline-offset: 2px;
  }

  .glyph svg {
    display: block;
  }

  .time {
    font-family: Consolas, monospace;
    font-size: 0.85rem;
    color: #9a9aab;
    white-space: nowrap;
  }

  input[type='range'].volume {
    flex: 0 0 7rem;
    min-width: 7rem;
  }
</style>
