<script lang="ts">
  import type { CommandFrame, Playback } from '../shared/protocol.ts'
  import { SEEK_SKIP_SECONDS, expected } from '../shared/timing.ts'
  import { createEchoSet } from '../shared/echo.ts'

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
    /** §5's commands. The page sends them; the player never touches a socket. */
    send: (frame: CommandFrame) => void
    /** Bumped when the room refused a command or a `welcome` replaced the room. */
    realign: number
  }

  let { playback, revision, clock, send, realign }: Props = $props()

  // §6.6's set: the events this component's own play/pause/seek calls cause.
  const echoes = createEchoSet()

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
  /** For `seek{wasPlaying}`: whether the element was playing when a seek began. */
  let wasPlayingBeforeSeek = false

  function clearStart(): void {
    if (startTimer !== undefined) clearTimeout(startTimer)
    startTimer = undefined
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
    // bound element, or a refusal re-runs it.
    void playback
    void revision
    void video
    if (realign !== lastRealign) {
      lastRealign = realign
      appliedRevision = -1
    }
    applyState()
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
    // Consumed: our own `playElement()`. Not consumed: a person or the site,
    // which is a room action (§6.6, ADR-029).
    if (echoes.consume('play', performance.now())) return
    if (video === null) return
    send({ type: 'play', position: video.currentTime })
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
