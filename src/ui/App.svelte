<script lang="ts">
  import { onMount } from 'svelte'

  import {
    ERROR_SENTENCES,
    ROOM_OVER_SENTENCE,
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
  import { PAGE_STAGE_MS, setPageFrame } from '../shared/page.ts'
  import { previewHolds, type PendingPreview } from './preview.ts'
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

  // T03b: §5's address bar. `pageNotice` is the bar's one line: what the field
  // could not use, or why the clipboard was unreadable.
  let pageDraft = $state('')
  let pageNotice = $state<string | null>(null)

  /**
   * T03c: the room's committed page, as `welcome` or the last `pageCommitted`
   * said it — the address everyone else is still watching while a preview runs,
   * and the one Cancel goes back to. `null` in file mode, and in a room that
   * has no page yet.
   */
  let roomPage = $state<string | null>(null)
  /**
   * T03c: this window's own staged page, while the authority's window is open
   * (ADR-032 as amended 2026-11-21). Its presence *is* "a change is pending":
   * the site view is already on `page`, the bar counts down and offers Cancel,
   * and `previewHolds` (ui/preview.ts) keeps this page from behaving as a
   * follower until the window ends. Tickets 06 and 07 consult it; only a frame
   * or a Cancel clears it, never a timer here.
   */
  let pendingPreview = $state<PendingPreview | null>(null)
  /** R29's countdown redraw — a beat that moves the seconds shown, and nothing else. */
  let previewTick = $state(0)

  // §4.1's `playback` as the room last said it, and `revision` beside it (§4.3
  // invariant 2). Only a `welcome` or a `state` writes these; the player is the
  // only reader, and it applies them through `expected()` (invariant 9).
  let playback = $state<Playback | null>(null)
  let revision = $state(0)
  /**
   * The authority epoch this window's room view is stamped with (§4.3 invariant
   * 6): `welcome` says which era the replica belongs to, and every
   * authority-bearing frame this page sends carries it (§5).
   */
  let epoch = $state(0)
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

  /**
   * T03b: §5's address bar follows §4.2 — a room is a site or a file, never both.
   * With a file the bar is gone, so a file room keeps M1's picture, picker and
   * all; with no file it is the way a room becomes a site.
   */
  const showAddressBar = $derived(selfId !== null && media === null)

  /**
   * §14: a file room ends with its owner's app (ADR-024), because the owner's app
   * is the only place the bytes exist. This flag is the whole of this window's
   * answer — an overlay, the room's one system line, and no way back into it (T9b).
   */
  let roomEnded = $state(false)

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
    // T03c: a different connection is a different room, so neither its page nor
    // a preview of the old one survives it.
    roomPage = null
    pendingPreview = null
    roomEnded = false
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
      // T9b: this line is how a check counts joins in a window's own log — one
      // `hello` per connection, so "zero after the room ended" is countable.
      if (dev) console.info('[ws] hello')
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
      if (selfId === null) {
        sentence = UNREACHABLE_ROOM
        return
      }
      // §14: a file room ends when its owner's app does (ADR-024). This window's
      // one connection *is* the owner's app, so its close is the room's end — no
      // reconnect, no freeze, and no second guess about a room that cannot come
      // back. Website mode is unbuilt in M1; when it arrives, a guest's close is
      // the row above this one (authority transfer), and `media`/`page` will say
      // which kind of room this is.
      if (!inOwnRoom) endRoom(false)
    }
  }

  /**
   * §14's "everyone told plainly, no pretend recovery": one flag ends this
   * window's room view. `fromAuthority` says whether the authority already posted
   * the system line — when its process is the thing that went, it could not, so
   * this page states the one fact it is sure of rather than showing chat that
   * silently misses the room's end.
   */
  function endRoom(fromAuthority: boolean): void {
    if (roomEnded) return
    roomEnded = true
    stopPing()
    nudge = null
    if (!fromAuthority) {
      chat = [
        ...chat,
        {
          id: 'room-over',
          kind: 'system',
          name: '',
          text: ROOM_OVER_SENTENCE,
          ts: Date.now(),
        },
      ]
    }
    if (dev) console.info('[room] ended owner-left')
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
      // §5: `welcome` carries the epoch, and `setMedia` sends it back.
      epoch = frame.epoch
      // §4.2 + invariant 9: the snapshot also says which file; a window landing
      // here plays it and realigns below, so a late joiner or a reload arrives
      // where the room is (T9a3).
      media = frame.room.media
      // T03c item 5: the snapshot already carries the room's page, so a window
      // that arrives late — a guest, or this one reconnecting — lands on what
      // everyone is watching instead of waiting for the next change.
      roomPage = frame.room.page
      pendingPreview = null
      if (roomPage !== null) moveSiteView(roomPage)
      realign += 1
      // A late joiner's panel is the ring buffer the authority sent (R5).
      chat = [...frame.chatTail]
      sentence = null
      followNewest(true)
      // The one loop starts once this connection has a member identity to beat for.
      startPing()
    } else if (frame.type === 'state') {
      // ADR-032 as amended: while this window's own preview is up it is not a
      // follower, so the room's frame is held rather than applied — a command
      // aimed at the old film must not drag the preview with it. The commit and
      // the Cancel are the two ways this window rejoins the room.
      if (previewHolds(pendingPreview, frame.type)) return
      // The room's one writer's answer to a command (§5). Older revisions are
      // dropped here so the button and the bar cannot show an undone future;
      // the player applies the same rule to its own copy.
      if (frame.revision < revision) return
      playback = frame.playback
      revision = frame.revision
    } else if (frame.type === 'pageCommitted') {
      // §5: the authority's word that the staged page is now the room's. Every
      // window moves on this frame and on nothing else — the bar's countdown is
      // a label, so no client timer can commit early or late (ADR-032).
      const wasPending = pendingPreview !== null
      // This window's site view is already on the page when the frame is its own
      // preview's: navigating again would reload the page it just loaded, which
      // is the visible revert ADR-032 exists to avoid.
      const previewed = pendingPreview !== null && pendingPreview.page === frame.page
      roomPage = frame.page
      pendingPreview = null
      // Ours, or someone else's that replaced ours (ADR-032's cost line): either
      // way the bar goes back to the address the authority actually committed.
      if (wasPending) pageDraft = frame.page
      if (!previewed) moveSiteView(frame.page)
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
    } else if (frame.type === 'roomOver') {
      // T9b: the authority's last word before it closes this socket. It already
      // posted the system line, so this only ends the view.
      endRoom(true)
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
      // T03c: a staged page the authority refused never commits, so the preview
      // has nothing left to wait for and Cancel would name a window that closed.
      if (frame.code === 'not_controller' || frame.code === 'stale_host') pendingPreview = null
    }
  }

  /** §5's commands and §5's `report`, in the one shape the player hands them over. */
  function sendCommand(frame: CommandFrame | ReportFrame): void {
    if (socket === null || selfId === null) return
    // ADR-032 as amended: what this window measures while a preview is up
    // belongs to the preview's page, not the room's film, so it stays here.
    if (previewHolds(pendingPreview, frame.type)) return
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
      epoch,
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

  /**
   * T03b: Enter in the address bar. `setPageFrame` is the whole decision — a
   * blank field or an unusable address yields no frame, so nothing leaves this
   * window (the authority would otherwise drop it silently, ticket 03).
   */
  function submitPage(event: SubmitEvent): void {
    event.preventDefault()
    if (pageDraft.trim().length === 0) {
      pageNotice = null
      return
    }

    const frame = setPageFrame(pageDraft, epoch)
    if (frame === null) {
      pageNotice = 'That is not a web address — paste a page link like example.com/watch.'
      if (dev) console.info(`[page] refused as unusable: ${pageDraft.trim()}`)
      return
    }
    if (socket === null || selfId === null) {
      pageNotice = 'This window is not in the room, so the address was not sent.'
      return
    }

    socket.send(JSON.stringify(frame))
    pageNotice = null
    // T03c item 1: this window shows the new page at once — the preview — while
    // everyone else keeps the old one until `pageCommitted` (ADR-032). It starts
    // at the instant the frame leaves, because that is when the authority's
    // window starts too.
    pendingPreview = { page: frame.page, epoch, sentAt: Date.now() }
    moveSiteView(frame.page)
    // T03b's live check reads this line's absence for a bad address, so the
    // success is as explicit as the refusal above.
    if (dev) console.info(`[page] setPage ${frame.page}`)
  }

  /**
   * T03c: the only way the site view ever moves (ADR-038) — a `siteCommand` the
   * host performs itself. Nothing outside this window hears of it, which is what
   * makes the preview a preview: a guest's site view is not moved until the
   * authority's `pageCommitted` reaches it.
   */
  function moveSiteView(page: string): void {
    postToHost({ kind: 'siteCommand', payload: { kind: 'navigate', url: page } })
    if (dev) console.info(`[page] site view -> ${page}`)
  }

  /**
   * R29's countdown, in whole seconds, from this window's own clock. It is a
   * label and not the window: the pending preview ends on `pageCommitted`, on a
   * Cancel or on a refusal, never on this number reaching zero — the authority
   * owns the two seconds (ADR-032), and a client timer that decided would be a
   * second authority.
   */
  const previewSeconds = $derived.by(() => {
    void previewTick
    const pending = pendingPreview
    if (pending === null) return 0
    return Math.max(0, Math.ceil((pending.sentAt + PAGE_STAGE_MS - Date.now()) / 1000))
  })

  // R29: the countdown has to move. It runs only while a preview is up, so a
  // window with none has exactly the timers it had before.
  $effect(() => {
    if (pendingPreview === null) return
    const beat = setInterval(() => (previewTick += 1), 250)
    return () => clearInterval(beat)
  })

  /**
   * R29's Cancel: §5's `cancelPage` with this window's epoch, the site view back
   * on the room's committed page, and the countdown gone. That is the whole of
   * it on the wire — "nobody else ever hears of it" (§5), so no chat line, no
   * notice and no toast for the other windows.
   */
  function cancelPreview(): void {
    const pending = pendingPreview
    if (pending === null) return
    pendingPreview = null
    if (socket !== null && selfId !== null) {
      socket.send(JSON.stringify({ type: 'cancelPage', epoch: pending.epoch }))
    }
    // A room that had no page yet has nothing to go back to, and the host has no
    // message that hides the site view again (03d's one gap, reported).
    if (roomPage !== null) moveSiteView(roomPage)
    if (dev) console.info(`[page] cancel ${pending.page}`)
  }

  /**
   * T03b: the visible Paste button. WebView2's own clipboard grant does the
   * reading (the host allows `ClipboardRead` for this one view), and Ctrl+V and
   * the right-click menu are the engine's, so neither passes through here.
   */
  async function pasteAddress(): Promise<void> {
    pageNotice = null
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim().length === 0) {
        pageNotice = 'The clipboard has nothing to paste.'
        return
      }
      pageDraft = text.trim()
    } catch (error) {
      pageNotice = 'This window could not read the clipboard — press Ctrl+V in the field instead.'
      if (dev) console.info(`[page] clipboard read failed: ${String(error)}`)
    }
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

