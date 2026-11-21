<script lang="ts">
  import { onMount } from 'svelte'

  import {
    ERROR_SENTENCES,
    type ChatMessage,
    type CommandFrame,
    type ErrorCode,
    type Media,
    type NudgeFrame,
    type Playback,
    type ReportFrame,
    type ServerFrame,
    type SetMediaFrame,
    type WireMember,
  } from '../shared/protocol.ts'
  import { parseJoinLink, UNREADABLE_LINK, UNREACHABLE_ROOM } from './join.ts'
  import {
    MEASURE_TIMEOUT_MS,
    checkExtension,
    loadRefusal,
    mediaTitle,
    mediaUrl,
    type LoadRefusal,
  } from '../shared/media.ts'
  import { readClockSkew } from './dev-clock.ts'
  import { readDevPlay } from './dev-drift.ts'
  import Player from './Player.svelte'
  import {
    PING_INTERVAL_MS,
    authorityNow,
    emptyEstimate,
    estimateOffset,
    sampleFrom,
    type OffsetEstimate,
  } from '../shared/timing.ts'

  interface DiscoveryResult {
    kind: 'ok' | 'cgnat' | 'upnp_unavailable' | 'timeout'
    externalIp?: string
    mappedPort: number | null
    localPort: number
    detail: string
    addressClass: 'public' | 'private' | 'cgnat' | 'unknown'
    sentence: string
  }

  interface InviteLinks {
    primary: string
    raw: string
    lanRaw: string | null
  }

  interface StartPayload {
    status: 'pending' | 'ready'
    roomCode: string
    lanIp: string | null
    localPort: number
    result: DiscoveryResult | null
    invite: InviteLinks | null
  }

  let payload = $state<StartPayload | null>(null)
  let unreachable = $state(false)
  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  // The room on screen is only ever what the last frame said (T3b item 4):
  // `welcome` starts it, `members` replaces it. No ordering, no names, no
  // presence is worked out here — names and the duplicate suffix arrive ready
  // to show (`WireMember.displayName`), so the page cannot disagree with itself.
  let selfId = $state<string | null>(null)
  let roomCode = $state<string | null>(null)
  let members = $state<WireMember[]>([])
  let sentence = $state<string | null>(null)

  // §4.6's chat, in arrival order only. `welcome.chatTail` starts it and every
  // later `chat` frame appends; the page never writes its own copy of a message
  // and never reorders one (§5: chat is centralised on the broadcast).
  let chat = $state<ChatMessage[]>([])
  /** Refusals and the mute warning, on the panel's own lines rather than the join box. */
  let chatNotices = $state<Array<{ kind: 'warning' | 'error'; text: string }>>([])
  let chatDraft = $state('')
  let chatList = $state<HTMLDivElement | null>(null)

  let joinText = $state('')
  let nameDraft = $state('')

  // §4.1's `playback` as the room last said it, and `revision` beside it (§4.3
  // invariant 2). Only a `welcome` or a `state` writes these; the player is the
  // only reader, and it applies them through `expected()` (invariant 9).
  let playback = $state<Playback | null>(null)
  let revision = $state(0)
  /**
   * A nudge for the player when the room refused this window's command or a
   * `welcome` replaced the room: both mean "put the element back on the room",
   * and neither is a `state` frame of its own.
   */
  let realign = $state(0)
  /**
   * The authority's latest `nudge` for this window (§6.3, T7b2). Only the player
   * reads it; it holds no room state of its own, so it is not part of `playback`.
   */
  let nudge = $state<NudgeFrame | null>(null)
  /**
   * §4.2's `media` as the room last said it (T9a3): `welcome`'s snapshot, and
   * then one `media` frame when the owner picks. Every window plays this same
   * file, and `media.duration` is the owner's measurement — no window here
   * measures it again (§4.2, T9a2 item 3).
   */
  let media = $state<Media | null>(null)
  /**
   * The owner's address, as this window connected to it. A guest's page comes
   * from its own sidecar, which holds no file, so the `<video>` source has to
   * name this origin rather than the page's (`mediaUrl`).
   */
  let ownerOrigin = $state<string | null>(null)
  /** Where the player loads the room's file from, or `null` while the room has none. */
  const playerSrc = $derived(ownerOrigin === null ? null : mediaUrl(ownerOrigin, media))

  let socket: WebSocket | null = null
  /** True once this page has decided which room it dials; the poll never overrides it. */
  let enteredRoom = false

  // T5: the dev-only clock skew and overlay. A shipped page is `vite build`
  // (mode `production`), where this folds to `false` — both the flag and the
  // overlay are dropped from `dist/`, so a shipped member's page can never be
  // bent by a URL. `npm run build:dev` is the build that keeps them.
  const dev = import.meta.env.DEV || import.meta.env.MODE === 'development'
  const clockSkew = dev ? readClockSkew(location.search) : 0
  /**
   * T7b2's dev switch: this window's deliberate stall, or a nudge it never
   * received. `null` in a shipped page, so a released window cannot be asked to
   * drift by a URL (dev-drift.ts, the same arrangement as the skew above).
   */
  const devPlay = dev ? readDevPlay(location.search) : null
  /**
   * This window's clock as §6.1 measures against it. The skew is applied here,
   * at the one place a `Date.now()` is read for the offset, so nothing else in
   * the page has to know the flag exists.
   */
  const localNow = (): number => Date.now() - clockSkew

  /** §6.1's `authorityNow()`, in the one place this window can answer it. */
  const authorityClock = (): number => authorityNow(localNow(), estimate)

  // §6.1's clock. The estimator is the page's own (§4.3 invariant 4), starts at
  // `emptyEstimate()` — "I do not know yet", not 0 ms believed — and is reset by
  // `connect()` on every reconnect. All its arithmetic is `shared/timing.ts`.
  let estimate = $state<OffsetEstimate>(emptyEstimate())
  /** The instants the last `pong` produced, so the overlay can show which way the sign points. */
  let clockSeen = $state<{ local: number; authority: number } | null>(null)
  /** `performance.now()` anchor for the next beat: a wall-clock step must not stretch 5 s. */
  let pingAt = 0
  let pingTimer: ReturnType<typeof setTimeout> | undefined

  // The window's own room keeps the whole start screen; a room someone else
  // started does not have this window's invite link to show.
  const inOwnRoom = $derived(roomCode === null || payload === null || roomCode === payload.roomCode)

  function stopPing(): void {
    if (pingTimer !== undefined) clearTimeout(pingTimer)
    pingTimer = undefined
  }

  /**
   * §6.1: one loop, two jobs — the liveness beat and the clock sample. T5 sends
   * `ping{t0}` every 5 s from the moment the room answers `welcome`, and turns
   * each `pong` into one sample. The cadence is measured on `performance.now()`
   * so that the same clock step the sample is watching for cannot also stretch
   * the interval between samples.
   */
  function pingTick(): void {
    pingTimer = undefined
    if (socket === null || selfId === null) return
    socket.send(JSON.stringify({ type: 'ping', t0: localNow() }))
    pingAt += PING_INTERVAL_MS
    // A window that was asleep catches up with one beat, never a burst of them.
    if (performance.now() - pingAt > PING_INTERVAL_MS) pingAt = performance.now() + PING_INTERVAL_MS
    pingTimer = setTimeout(pingTick, Math.max(0, pingAt - performance.now()))
  }

  function startPing(): void {
    stopPing()
    pingAt = performance.now()
    pingTick()
  }

  function connect(host: string, port: number, code: string): void {
    const previous = socket
    socket = null
    previous?.close()

    selfId = null
    roomCode = null
    members = []
    chat = []
    chatNotices = []
    playback = null
    revision = 0
    media = null
    nudge = null
    // T9a3: this connection's owner — the window and every guest fetch the room's
    // one file from here (`mediaUrl`), never from their own sidecar.
    ownerOrigin = `http://${host}:${port}`
    // T9a2: a different room has a different owner, so a pending pick is gone.
    picking = false
    pickNotice = null
    pickedPath = null
    // §6.1: a reconnect resets the filter rather than feeding it an offset that
    // belonged to the previous connection's clock.
    stopPing()
    estimate = emptyEstimate()
    clockSeen = null

    let opened: WebSocket
    try {
      opened = new WebSocket(`ws://${host}:${port}/`)
    } catch {
      sentence = UNREACHABLE_ROOM
      return
    }

    socket = opened
    opened.onopen = () => {
      if (opened !== socket) return
      // R26: no name, so the member appears as `anonymous`; the roster renames.
      opened.send(JSON.stringify({ type: 'hello', code }))
    }
    opened.onmessage = (event: MessageEvent) => {
      if (opened !== socket) return
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame
      } catch {
        return
      }
      apply(frame)
    }
    opened.onclose = () => {
      if (opened !== socket) return
      socket = null
      stopPing()
      if (selfId === null) sentence = UNREACHABLE_ROOM
    }
  }

  /** The chat refusals are the panel's business; every other error stays a sentence. */
  function isChatRefusal(code: ErrorCode): boolean {
    return code === 'chat_too_long' || code === 'chat_rate_limited' || code === 'chat_byte_limit'
  }

  /** True when the panel is close enough to the end that a new line should follow it. */
  function atBottom(): boolean {
    const list = chatList
    if (list === null) return true
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 8
  }

  /**
   * Ask the next DOM update to stay at the newest line. The effect below also
   * runs when the panel first mounts (a late joiner's welcome arrives before
   * its list exists), so the tail is scrolled once there is something to scroll.
   */
  let stickToBottom = $state(false)
  $effect(() => {
    const list = chatList
    void chat.length
    void chatNotices.length
    if (!stickToBottom || list === null) return
    stickToBottom = false
    list.scrollTop = list.scrollHeight
  })

  function followNewest(stick: boolean): void {
    if (stick) stickToBottom = true
  }

  function notice(kind: 'warning' | 'error', text: string): void {
    const stick = atBottom()
    chatNotices = [...chatNotices, { kind, text }]
    followNewest(stick)
  }

  function apply(frame: ServerFrame): void {
    if (frame.type === 'welcome') {
      selfId = frame.selfId
      roomCode = frame.room.code
      members = frame.members
      // §4.3 invariant 9: a fresh welcome is a new room view. `realign` tells
      // the player to put the element on it, whatever it had before (a reload,
      // a reconnect, a different room).
      playback = frame.room.playback
      revision = frame.room.revision
      // §4.2 + invariant 9: the snapshot also says which file; a window landing
      // here plays it and realigns below, so a late joiner or a reload arrives
      // where the room is (T9a3).
      media = frame.room.media
      realign += 1
      // A late joiner's panel is the ring buffer the authority sent (R5).
      chat = [...frame.chatTail]
      sentence = null
      followNewest(true)
      // The one loop starts once this connection has a member identity to beat for.
      startPing()
    } else if (frame.type === 'state') {
      // The room's one writer's answer to a command (§5). Older revisions are
      // dropped here so the button and the bar cannot show an undone future;
      // the player applies the same rule to its own copy.
      if (frame.revision < revision) return
      playback = frame.playback
      revision = frame.revision
    } else if (frame.type === 'media') {
      // T9a3: the owner picked a file while this window was already here. The
      // player gets a new source and is put on the room's position (invariant 9),
      // exactly as a `welcome` that carried the same field would.
      media = frame.media
      realign += 1
    } else if (frame.type === 'nudge') {
      // §6.3, to this window only: a rate and the authority instant it ends by.
      // It is handed to the player as a new object, so the same nudge cannot be
      // applied twice by a re-render.
      nudge = frame
    } else if (frame.type === 'members') {
      members = frame.members
    } else if (frame.type === 'chat') {
      const stick = atBottom()
      chat = [...chat, frame]
      followNewest(stick)
    } else if (frame.type === 'pong') {
      // §6.1: t0 is ours (echoed untouched), t1/t2 the authority's, t3 this
      // instant. The estimate, the jump reset and the sign all live in timing.ts.
      const t3 = localNow()
      const sample = sampleFrom(frame.t0, frame.t1, frame.t2, t3)
      if (sample === null) return
      estimate = estimateOffset(sample, estimate)
      clockSeen = { local: t3, authority: authorityNow(t3, estimate) }
    } else if (frame.type === 'warning') {
      notice('warning', frame.message)
    } else if (frame.type === 'error') {
      // T3b item 5: one sentence, no code and no jargon. A chat refusal belongs
      // beside the messages it refused; anything else keeps the join box.
      if (isChatRefusal(frame.code)) notice('error', ERROR_SENTENCES[frame.code])
      else sentence = ERROR_SENTENCES[frame.code]
      // ADR-030/§14: a room action this window was not allowed to make is
      // undone locally too. Explaining it is not enough — the gesture already
      // moved this element, and the room did not move with it.
      if (frame.code === 'not_controller') realign += 1
    }
  }

  /** §5's commands and §5's `report`, in the one shape the player hands them over. */
  function sendCommand(frame: CommandFrame | ReportFrame): void {
    if (socket === null || selfId === null) return
    socket.send(JSON.stringify(frame))
  }

  // ---- T9a2: the owner's picker --------------------------------------------------

  /**
   * The host's message bridge (ADR-034). The path is produced by the native
   * dialog in the host, and a page never names one; a plain browser tab has no
   * bridge, so there is no picker to offer there.
   */
  interface HostWebview {
    postMessage(message: unknown): void
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  }

  function hostWebview(): HostWebview | null {
    const chrome = (window as unknown as { chrome?: { webview?: HostWebview } }).chrome
    return chrome?.webview ?? null
  }

  const host = hostWebview()

  let picking = $state(false)
  let pickNotice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** The host's latest answer; a measurement that finishes after a newer pick is dropped. */
  let pickedPath: string | null = null

  /** §7.2: only the window whose own sidecar owns this room may pick a file. */
  const canPick = $derived(selfId !== null && inOwnRoom)

  function postToHost(message: unknown): void {
    host?.postMessage(message)
  }

  function requestFile(): void {
    if (host === null) {
      pickNotice = { kind: 'error', text: "The file picker is only in the app's window, not in a browser tab." }
      return
    }
    picking = true
    pickNotice = null
    pickedPath = null
    postToHost({ kind: 'pick' })
  }

  /** Nothing was sent, so the room is still on what it had — and the host stops exposing the file. */
  function refusePick(sentence: string): void {
    picking = false
    pickedPath = null
    pickNotice = { kind: 'error', text: sentence }
    postToHost({ kind: 'probeDone' })
  }

  function onHostMessage(event: MessageEvent): void {
    const message: unknown = event.data
    if (typeof message !== 'object' || message === null) return
    const kind = (message as { kind?: unknown }).kind

    if (kind === 'picked') {
      const path = (message as { path?: unknown }).path
      if (typeof path !== 'string') {
        refusePick('The file picker answered with no file name.')
        return
      }
      // The first check, before the file is loaded or anyone hears of it.
      const check = checkExtension(path)
      if (!check.playable) {
        refusePick(check.refusal)
        return
      }
      pickedPath = path
      postToHost({ kind: 'probe', type: check.contentType })
      return
    }

    if (kind === 'probeReady') {
      const url = (message as { url?: unknown }).url
      if (pickedPath === null) {
        picking = false
        return
      }
      if (typeof url !== 'string') {
        refusePick('The app could not read the file it chose.')
        return
      }
      void measureAndRegister(pickedPath, url)
      return
    }

    if (kind === 'cancelled') {
      picking = false
      return
    }

    if (kind === 'failed') {
      const sentence = (message as { sentence?: unknown }).sentence
      refusePick(typeof sentence === 'string' ? sentence : 'The app could not read the file it chose.')
    }
  }

  /**
   * The second check (§7.2): the owner's own page loads the file and waits for
   * `loadedmetadata`. Only a duration above zero means the room may have it,
   * and that duration is the one written to the room — measured once, here.
   */
  async function measureAndRegister(path: string, url: string): Promise<void> {
    const outcome = await measureFile(url)
    postToHost({ kind: 'probeDone' })
    if (path !== pickedPath) return

    if (outcome.kind !== 'ok') {
      refusePick(loadRefusal(path, outcome.kind))
      return
    }
    if (socket === null || selfId === null) {
      refusePick(`${mediaTitle(path)} was measured, but this window is not in the room.`)
      return
    }

    const frame: SetMediaFrame = {
      type: 'setMedia',
      id: crypto.randomUUID(),
      title: mediaTitle(path),
      duration: outcome.duration,
      path,
    }
    socket.send(JSON.stringify(frame))
    picking = false
    pickedPath = null
    pickNotice = {
      kind: 'ok',
      text: `Picked ${mediaTitle(path)} — this window measured ${outcome.duration.toFixed(1)} s.`,
    }
  }

  type Measurement = { kind: 'ok'; duration: number } | { kind: LoadRefusal }

  /** One throwaway `<video>`: metadata only, never played, and always cleaned up. */
  function measureFile(url: string): Promise<Measurement> {
    return new Promise((settle) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true

      let done = false
      const finish = (outcome: Measurement): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        video.removeAttribute('src')
        video.load()
        settle(outcome)
      }

      const timer = setTimeout(() => finish({ kind: 'timeout' }), MEASURE_TIMEOUT_MS)
      video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          finish({ kind: 'ok', duration: video.duration })
        } else {
          finish({ kind: 'no-duration' })
        }
      })
      video.addEventListener('error', () => finish({ kind: 'error' }))
      video.src = url
    })
  }

  function submitJoin(event: SubmitEvent): void {
    event.preventDefault()
    const target = parseJoinLink(joinText)
    if (target === null) {
      sentence = UNREADABLE_LINK
      return
    }
    enteredRoom = true
    connect(target.host, target.port, target.code)
  }

  function submitRename(event: SubmitEvent): void {
    event.preventDefault()
    if (socket === null || selfId === null) return
    // A blank draft is sent as written; the room turns it into `anonymous`
    // (R26). Normalising here would be a second copy of `normalizeName`.
    socket.send(JSON.stringify({ type: 'rename', name: nameDraft }))
  }

  function submitChat(event: SubmitEvent): void {
    event.preventDefault()
    if (socket === null || selfId === null) return
    const text = chatDraft
    if (text.length === 0) return
    // The only way a line reaches the panel is this gate and the broadcast that
    // comes back (T4). The page never appends its own copy first.
    socket.send(JSON.stringify({ type: 'chat', text }))
    chatDraft = ''
  }

  /** `hh:mm:ss.mmm`, for the overlay's two clocks: the sign of an offset is easier to read than argue. */
  function clock(ms: number): string {
    const date = new Date(ms)
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  }

  async function refresh(): Promise<void> {
    clearTimeout(timer)
    try {
      const response = await fetch('/discovery', { cache: 'no-store' })
      if (!response.ok) throw new Error(`discovery answered ${response.status}`)
      payload = (await response.json()) as StartPayload
      unreachable = false
      if (!enteredRoom) {
        // The window loads this page from 127.0.0.1, so its own connection is
        // the local one, and the owner seat is settled on it (socket.ts).
        enteredRoom = true
        connect(location.hostname, Number(location.port), payload.roomCode)
      }
      if (payload.status === 'pending') timer = setTimeout(() => void refresh(), 750)
    } catch {
      unreachable = true
    }
  }

  async function retry(): Promise<void> {
    try {
      await fetch('/discovery/retry', { method: 'POST' })
    } finally {
      await refresh()
    }
  }

  async function copy(): Promise<void> {
    const text = payload?.invite?.primary
    if (text === undefined) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  onMount(() => {
    // R26's no-typing path: `?join=<encoded link>` is parsed before the first
    // discovery answer can claim this window's own room.
    const prefilled = new URLSearchParams(location.search).get('join')
    if (prefilled !== null) {
      enteredRoom = true
      joinText = prefilled
      const target = parseJoinLink(prefilled)
      if (target === null) sentence = UNREADABLE_LINK
      else connect(target.host, target.port, target.code)
    }

    void refresh()
    host?.addEventListener('message', onHostMessage)
    return () => {
      host?.removeEventListener('message', onHostMessage)
      clearTimeout(timer)
      stopPing()
    }
  })
</script>

<main>
  <h1>Watch Party</h1>

  {#if unreachable}
    <p class="sentence">The room process is not answering. Close the window and start Watch Party again.</p>
  {:else if payload === null}
    <p class="sentence">Starting the room…</p>
  {:else}
    <p class="room">Room code <strong>{roomCode ?? payload.roomCode}</strong></p>

    {#if inOwnRoom}
      <h2>Start a room</h2>

      {#if payload.status === 'pending'}
        <p class="sentence">Asking your router to open a port…</p>
      {:else if payload.result !== null}
        <p class="sentence">{payload.result.sentence}</p>

        {#if payload.invite !== null}
          <section class="invite">
            <p class="label">Invite link</p>
            <p class="link">{payload.invite.primary}</p>
            <button type="button" onclick={() => void copy()}>{copied ? 'Copied' : 'Copy invite link'}</button>
            <p class="label fallback">If the link does not open, paste this:</p>
            <p class="link raw">{payload.invite.raw}</p>
            {#if payload.invite.lanRaw !== null && payload.invite.lanRaw !== payload.invite.raw}
              <p class="label fallback">On this network:</p>
              <p class="link raw">{payload.invite.lanRaw}</p>
            {/if}
          </section>
        {/if}

        <p class="detail">{payload.result.detail}</p>
      {/if}

      {#if payload.status === 'ready'}
        <button type="button" class="secondary" onclick={() => void retry()}>Try again</button>
      {/if}

      {#if canPick}
        <section class="pick">
          <h2>File mode</h2>
          <button type="button" data-pick onclick={requestFile} disabled={picking || host === null}>
            {picking ? 'Waiting for the file…' : 'Open a file'}
          </button>
          {#if pickNotice !== null}
            <p class="notice {pickNotice.kind}" role="status">{pickNotice.text}</p>
          {/if}
        </section>
      {/if}
    {:else}
      <h2>You joined a room</h2>
      <p class="sentence">Someone else started this one, so the link above is not yours to share.</p>
    {/if}

    <section class="join">
      <h2>Join a room</h2>
      <form onsubmit={submitJoin}>
        <input
          type="text"
          aria-label="Invite link"
          placeholder="Paste the invite link someone sent you"
          bind:value={joinText}
        />
        <button type="submit">Join</button>
      </form>
      {#if sentence !== null}
        <p class="sentence error" role="status">{sentence}</p>
      {/if}
    </section>

    {#if selfId !== null}
      {#if playback !== null}
        <Player
          {playback}
          {revision}
          {realign}
          {nudge}
          {media}
          src={playerSrc}
          {devPlay}
          clock={authorityClock}
          rtt={() => estimate.rtt}
          send={sendCommand}
        />
      {/if}

      <div class="room-body">
        <section class="chat" aria-label="Chat">
          <h2>Chat</h2>
          <div class="messages" bind:this={chatList}>
            {#each chat as message (message.id)}
              {#if message.kind === 'system'}
                <p class="system">{message.text}</p>
              {:else}
                <p class="message" class:mine={message.memberId === selfId}>
                  <span class="author">{message.name}</span>
                  {#if message.memberId === selfId}<span class="you">you</span>{/if}
                  <span class="text">{message.text}</span>
                </p>
              {/if}
            {/each}
            {#each chatNotices as entry, index (index)}
              <p class="notice {entry.kind}" role="status">{entry.text}</p>
            {/each}
          </div>
          <form onsubmit={submitChat}>
            <input
              type="text"
              aria-label="Message"
              placeholder="Message"
              autocomplete="off"
              bind:value={chatDraft}
            />
            <button type="submit">Send</button>
          </form>
        </section>

        {#if members.length > 0}
          <section class="roster">
            <h2>In this room</h2>
            <ul>
              {#each members as member (member.id)}
                <li>
                  <span class="dot {member.status}" title={member.status}></span>
                  <span class="name">{member.displayName}</span>
                  {#if member.id === selfId}<span class="you">you</span>{/if}
                </li>
              {/each}
            </ul>

            {#if selfId !== null}
              <form onsubmit={submitRename}>
                <input type="text" aria-label="Your name" placeholder="Your name" bind:value={nameDraft} />
                <button type="submit">Set name</button>
              </form>
            {/if}
          </section>
        {/if}
      </div>
    {/if}
  {/if}

  {#if dev}
    <!-- T5: every later timing ticket is diagnosed with these numbers. Dev only:
         the whole block, inline styles included, is dropped from `vite build`. -->
    <aside
      aria-label="Clock sync (dev)"
      style="position:fixed;right:0.75rem;bottom:0.75rem;z-index:10;padding:0.5rem 0.75rem;border:1px solid #3a3b46;border-radius:6px;background:rgba(20,21,26,0.92);font-family:Consolas,monospace;font-size:0.78rem;line-height:1.55;color:#9a9aab;text-align:left"
    >
      <div>offset <strong>{estimate.offset.toFixed(1)} ms</strong></div>
      <div>rtt <strong>{estimate.rtt.toFixed(1)} ms</strong> · <strong>{estimate.samples}</strong> samples</div>
      {#if clockSeen !== null}
        <div>local {clock(clockSeen.local)} · authority {clock(clockSeen.authority)}</div>
      {/if}
      {#if clockSkew !== 0}
        <div>dev skew <strong>{clockSkew} ms</strong> (this clock slow)</div>
      {/if}
    </aside>
  {/if}
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #14151a;
    color: #e9e9ef;
    font-family: 'Segoe UI', system-ui, sans-serif;
  }

  main {
    padding: 2.5rem 3rem;
    max-width: 52rem;
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 2rem;
    letter-spacing: -0.02em;
  }

  h2 {
    margin: 1.75rem 0 0.75rem;
    font-size: 1.05rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #c8c8d2;
  }

  .room {
    margin: 0 0 1.5rem;
    color: #9a9aab;
  }

  .room strong {
    font-family: Consolas, monospace;
    font-size: 1.15rem;
    letter-spacing: 0.12em;
    color: #e9e9ef;
  }

  .sentence {
    margin: 0 0 1.5rem;
    font-size: 1.1rem;
    line-height: 1.5;
  }

  .sentence.error {
    margin: 0.75rem 0 0;
    color: #ffb3a7;
  }

  .invite {
    padding: 1rem 1.25rem;
    margin: 0 0 1.5rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
  }

  .label {
    margin: 0 0 0.35rem;
    font-size: 0.85rem;
    color: #9a9aab;
  }

  .label.fallback {
    margin-top: 1rem;
  }

  .link {
    margin: 0 0 0.75rem;
    font-family: Consolas, monospace;
    font-size: 0.95rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
    color: #7fd0a5;
  }

  .link.raw {
    color: #e9e9ef;
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin: 0;
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.45rem 0.6rem;
    border: 1px solid #3a3b46;
    border-radius: 6px;
    background: #1a1b22;
    color: #e9e9ef;
    font: inherit;
  }

  ul {
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.35rem 0;
    font-size: 1.05rem;
  }

  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: #5a5a66;
  }

  .dot.online {
    background: #3ec78a;
  }

  .dot.suspect {
    background: #e0b34a;
  }

  .dot.offline {
    background: #5a5a66;
  }

  .name {
    overflow-wrap: anywhere;
  }

  .you {
    padding: 0.05rem 0.4rem;
    border: 1px solid #3b6f5a;
    border-radius: 999px;
    font-size: 0.75rem;
    color: #7fd0a5;
  }

  .room-body {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 2rem;
  }

  .chat {
    flex: 2 1 22rem;
    min-width: 0;
  }

  .roster {
    flex: 1 1 12rem;
    min-width: 0;
  }

  .messages {
    height: 20rem;
    overflow-y: auto;
    padding: 0.5rem 0.75rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
  }

  .message,
  .system,
  .notice {
    margin: 0 0 0.5rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .message .author {
    margin-right: 0.45rem;
    font-weight: 600;
    color: #c8c8d2;
  }

  .message.mine {
    padding-left: 0.6rem;
    border-left: 2px solid #3b6f5a;
  }

  .message.mine .author {
    color: #7fd0a5;
  }

  .message .text {
    white-space: pre-wrap;
  }

  .system {
    color: #7a7a88;
    font-style: italic;
  }

  .notice.error {
    color: #ffb3a7;
  }

  .notice.warning {
    color: #e0b34a;
  }

  .chat form {
    margin-top: 0.6rem;
  }

  button {
    padding: 0.45rem 0.9rem;
    border: 1px solid #3b6f5a;
    border-radius: 6px;
    background: #1f3a30;
    color: #d7f5e6;
    font: inherit;
    cursor: pointer;
  }

  button.secondary {
    border-color: #3a3b46;
    background: #22232c;
    color: #c8c8d2;
  }

  .detail {
    margin: 0;
    font-family: Consolas, monospace;
    font-size: 0.8rem;
    color: #6f6f7e;
  }

  .pick {
    margin: 0 0 1.5rem;
  }

  .pick button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .pick .notice {
    margin: 0.75rem 0 0;
    font-size: 1.05rem;
  }

  .pick .notice.ok {
    color: #7fd0a5;
  }
</style>