{#if showAddressBar}
  <!-- T03b: R29's address bar, inside the 48 px the host reserves across the
       top. HTML, drawn by this page (ADR-038), so the right-click menu, Ctrl+V
       and a visible Paste button are the engine's own behaviour. The host owns
       the strip's height and nothing else. -->
  <header class="address-bar">
    <form onsubmit={submitPage}>
      <input
        type="text"
        aria-label="Page address"
        placeholder="Paste a page address"
        autocomplete="off"
        spellcheck="false"
        bind:value={pageDraft}
      />
      <button type="button" class="paste" onclick={() => void pasteAddress()}>Paste</button>
    </form>
    {#if pendingPreview !== null}
      <!-- T03c: R29's countdown, beside the address the room is still on, so the
           person can see the change they just made has not landed for anyone
           else yet. At zero the Cancel goes and the row waits for the
           authority's `pageCommitted`: this page keeps no timer that could
           decide the window (ADR-032). -->
      <p class="bar-preview" role="status">
        <span class="bar-committed">Room is on {roomPage ?? 'no page'}</span>
        {#if previewSeconds > 0}
          <span class="bar-countdown">{previewSeconds} s</span>
          <button type="button" class="cancel" onclick={cancelPreview}>Cancel</button>
        {/if}
      </p>
    {/if}
    {#if pageNotice !== null}
      <p class="bar-notice" role="status">{pageNotice}</p>
    {/if}
  </header>
{/if}

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

    {#if roomEnded}
      <!-- §14, T9b: told plainly, with nothing to click that would pretend the
           room can come back. The chat below keeps the one system line. -->
      <section class="ended" role="alert">
        <h2>The room ended</h2>
        <p>{ROOM_OVER_SENTENCE} There is nothing to reconnect to.</p>
      </section>
    {/if}

    {#if selfId !== null}
      {#if playback !== null && !roomEnded}
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
              placeholder={roomEnded ? 'The room ended' : 'Message'}
              autocomplete="off"
              disabled={roomEnded}
              bind:value={chatDraft}
            />
            <button type="submit" disabled={roomEnded}>Send</button>
          </form>
        </section>

        {#if members.length > 0 && !roomEnded}
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

  /* T03b: the 48 px the host reserves across the top, drawn inside the app
     view. Sticky so the address stays reachable while the room scrolls. */
  .address-bar {
    position: sticky;
    top: 0;
    z-index: 5;
    box-sizing: border-box;
    min-height: 48px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.2rem;
    padding: 0.2rem 0.75rem;
    background: #14151a;
    border-bottom: 1px solid #2c2d36;
  }

  .address-bar form {
    align-items: center;
  }

  .address-bar input {
    padding: 0.35rem 0.5rem;
  }

  .address-bar .paste {
    flex: 0 0 auto;
    padding: 0.35rem 0.7rem;
  }

  .bar-notice {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.25;
    color: #ffb3a7;
  }

  /* T03c: the countdown row — the committed address on the left, the seconds and
     Cancel on the right, in the same 0.8rem as the notice so the bar's height
     does not jump while a preview runs. */
  .bar-preview {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.25;
    color: #c9ccd8;
  }

  .bar-committed {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-countdown {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: #a9b4ff;
  }

  .bar-preview .cancel {
    flex: 0 0 auto;
    padding: 0.2rem 0.6rem;
    font-size: 0.8rem;
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

  .ended {
    margin: 1.5rem 0;
    padding: 1rem 1.25rem;
    border: 1px solid #6b3a3a;
    border-radius: 8px;
    background: #24191a;
  }

  .ended h2 {
    margin: 0 0 0.5rem;
    color: #ffb3a7;
  }

  .ended p {
    margin: 0;
    line-height: 1.5;
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
