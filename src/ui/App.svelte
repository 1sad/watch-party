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
    type PlaybackReason,
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
  import { PAGE_STAGE_MS, canonicalPage, playbackAfterPageCommit, setPageFrame } from '../shared/page.ts'
  import { previewHolds, type PendingPreview } from './preview.ts'
  import {
    closeOutcome,
    pageSide,
    pageCommitFields,
    pageFollowStep,
    screenFor,
    siteAfterPreview,
    HIDE_SITE_MESSAGE,
    NO_PUT_BACKS,
    type PutBackRecord,
  } from './room-view.ts'
  import {
    POPUP_NOTICE_MS,
    expirePopup,
    noPopups,
    notePopup,
    popupSentence,
    type PopupState,
  } from './popup-notice.ts'
  import { readClockSkew } from './dev-clock.ts'
  import { readDevPlay } from './dev-drift.ts'
  import { dismissNotice, raiseNotice, reapNotices, type Notice } from './notices.ts'
  import { CHAT_MUTE_MS } from '../shared/chat.ts'
  import Player from './Player.svelte'
  import {
    PLAYER_MESSAGE_KINDS,
    documentsLeft,
    elect,
    mergeReports,
    reportIsNewer,
    type FrameCandidate,
    type FrameReport,
    type PlayerCandidate,
    type PlayerEvent,
    type PlayerReason,
  } from '../shared/player.ts'
  import {
    ALIGN_TOLERANCE_MS,
    alignmentOverdue,
    createSiteEchoes,
    createSiteNudge,
    decidePageEvent,
    driftFromPlayer,
    driftLogDue,
    echoEntries,
    followerStep,
    planFromState,
    reportFromPlayer,
    type FollowerStep,
    type PagePlan,
    type PlayerActionEvent,
    type PlayerPageCommand,
  } from '../shared/site-player.ts'
  import {
    NUDGE_WATCH_MS,
    PING_INTERVAL_MS,
    authorityNow,
    emptyEstimate,
    estimateOffset,
    sampleFrom,
    type OffsetEstimate,
  } from '../shared/timing.ts'

  interface DiscoveryResult {
    kind: 'ok' | 'cgnat' | 'upnp_unavailable' | 'no_gateway' | 'timeout'
    externalIp?: string
    mappedPort: number | null
    localPort: number
    detail: string
    addressClass: 'public' | 'private' | 'cgnat' | 'unknown'
    /** The router's own refusal code, or null when none arrived (T73). */
    faultCode: number | null
    /** The gateway's LAN address, the page a person opens to forward by hand (T73). */
    gatewayIp: string | null
    /** The arms that produced no answer at all (T73). */
    silent: string[]
    /** True when mapping was deliberately skipped with WATCHPARTY_NO_MAP (T73). */
    mappingDisabled: boolean
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
  /**
   * T64: this window joined from a link (or the box), so the room it shows is
   * someone else's. `/discovery` no longer answers a guest (`app.ts`), and a
   * guest's page must not be drawn as the host's own start screen.
   */
  let fromLink = $state(false)
  let unreachable = $state(false)
  let copied = $state(false)
  /** T97: the invite bar's disclosure - the raw address/code fallback, opened one click in. */
  let inviteOpen = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  // The room on screen is only ever what the last frame said (T3b item 4):
  // `welcome` starts it, `members` replaces it. No ordering, no names, no
  // presence is worked out here — names and the duplicate suffix arrive ready
  // to show (`WireMember.displayName`), so the page cannot disagree with itself.
  let selfId = $state<string | null>(null)
  let roomCode = $state<string | null>(null)
  let members = $state<WireMember[]>([])
  /**
   * T154 / ADR-049: the roster is a count, not a list. The people the authority
   * has heard from - `offline` is 20 s of silence (§4.4), so a closed window's
   * member leaves the count and the names without leaving the frame. The same
   * list is the header's number and the rows under it, so the two cannot say
   * different things.
   */
  const present = $derived(members.filter((member) => member.status !== 'offline'))
  /** ADR-049: the names are closed until a press opens them. */
  let rosterOpen = $state(false)
  /**
   * ADR-033 + ADR-049: the crown marks the room's **owner**, which is the
   * snapshot's `owner` and never `controllers` - control can be granted, so a
   * crown read from `controllers` would move to whoever was handed the controls.
   * The owner never changes hands for the life of a room (ADR-024).
   */
  let roomOwner = $state<string | null>(null)
  let sentence = $state<string | null>(null)

  // §4.6's chat, in arrival order only. `welcome.chatTail` starts it and every
  // later `chat` frame appends; the page never writes its own copy of a message
  // and never reorders one (§5: chat is centralised on the broadcast).
  let chat = $state<ChatMessage[]>([])
  /**
   * T149 / ADR-049: the room's transient lines - muted, too many messages, the
   * player has not caught up, put back - as notices with an end and a dismiss,
   * drawn between the messages and the input. They are not chat: nothing here
   * enters the ring buffer, so a late joiner never reads tonight's mute.
   * `src/ui/notices.ts` owns when a line goes; this page owns why it was raised.
   */
  let notices = $state<Notice[]>([])
  /** Every accepted line of this person's chat, so the flood notice can end on
   *  the next one (ADR-049). Only `user` messages count: a system line is the
   *  room's news, not this member's message being accepted. */
  let chatAccepted = $state(0)
  let chatDraft = $state('')
  let chatList = $state<HTMLDivElement | null>(null)

  let joinText = $state('')
  let nameDraft = $state('')

  // T03b: §5's address bar. `pageNotice` is the bar's one line: what the field
  // could not use, why the clipboard was unreadable, or (T105) why a guest's
  // site view was put back.
  let pageDraft = $state('')
  let pageNotice = $state<string | null>(null)
  /**
   * T95b: the field itself, so a refused clipboard read can leave the caret
   * where the person's Ctrl+V would go.
   */
  let addressInput = $state<HTMLInputElement | null>(null)

  /**
   * T04b: R37's line in the same top row. The host cancels every `window.open`
   * the site asks for and posts which host asked; this page owns the sentence
   * (ADR-038). One line per host per navigation, cleared on its own after
   * `POPUP_NOTICE_MS` — the rule and the reasons are `ui/popup-notice.ts`.
   */
  let popups = $state<PopupState>(noPopups())
  let popupTimer: ReturnType<typeof setTimeout> | undefined

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
  const playerSrc = $derived(ownerOrigin === null ? null : mediaUrl(ownerOrigin, media, roomCode))

  /**
   * T07 item 2's one line. A page that has not been put on the room's position
   * within §6.3's hard-seek threshold is visibly behind, and saying so is
   * better than leaving a window that looks stuck (06b's reload finding).
   */
  const ALIGN_LATE_SENTENCE = "The site's player has not caught up with the room yet."

  /**
   * §14: a file room ends with its owner's app (ADR-024), because the owner's app
   * is the only place the bytes exist. T98 / ADR-047: the room's own `roomOver`
   * word is the only thing that sets this, and the window then goes back to its
   * own first screen (`endRoom`); a bare close is a lost connection instead.
   */
  let roomEnded = $state(false)

  /**
   * T98 / ADR-047: the first screen's one line after a room ended. It is not
   * `roomEnded`, because `refresh()` reconnects to this machine's own sidecar and
   * `connect()` clears `roomEnded` for the new connection while the line stays
   * until the person enters a room again.
   */
  let endedNotice = $state(false)

  /**
   * T98 / `spec.md` §6's "connection drops": a close with no `roomOver` leaves
   * the watching screen and one line saying so; nothing is cleared, and there is
   * deliberately no retry (rejoining is M3's, section 13).
   */
  let connectionLost = $state(false)

  /**
   * ADR-047 / T95: the window has **entered** its room, so it is past the front
   * door and on the room's own screen. It is window-local and does not cross the
   * wire, and it is not `enteredRoom` below: that flag keeps the boot poll's one
   * connection from being made twice, and both are meant to exist (ADR-047).
   * T95 sets it from **Start a room** (the host's own room), and T110 sets it
   * from the first `welcome` in a room that is not this window's own - a guest
   * is in the room as soon as the room says so, never on the attempt. Ticket 98
   * resets it when the room ends.
   */
  let entered = $state(false)
  /** ADR-047: the one screen on show, decided by `ui/room-view.ts`'s `screenFor`. */
  const screen = $derived(screenFor({ entered, roomEnded }))

  /**
   * T03b: §5's address bar follows §4.2 — the room's committed state is a site or
   * a file, never both, and a staged preview does not change it.
   * T37 / ADR-038's amendment: a room that holds a file **may take a page**, so
   * the bar stays available while a file plays and that transition has a route.
   * T95 / ADR-047: what decides the bar on screen is the **screen**, not
   * membership — the first screen is the front door and carries no address bar,
   * and the room's controls live on the watching screen.
   */
  const showAddressBar = $derived(screen === 'watching')

  $effect(() => {
    // T95 / ADR-047: the screen is on the root element, so the page's CSS and a
    // check can name it without reading the markup.
    document.documentElement.dataset.screen = screen
  })

  /**
   * T99 / ADR-047 ("the host's dock wins"): `chat` while the host docks the app
   * view as a column - website mode, and the staged-preview second while a file
   * room previews a page - and null otherwise. The host sets `data-panel` on the
   * root element after every dock change and once the app view has loaded, so the
   * page watches it rather than reading it once. With `chat` the page draws the
   * chat column alone and no picture, and that wins over `data-layout` at every
   * window width: a narrow page-mode window must not draw a second, empty
   * picture (the narrow dock that makes it narrow is ticket 107).
   */
  let panel = $state<string | null>(null)

  /** T95: Start a room enters the room that is already live; it creates nothing. */
  function enterRoom(): void {
    endedNotice = false
    entered = true
  }

  let socket: WebSocket | null = null
  /** True once this page has decided which room it dials; the poll never overrides it. */
  let enteredRoom = false
  /**
   * T98 / ADR-047 and §14: this connection saw the room's own `roomOver` frame.
   * `closeOutcome` (ui/room-view.ts) reads it beside the close, so only the
   * room's word ends a room and a bare close is a lost connection (§6).
   */
  let roomOverSeen = false

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
  // started does not have this window's invite link to show. A window that
  // joined from a link is never in its own room, whatever a frame says (T64).
  const inOwnRoom = $derived(
    !fromLink && (roomCode === null || payload === null || roomCode === payload.roomCode),
  )

  /**
   * T150: the empty picture's one line, in the role's terms. A guest waits for
   * the host to pick; the owner is the one who picks, so it is never told to
   * wait for itself. The page and `Player` both draw this one string.
   */
  const emptyPictureLine = $derived(
    inOwnRoom ? 'Pick a page or a file to start.' : 'Waiting for the host to pick something.',
  )

  /**
   * T127 / ADR-047 ("room end"): only the window whose own sidecar owns the room
   * hears a goodbye when its page unloads, so the host waits for one only there.
   * That is a window-local fact like `data-layout`, never room state the host
   * reads (ADR-034): this page says which way it goes, on a change and once on
   * load, because a fresh document has to say it again. A guest's own sidecar has
   * no owner to lose, so its window closing at once is right.
   *
   * T133: the ownership, not the entry. The room is live from the sidecar's boot
   * (ADR-047), so a host still on its first screen already owns the room a guest
   * joined; waiting for `entered` there let the close stop the sidecar before its
   * `[room] over`, and every early guest was left on a lost connection. `entered`
   * is not part of this because `inOwnRoom` already answers it: false for a guest,
   * for a window that came by a link, and for a host that joined another room.
   */
  $effect(() => {
    postToHost({ kind: 'ownRoom', own: inOwnRoom })
  })

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
    notices = []
    playback = null
    revision = 0
    media = null
    nudge = null
    // T14: a different room is a different site view; whatever rate this window
    // held goes back to 1 before its element is left behind.
    endSiteNudge()
    // T03c: a different connection is a different room, so neither its page nor
    // a preview of the old one survives it.
    roomPage = null
    pendingPreview = null
    roomEnded = false
    // T98: another connection is another socket, so neither the last one's
    // `roomOver` word nor its lost line belongs to this one.
    roomOverSeen = false
    connectionLost = false
    // T9a3: this connection's owner — the window and every guest fetch the room's
    // one file from here (`mediaUrl`), never from their own sidecar.
    ownerOrigin = `http://${host}:${port}`
    // T9a2: a different room has a different owner, so a pending pick is gone.
    picking = false
    pickNotice = null
    pickedPath = null
    // T04b: another room is another site view, so a popup notice and what it
    // already announced do not survive the connection.
    stopPopupTimer()
    popups = noPopups()
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
      // T98 / ADR-047 and `spec.md` §6: the close is read, never assumed. Only
      // the room's own `roomOver` word ends a room (§14, and the sidecar sends
      // it before closing every socket); a close with no word is a dropped
      // connection, which leaves the room alone until M3 can rejoin it (section
      // 13). The rule is `closeOutcome`, held by a unit test.
      const outcome = closeOutcome({ sawRoomOver: roomOverSeen, closed: true })
      if (outcome === 'lost') loseConnection()
      else if (outcome === 'ended') endRoom()
    }
  }

  /**
   * T98 / ADR-047 and §14: the room's own `roomOver` word ends the room. The
   * window goes back to the **first screen**, and because that screen is this
   * machine's own front door the dead room's state is cleared in full - code,
   * invite, chat, roster, playback, media - and `refresh()` dials this machine's
   * own sidecar rather than the dead room's closed socket. Only a close that
   * follows that word reaches here; a bare close is `loseConnection` below.
   */
  function endRoom(): void {
    if (roomEnded) return
    roomEnded = true
    // The one line the first screen keeps: it says what happened, and it stays
    // until the person enters a room again (`enterRoom`, `submitJoin`).
    endedNotice = true
    connectionLost = false
    stopPing()
    nudge = null
    // T14: a room that is over must not leave a sped-up element behind.
    endSiteNudge()
    // The room's state goes with it, every field of it: a dead room's code,
    // invite, chat or roster must not appear on this machine's own front door.
    selfId = null
    roomCode = null
    members = []
    chat = []
    notices = []
    playback = null
    revision = 0
    media = null
    ownerOrigin = null
    roomPage = null
    pendingPreview = null
    pageDraft = ''
    // A guest's join box still holds the link it arrived by; that link names
    // the dead room's code, so the first screen must not show it either.
    joinText = ''
    chatDraft = ''
    nameDraft = ''
    sentence = null
    hideSiteView()
    // The closed socket is no longer this window's, so its close event cannot
    // claim the new connection (`opened !== socket` above).
    const dead = socket
    socket = null
    dead?.close()
    // ADR-047: the first screen is the room's front door. `payload` is that
    // machine's own `/discovery` answer, so the poll below reconnects to the
    // local sidecar - a guest's page is served from its own loopback - and
    // shows its own code and link.
    payload = null
    fromLink = false
    entered = false
    enteredRoom = false
    void refresh()
    if (dev) console.info('[room] ended owner-left')
  }

  /**
   * T98 / `spec.md` §6's "connection drops": a close with no `roomOver` frame is
   * not the end of the room. The watching screen, the room's code, chat, roster
   * and playback all stay, and one line says the connection was lost. No retry
   * is built and the line promises nothing: rejoining is M3's (section 13), and
   * a second connect would join as a new member rather than the same one.
   */
  function loseConnection(): void {
    connectionLost = true
    if (dev) console.info('[room] connection lost')
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
    if (!stickToBottom || list === null) return
    stickToBottom = false
    list.scrollTop = list.scrollHeight
  })

  function followNewest(stick: boolean): void {
    if (stick) stickToBottom = true
  }

  /**
   * T149: one notice raised with its end. `id` names the line, so raising it
   * again replaces it instead of stacking a second copy of the same news;
   * `until` and `when` are the two ways it ends by itself (ADR-049).
   */
  function notice(id: string, text: string, end: { until?: number; when?: () => boolean } = {}): void {
    notices = raiseNotice(notices, { id, text, ...end })
  }

  /** How often the page re-checks a notice's end: four times a second, so a
   *  condition that turned false is gone well inside the eye's next glance. */
  const NOTICE_TICK_MS = 250

  function apply(frame: ServerFrame): void {
    if (frame.type === 'welcome') {
      selfId = frame.selfId
      roomCode = frame.room.code
      members = frame.members
      // T154: the crown comes from the snapshot's owner, never `controllers`.
      roomOwner = frame.room.owner
      // §4.3 invariant 9: a fresh welcome is a new room view. `realign` tells
      // the player to put the element on it, whatever it had before (a reload,
      // a reconnect, a different room).
      playback = frame.room.playback
      revision = frame.room.revision
      // §4.1's controllers, as the snapshot stated them: T06 uses this to tell a
      // controller's click on the site's player from a guest's.
      controllers = frame.room.controllers
      playbackReason = 'join'
      // §5: `welcome` carries the epoch, and `setMedia` sends it back.
      epoch = frame.epoch
      // §4.2 + invariant 9: the snapshot also says which file; a window landing
      // here plays it and realigns below, so a late joiner or a reload arrives
      // where the room is (T9a3).
      media = frame.room.media
      // T03c item 5: the snapshot already carries the room's page, so a window
      // that arrives late — a guest, or this one reconnecting — lands on what
      // everyone is watching instead of waiting for the next change.
      // T26: and a snapshot that carries a file is a room with no page, so a
      // window that was already showing a site view takes it away (ADR-038).
      const side = pageSide(frame.room)
      roomPage = side.kind === 'site' ? side.page : null
      pendingPreview = null
      if (side.kind === 'site') moveSiteView(side.page)
      else if (side.kind === 'file') hideSiteView()
      realign += 1
      // A late joiner's panel is the ring buffer the authority sent (R5).
      chat = [...frame.chatTail]
      sentence = null
      // T98: a welcomed connection is a live one again, so no stale lost line.
      connectionLost = false
      followNewest(true)
      // T110 / ADR-047: a window that joined someone else's room has entered it
      // on this frame - the one carrying this page's own id - because the room
      // was live from the host's boot and there is no screen between the
      // connect and the room's answer. The attempt sets nothing: a link that
      // never gets a `welcome` leaves the guest on the first screen, where the
      // join box already says why (`UNREACHABLE_ROOM`). The host's own window
      // is `inOwnRoom` here and stays on the first screen until its own press
      // (T95), and a host that joins another room by its box is a guest too.
      if (!inOwnRoom) entered = true
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
      playbackReason = frame.reason
      // T06 item 1: the site view's player is a follower too (ADR-029), and a
      // `state` is the one frame that moves it.
      driveSite(frame)
    } else if (frame.type === 'pageCommitted') {
      // §5: the authority's word that the staged page is now the room's. Every
      // window moves on this frame and on nothing else — the bar's countdown is
      // a label, so no client timer can commit early or late (ADR-032).
      const wasPending = pendingPreview !== null
      // This window's site view is already on the page when the frame is its own
      // preview's: navigating again would reload the page it just loaded, which
      // is the visible revert ADR-032 exists to avoid.
      const previewed = pendingPreview !== null && pendingPreview.page === frame.page
      // T03d: the instant this window learned of the commit. The initiator's site
      // view moved on Enter, so `moveSiteView` below is skipped for it and the
      // navigation line is the **guest's** only; without this line the initiator's
      // log would hold nothing at the commit at all, and ADR-032's two seconds
      // could not be measured in the window that started them.
      if (dev) console.info(`[page] pageCommitted page=${frame.page} previewed=${previewed}`)
      // T37 / ADR-038's 2026-11-22 amendment, §4.2: a room that held a file may
      // take a page, and the commit clears the file in every window. The frame
      // carries only the page, so this window drops its own `media` beside the
      // page write: without it the file picture stays up, the bar's absence keeps
      // the room one-way, and T26's gate on site events would silence the view
      // this commit just asked for.
      const committed = pageCommitFields({ page: roomPage, media }, frame.page)
      roomPage = committed.page
      media = committed.media
      pendingPreview = null
      // ADR-050: a commit clears the bound, so a real page change still puts
      // the guest back once however often the previous page left.
      putBackRecord = NO_PUT_BACKS
      // T14: the old page's player is gone (or about to be); the hold on it goes
      // with the document, whether or not this window navigates here.
      endSiteNudge()
      // T07 item 4, §5's `pageCommitted` row: a new page is a new film, so the
      // room's playback is at position 0 and paused from this frame on. The
      // authority reset it (`commitDuePage`) but sends only the page, so this
      // window makes the same one — otherwise the next realignment would seek
      // the new film to the old one's position.
      playback = playbackAfterPageCommit(frame.at)
      playbackReason = 'join'
      // The site view is about to navigate (or already has, as a preview). Its
      // old player is not this page's: nothing it said survives, and the new
      // document's own election is what realigns - to 0, because the room is.
      // This frame itself applies nothing: a page change resets, only a player
      // replacement realigns.
      //
      // T18: the documents held at this instant are the page the room has just
      // left, and noting them before the clear is what refuses a report still in
      // flight from one of them. A window that previewed its own page is already
      // on it, so what it holds is the new page's — noting that would throw away
      // the election this commit is asking for.
      if (!previewed) notePageLeft()
      playerFrames.clear()
      playerEvents = []
      elected = null
      if (!unaligned) {
        unaligned = true
        startAlignWatch()
      }
      // Ours, or someone else's that replaced ours (ADR-032's cost line): either
      // way the bar goes back to the address the authority actually committed.
      if (wasPending) pageDraft = frame.page
      if (!previewed) moveSiteView(frame.page)
    } else if (frame.type === 'media') {
      // T9a3: the owner picked a file while this window was already here. The
      // player gets a new source and is put on the room's position (invariant 9),
      // exactly as a `welcome` that carried the same field would.
      media = frame.media
      // T26 / ADR-038: a pick is the room turning into a file. `setMedia` cleared
      // the page and the frame above is the only one that says so, so the page
      // side goes here — no committed page — and the host takes the site view
      // away rather than leaving a file squeezed into a column. That side is the
      // room's state, not "no preview": a file room may stage a page (ADR-038,
      // amended 2026-11-22), and this line is what ends such a preview when
      // another window picks a file (`pendingPreview` is cleared below).
      if (pageSide({ page: null, media: frame.media }).kind === 'file') {
        roomPage = null
        pendingPreview = null
        hideSiteView()
      }
      realign += 1
    } else if (frame.type === 'nudge') {
      // §6.3, to this window only: a rate and the authority instant it ends by.
      // It is handed to the player as a new object, so the same nudge cannot be
      // applied twice by a re-render. The elected site player gets the same hold
      // through the bridge (T14); with none elected that path writes nothing.
      nudge = frame
      applySiteNudge(frame)
    } else if (frame.type === 'members') {
      members = frame.members
    } else if (frame.type === 'chat') {
      // T22: one line per frame, the sender and the length - never the text,
      // and ASCII whatever was typed (`AGENTS.md` rule 10). Dev-only like the
      // other `[ws]`/`[page]` lines; the message id pairs it with the sidecar's.
      if (dev) {
        const from = frame.memberId ?? 'system'
        console.info(`[chat] m=${frame.id} from=${from} chars=${frame.text.length}`)
      }
      const stick = atBottom()
      chat = [...chat, frame]
      if (frame.kind === 'user') chatAccepted += 1
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
      // T98 / §14: the room's own last word, and the only thing that may end a
      // room. The sidecar closes every socket straight after this frame, so the
      // close that follows is what acts on it (`closeOutcome`); a bare close
      // never sets this flag and is therefore a lost connection, not an ending.
      roomOverSeen = true
    } else if (frame.type === 'warning') {
      // T149 / ADR-049: the mute's own window, from the server's number, so a
      // frame that arrived a moment late still ends when the mute does.
      notice('mute', frame.message, { until: performance.now() + frame.retryAfterMs })
    } else if (frame.type === 'error') {
      // T3b item 5: one sentence, no code and no jargon. A chat refusal belongs
      // beside the messages it refused; anything else keeps the join box.
      if (isChatRefusal(frame.code)) {
        // ADR-049: "too many messages" ends on the next accepted message, and -
        // when the refusal names a mute - no later than the mute's own end,
        // whichever comes first.
        const acceptedAt = chatAccepted
        notice(`chat-${frame.code}`, ERROR_SENTENCES[frame.code], {
          until: performance.now() + (frame.retryAfterMs ?? CHAT_MUTE_MS),
          // The line stays while no message has been accepted since it was
          // raised: the next accepted one is its end (ADR-049).
          when: () => chatAccepted === acceptedAt,
        })
      } else sentence = ERROR_SENTENCES[frame.code]
      // ADR-030/§14: a room action this window was not allowed to make is
      // undone locally too. Explaining it is not enough — the gesture already
      // moved this element, and the room did not move with it.
      if (frame.code === 'not_controller') realign += 1
      // T27: a staged page the authority refused never commits, so the preview
      // it was showing ends here. The error frame does not say which message it
      // refuses, but a preview only exists because this window sent `setPage`,
      // and `previewHolds` keeps the room's frames off it meanwhile, so a
      // refusal that lands with one pending is that `setPage` — and the site
      // view goes back to the room's page, or away when there is none.
      if (frame.code === 'not_controller' || frame.code === 'stale_host') {
        const staged = pendingPreview !== null
        pendingPreview = null
        if (staged) restoreSiteAfterPreview()
      }
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

    if (kind === 'siteEvent') {
      onSiteEvent(message)
      return
    }

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

    if (kind === 'popupCancelled') {
      const host = (message as { host?: unknown }).host
      const nav = (message as { nav?: unknown }).nav
      if (typeof host !== 'string' || host.length === 0) return
      // No count means the same navigation the page already knows about, which
      // keeps a repeat from becoming a second notice.
      notePopupCancelled(host, typeof nav === 'number' ? nav : popups.nav)
      return
    }

    if (kind === 'failed') {
      const sentence = (message as { sentence?: unknown }).sentence
      refusePick(typeof sentence === 'string' ? sentence : 'The app could not read the file it chose.')
    }
  }

  /**
   * T05: every frame of the site view as its last report described it, keyed by
   * the frame's URL (the host names the sender). Nothing here is drawn: 06 reads
   * the winner and feeds the room, and this ticket's only surface is the host's
   * one `player:` line.
   */
  const playerFrames = new Map<string, FrameReport>()
  /**
   * T18: which documents belonged to a page this window (or the room) has left.
   * A commit navigates every window, but a report already in flight still names
   * the old page and lands after the clear — 07b measured the guest's old-page
   * report arriving 32 ms after the commit and holding the election for the 5 s
   * expiry. Those tokens are what refuses it; grown, never replaced, so a report
   * crossing two page changes is still refused.
   */
  let pageLeftDocs: ReadonlySet<string> = new Set()
  /** The bridge's `emptied`/`loadstart` messages since the last election (§7.1). */
  let playerEvents: PlayerEvent[] = []
  /** §10.1's winner: one per room, kept until it goes. */
  let elected: PlayerCandidate | null = null
  /**
   * T07: the elected player has not been put on the room's position yet, so
   * nothing it measures or does is the room's news (ADR-029 rule 1). Set by an
   * election change, by a document of the site view completing, and by the
   * `pageCommitted` that makes the site view navigate; cleared by the apply.
   */
  let unaligned = false
  /** When this window started waiting for that apply, for the one late line. */
  let alignWaitingSince: number | null = null
  let alignTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * §4.1's controllers, as the last `welcome` stated them. ADR-030's one writer
   * decides, but this window also has to: a guest's click on the site's own
   * player is corrected back rather than sent to a room that would refuse it.
   */
  let controllers: string[] = []
  /** The reason of the last `state`, so a correction re-applies the room under the same name. */
  let playbackReason: PlaybackReason = 'join'
  /** §6.6's set, one per element: the file player has one, a site has ads and a player. */
  const siteEchoes = createSiteEchoes()
  /**
   * T14: §6.3's nudge for the site view — `Player.svelte`'s `held` hold with the
   * elected element behind the bridge. One owner of its `playbackRate`: `apply`
   * sets the rate, and `step` (the deadline and the watch) and `end` (a `state`)
   * are the only restores, all through this one object.
   */
  const siteNudge = createSiteNudge()
  let siteNudgeTimer: ReturnType<typeof setTimeout> | undefined
  let siteNudgeWatch: ReturnType<typeof setInterval> | undefined
  /** `performance.now()` of the last `player: drift` line; null before the first. */
  let driftLineAt: number | null = null

  /** ADR-050: the put-back line's own end, whichever comes first with "the room moved". */
  const PUT_BACK_NOTICE_MS = 30_000

  /**
   * ADR-050: this window's own put-back count for one stray address and one
   * room page. A `pageCommitted` clears it, so a real page change still puts
   * the guest back once; nothing of it crosses the wire.
   */
  let putBackRecord: PutBackRecord = NO_PUT_BACKS

  /**
   * T105 / ADR-048: the top document says where it went, and this window decides
   * what that means. The host already drops a `pageAddress` sent from a player
   * frame, but the page does not trust a frame's word either: a payload that does
   * not say `top === true` is ignored outright, and so is one with no usable
   * address.
   *
   * A controller's new address goes through `stagePage` - the ordinary `setPage`
   * with the two-second preview, its countdown and Cancel (ADR-032) - but the
   * site view is not navigated again, because the site itself is already there.
   * A guest has no page to offer, so its site view is put back on `roomPage`
   * (or hidden in a room with no page), with one line in the bar saying so.
   * ADR-050 bounds that to three tries for one address and then stops.
   */
  function onPageAddress(body: Record<string, unknown>): void {
    if (body.top !== true) return
    if (typeof body.href !== 'string' || body.href.length === 0) return
    const address = canonicalPage(body.href)
    if (address === null) return

    const step = pageFollowStep(
      {
        address,
        roomPage,
        previewPage: pendingPreview === null ? null : pendingPreview.page,
        controller: isController(),
      },
      putBackRecord,
    )
    putBackRecord = step.record
    const putBackOn = roomPage
    if (step.kind === 'ignore') return

    if (step.kind === 'stage') {
      // The site view already shows this address, so only the wire is told.
      if (stagePage(address, false) && dev) console.info(`[page] followed ${address}`)
      return
    }

    // ADR-050: the bound is reached, so this window stays where the site took
    // it and says so once. Nothing more is navigated or logged for the pair.
    if (step.kind === 'stop') {
      if (!step.announce) return
      if (dev) console.info('[page] the site keeps leaving the room - stopped going back')
      notice('putback', 'The site keeps leaving the room, so this window stopped going back.', {
        until: performance.now() + PUT_BACK_NOTICE_MS,
        when: () => roomPage === putBackOn,
      })
      return
    }

    if (dev) console.info(`[page] put back from ${address}`)
    // ADR-048: the room is not asked; the existing restore route takes the site
    // view to the committed page, or hides it when the room has none yet.
    restoreSiteAfterPreview()
    // ADR-049: the put-back line is a notice like the others, and it ends when
    // the room moves - the sentence "the room is on X" is stale the moment the
    // room's page changes - or after 30 s (ADR-050), whichever comes first.
    notice(
      'putback',
      putBackOn === null
        ? 'The room has no page yet, so this window was put back.'
        : `The room is on ${putBackOn}, so this window was put back.`,
      { until: performance.now() + PUT_BACK_NOTICE_MS, when: () => roomPage === putBackOn },
    )
  }

  /**
   * The relay's other half: one frame's report, one reload event, or the top
   * document's address. The host has already refused every kind but those
   * (`RelaySiteEvent`), so this only has to keep the shape honest.
   */
  function onSiteEvent(message: object): void {
    // T105 / ADR-048: a site's own navigation is heard even while the room holds
    // a file. A staged page over a file room has both views up (`media` set,
    // `roomPage` null), and its site view navigates like any other - so this
    // branch comes before T26's gate, not after it.
    const payload = (message as { payload?: unknown }).payload
    if (typeof payload === 'object' && payload !== null) {
      const body = payload as Record<string, unknown>
      if (body.kind === 'pageAddress') {
        onPageAddress(body)
        return
      }
    }

    // T26 / ADR-038: a room with a file has no site view, so nothing the hidden
    // one still says describes what the room plays. A report in flight at the
    // switch must not elect a player, realign it, or write a `player:` line.
    if (media !== null) return
    const source = (message as { source?: unknown }).source
    if (typeof source !== 'string' || source.length === 0) return
    if (typeof payload !== 'object' || payload === null) return

    const body = payload as Record<string, unknown>
    const kind = body.kind
    if (typeof kind !== 'string' || !(PLAYER_MESSAGE_KINDS as readonly string[]).includes(kind)) return

    if (kind === 'playerReport') {
      const seq = typeof body.seq === 'number' ? body.seq : 0
      // T07: a reloaded document's bridge counts from 1 again, so the number
      // alone would call it older news and drop it — 06b measured the election
      // never coming back for exactly that reason. The document token says
      // which bridge sent it.
      const doc = typeof body.doc === 'string' ? body.doc : ''
      const known = playerFrames.get(source)
      if (!reportIsNewer(known, { doc, seq })) return
      // A document this frame has not shown us before is a navigation that
      // completed: it earns the same realignment a replacement does (item 2).
      const newDocument = known !== undefined && known.doc !== doc
      const candidates: FrameCandidate[] = []
      if (Array.isArray(body.candidates)) {
        for (const raw of body.candidates) {
          const candidate = frameCandidate(raw)
          if (candidate !== null) candidates.push(candidate)
        }
      }
      playerFrames.set(source, {
        source,
        href: typeof body.href === 'string' && body.href.length > 0 ? body.href : source,
        doc,
        seq,
        candidates,
        receivedAt: Date.now(),
      })
      const step = followSite(electPlayer(), newDocument)
      if (!step.report) return
      // The same report also carries the elected element's playhead, which is
      // §5's `report` (T06 item 2) when this frame holds the winner.
      reportFromSite(source, candidates)
      return
    }

    if (body.kind === 'playerEvent') {
      const id = body.id
      const event = body.event
      if (typeof id !== 'number') return

      // T145: a play the page refused, and the one more try that refusal earns.
      // Neither is a room event - nothing played, so nothing is sent anywhere -
      // and the retry is the bridge's own, so no `player: applied` line names it.
      // These two lines are that record in the host's log (the measuring build
      // forwards this page's console: `page: [player] refused ...`).
      if (event === 'refused' || event === 'retry') {
        if (dev) {
          console.info(event === 'refused'
            ? `[player] refused id=${id} name=${typeof body.name === 'string' ? body.name : '(none)'}`
            : `[player] retry id=${id} why=${typeof body.why === 'string' ? body.why : '(none)'}`)
        }
        return
      }

      if (event === 'emptied' || event === 'loadstart') {
        playerEvents.push({ source, id, event, t: typeof body.t === 'number' ? body.t : 0 })
        followSite(electPlayer())
        return
      }

      if (event === 'applied') {
        // T06 item 4: one line per command the bridge carried out, written by
        // the host in both builds exactly as the election line is.
        postToHost({
          kind: 'playerApplied',
          reason: typeof body.reason === 'string' ? body.reason : '(none)',
          target: typeof body.target === 'number' ? body.target : 0,
          from: typeof body.from === 'number' ? body.from : 0,
        })
        return
      }

      const playbackEvent = event === 'play' || event === 'pause' || event === 'seeked' ? event : null
      if (playbackEvent === null) return
      // T07: until the elected player has been put on the room's position it is
      // not a follower, so what it does on its own is not the room's news - and
      // a just-loaded page playing from 0 must not become a seek to 0.
      if (unaligned) return
      const action: PlayerActionEvent = {
        source,
        id,
        event: playbackEvent,
        t: typeof body.t === 'number' ? body.t : 0,
        wasPlaying: body.wasPlaying === true,
        // T15: the bridge says whether its own write caused this, so §6.6's
        // decision does not lean on a report that may be half a second old.
        caused: body.caused === true,
        // T17: and whether the element was already out of the document, which
        // is the only thing that separates a removal's pause from a person's.
        detached: body.detached === true,
      }
      // §6.6 and ADR-030: ours is dropped, the controller's is a command, and a
      // guest's is corrected back rather than sent to a room that would refuse.
      const decision = decidePageEvent(action, elected, siteEchoes, performance.now(), isController())
      if (decision.kind === 'send') {
        sendCommand(decision.command)
        return
      }
      if (decision.kind === 'correct' && playback !== null) {
        postToSite(planFromState(playback, revision, playbackReason, elected, authorityClock()))
      }
    }
  }

  /** One reported `<video>`, or null for anything that is not one. */
  function frameCandidate(raw: unknown): FrameCandidate | null {
    if (typeof raw !== 'object' || raw === null) return null
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.id !== 'number' || typeof candidate.w !== 'number'
      || typeof candidate.h !== 'number' || typeof candidate.readyState !== 'number') return null
    return {
      id: candidate.id,
      w: candidate.w,
      h: candidate.h,
      readyState: candidate.readyState,
      hasSrc: candidate.hasSrc === true,
      playing: candidate.playing === true,
      duration: typeof candidate.duration === 'number' ? candidate.duration : 0,
      t: typeof candidate.t === 'number' ? candidate.t : 0,
      // T06: §5's `report` fields, measured by the bridge on the element itself.
      paused: candidate.paused === true,
      buffered: typeof candidate.buffered === 'number' ? candidate.buffered : 0,
      rate: typeof candidate.rate === 'number' ? candidate.rate : 1,
    }
  }

  /**
   * §10.1, once per report: score every frame's candidates and keep the winner.
   * Only a change is sent anywhere — the host writes one `player:` line per
   * election, and 06 is the first reader of the value that line names. The
   * reason comes back because T07 treats a change as "unaligned".
   */
  function electPlayer(): PlayerReason | null {
    const result = elect(
      elected,
      mergeReports(playerFrames.values(), Date.now(), pageLeftDocs),
      playerEvents,
      pageLeftDocs,
    )
    playerEvents = []
    // Kept even when nothing changed: the winner is the element as its latest
    // report describes it, and a reload can only be `replaced` if the snapshot
    // we hold knows the element was playing (05b measured the placeholder).
    elected = result.elected
    if (result.reason === null) return null
    postToHost({
      kind: 'playerElected',
      reason: result.reason,
      frame: result.elected === null
        ? null
        : {
            href: result.elected.href,
            w: result.elected.w,
            h: result.elected.h,
            duration: result.elected.duration,
          },
    })
    return result.reason
  }

  /**
   * T07: take one step of the follower rule, with this window's own room view
   * filled in. The apply goes out with its echoes recorded first (§6.6), and no
   * report follows until the page is on the room's position — the page's own
   * `currentTime` is never sent while it is unaligned (ADR-029 rule 1).
   */
  function followSite(reason: PlayerReason | null, newDocument = false): FollowerStep {
    const step = followerStep({
      reason,
      newDocument,
      previewPending: pendingPreview !== null,
      unaligned,
      playback,
      revision,
      stateReason: playbackReason,
      elected,
      nowMs: authorityClock(),
    })
    if (step.unaligned && !unaligned) startAlignWatch()
    if (!step.unaligned) stopAlignWatch()
    unaligned = step.unaligned
    if (step.realign !== null) postToSite(step.realign)
    return step
  }

  /**
   * The one line T07 allows when the page has not caught up: it is said only
   * once per wait, and only after the room's own tolerance has passed, so a
   * reload that realigns in half a second says nothing at all.
   */
  function startAlignWatch(): void {
    if (alignTimer !== undefined) clearTimeout(alignTimer)
    const startedAt = performance.now()
    alignWaitingSince = startedAt
    alignTimer = setTimeout(() => {
      alignTimer = undefined
      if (!unaligned || alignWaitingSince !== startedAt) return
      if (!alignmentOverdue(startedAt, performance.now())) return
      // T149 / ADR-049: the line ends when the picture aligns, so the notice's
      // own condition is the wait itself rather than a second timer.
      notice('align', ALIGN_LATE_SENTENCE, { when: () => unaligned })
    }, ALIGN_TOLERANCE_MS)
  }

  function stopAlignWatch(): void {
    if (alignTimer !== undefined) clearTimeout(alignTimer)
    alignTimer = undefined
    alignWaitingSince = null
  }

  /** Whether this window is one the room will listen to (ADR-024, ADR-030). */
  function isController(): boolean {
    return selfId !== null && controllers.includes(selfId)
  }

  /**
   * T14 item 3: a rate write is a page message and nothing else. It records no
   * §6.6 entry and spends none, so a play or seek in flight keeps the entry it
   * is owed, and it is never posted through `postToSite`, which clears them.
   */
  function postRateCommands(commands: readonly PlayerPageCommand[]): void {
    for (const command of commands) postToHost({ kind: 'siteCommand', payload: command })
  }

  /** The one clearer: a hold and its two timers end together, or not at all. */
  function stopSiteNudge(): void {
    if (siteNudgeTimer !== undefined) clearTimeout(siteNudgeTimer)
    siteNudgeTimer = undefined
    if (siteNudgeWatch !== undefined) clearInterval(siteNudgeWatch)
    siteNudgeWatch = undefined
  }

  /**
   * T21: how old the elected element's numbers are, in millis. `elected` is the
   * snapshot of its last report, not a fresh look - a site reports at most once a
   * second - so a gap compared against `expected` at a later tick charges the
   * reading's own age to the drift. 09b measured it: a 1.151 s lead read as about
   * 0.2 s, the rate went back to 1 four seconds in, again every five seconds for
   * 100 s.
   */
  function electedReadingAgeMs(): number {
    if (elected === null) return 0
    const known = playerFrames.get(elected.source)
    return known === undefined ? 0 : Math.max(0, Date.now() - known.receivedAt)
  }

  /**
   * §6.3's nudge, on the elected site player only (T14). The deadline is the
   * hold's own `untilAuthorityMs` — the frame's number, or the older hold's when
   * a frame held nothing — on this window's clock. The watch is the file
   * player's: a sleeping window throttles timers, so a late tick still ends the
   * hold rather than leaving 1.05 behind. With no element elected nothing is
   * held and nothing is written.
   */
  function applySiteNudge(frame: NudgeFrame): void {
    // ADR-032: a window with its own preview up is not a follower, so the room's
    // ladder is not applied to a film that is not the room's.
    if (pendingPreview !== null) return
    const now = authorityClock()
    stopSiteNudge()
    postRateCommands(siteNudge.apply(frame.rate, frame.untilAuthorityMs, elected, now))
    const live = siteNudge.current()
    if (live === null) return
    siteNudgeTimer = setTimeout(() => {
      siteNudgeTimer = undefined
      postRateCommands(siteNudge.step(elected, playback, authorityClock(), electedReadingAgeMs()))
      if (siteNudge.current() === null) stopSiteNudge()
    }, Math.max(0, live.hold.untilAuthorityMs - now))
    siteNudgeWatch = setInterval(() => {
      if (siteNudge.current() === null) {
        stopSiteNudge()
        return
      }
      postRateCommands(siteNudge.step(elected, playback, authorityClock(), electedReadingAgeMs()))
      if (siteNudge.current() === null) stopSiteNudge()
    }, NUDGE_WATCH_MS)
  }

  /** The room moved the playhead: §6.3's last rule restores the rate with it. */
  function endSiteNudge(): void {
    postRateCommands(siteNudge.end())
    stopSiteNudge()
  }

  /**
   * T06 item 3's rule, in the one place it can be kept: record every event the
   * command will cause **before** it is posted, then post it. The bridge cannot
   * be touched before the message arrives, so the entry is in the set before
   * the write it describes (§6.6).
   */
  function postToSite(plan: PagePlan | null): void {
    // The room is putting the page on its position — a pause, a seek or a snap —
    // so §6.3's hold ends with it, before the plan can move the playhead (T14).
    endSiteNudge()
    if (plan === null || host === null) return
    const target = { source: plan.command.source, id: plan.command.id }
    // T15: this command supersedes whatever the element still owes, so a hold's
    // predicted `play` is dropped here rather than left to swallow a person's
    // next one inside the echo window.
    siteEchoes.clear(target)
    siteEchoes.expect(target, echoEntries(plan, performance.now()))
    postToHost({ kind: 'siteCommand', payload: plan.command })
  }

  /**
   * T06 item 1: the `state` frame's play / pause / seek, posted to the elected
   * element only. A website room is the only one with a site view to drive, and
   * a preview is not a follower yet (ADR-032 as amended) — the same two rules
   * `Player` keeps for the file.
   */
  function driveSite(frame: { playback: Playback; revision: number; reason: PlaybackReason }): void {
    if (roomPage === null || pendingPreview !== null) return
    postToSite(planFromState(frame.playback, frame.revision, frame.reason, elected, authorityClock()))
  }

  /**
   * T06 item 2: the elected element's own numbers become §5's `report`, and one
   * `player: drift` line a second goes to the host beside it. The room's ladder
   * is the only corrector; nothing here decides a correction. A paused room gets
   * reports too: §6.3's paused row (snap directly) can only act on a measurement.
   */
  function reportFromSite(source: string, candidates: readonly FrameCandidate[]): void {
    const winner = elected
    if (winner === null || winner.source !== source) return
    if (playback === null || pendingPreview !== null) return
    const candidate = candidates.find((one) => one.id === winner.id)
    if (candidate === undefined) return
    const reading = {
      t: candidate.t,
      paused: candidate.paused === true,
      readyState: candidate.readyState,
      buffered: candidate.buffered ?? 0,
      rate: candidate.rate ?? 1,
    }
    sendCommand(reportFromPlayer(reading, {
      duration: Number.isFinite(candidate.duration) && candidate.duration > 0 ? candidate.duration : undefined,
      origin: location.origin,
      rtt: estimate.rtt,
    }))
    const now = performance.now()
    if (!driftLogDue(driftLineAt, now)) return
    driftLineAt = now
    const drift = driftFromPlayer(reading, playback, authorityClock())
    postToHost({
      kind: 'playerDrift',
      expected: drift.expected,
      actual: drift.actual,
      deltaMs: drift.deltaMs,
    })
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
    // T98: joining another room is leaving the line about the one that ended.
    endedNotice = false
    // T64: a page with no start state of its own is a guest's, and `/discovery`
    // answers only loopback now (`app.ts`). The room it just joined is what it
    // shows; the start screen's discovery fields stay empty because this window
    // has no answer of its own to put there.
    if (payload === null) {
      fromLink = true
      payload = joinedFrom({ code: target.code, port: target.port })
    }
    connect(target.host, target.port, target.code)
  }

  /**
   * T64: the start screen of a window that joined from a link - the room's code
   * and nothing else. `inOwnRoom` is false for such a window, so none of
   * `result`, `invite` or `status` is ever read; they are here because
   * `StartPayload` is the one shape the screen renders.
   */
  function joinedFrom(target: { code: string; port: number }): StartPayload {
    return {
      status: 'ready',
      roomCode: target.code,
      lanIp: null,
      localPort: target.port,
      result: null,
      invite: null,
    }
  }

  /**
   * T03b / T95b / T105: the one send every route uses - Enter in the address bar,
   * the Paste button, and (ADR-048) a controller's site navigating itself.
   * `setPageFrame` is the whole decision — a blank field or an unusable address
   * yields no frame, so nothing leaves this window (the authority would otherwise
   * drop it silently, ticket 03).
   *
   * `moveView` is true for the bar, whose window has to show the page it just
   * asked for, and false for a site that has already navigated: there the
   * ordinary `setPage` is the preview, and navigating again would reload the page
   * the site just loaded — the visible revert ADR-032 exists to avoid.
   *
   * Returns whether the frame left, so the route that logged "followed" only
   * says so when the room really heard it.
   */
  function stagePage(address: string, moveView: boolean): boolean {
    const frame = setPageFrame(address, epoch)
    if (frame === null) {
      pageNotice = 'That is not a web address — paste a page link like example.com/watch.'
      if (dev) console.info(`[page] refused as unusable: ${address.trim()}`)
      return false
    }
    if (socket === null || selfId === null) {
      pageNotice = 'This window is not in the room, so the address was not sent.'
      return false
    }

    socket.send(JSON.stringify(frame))
    pageNotice = null
    // T03c item 1: this window shows the new page at once — the preview — while
    // everyone else keeps the old one until `pageCommitted` (ADR-032). It starts
    // at the instant the frame leaves, because that is when the authority's
    // window starts too.
    pendingPreview = { page: frame.page, epoch, sentAt: Date.now() }
    if (moveView) moveSiteView(frame.page)
    // T03b's live check reads this line's absence for a bad address, so the
    // success is as explicit as the refusal above.
    if (dev) console.info(`[page] setPage ${frame.page}`)
    return true
  }

  /** T03b: the bar's field, sent by the one path; blank sends nothing at all. */
  function sendPage(address: string): void {
    if (address.trim().length === 0) {
      pageNotice = null
      return
    }
    stagePage(address, true)
  }

  /** T03b: Enter in the address bar — the field's own text, sent by the one path. */
  function submitPage(event: SubmitEvent): void {
    event.preventDefault()
    sendPage(pageDraft)
  }

  /**
   * T18: every document the site view is holding right now belongs to the page
   * it is leaving, so a report still in flight from one of them is not the new
   * page's candidate (a document's identity is never reused). Grown rather than
   * replaced: a report that crosses two page changes is still refused.
   */
  function notePageLeft(): void {
    pageLeftDocs = new Set([...pageLeftDocs, ...documentsLeft(playerFrames.values())])
  }

  /**
   * T03c: the only way the site view ever moves (ADR-038) — a `siteCommand` the
   * host performs itself. Nothing outside this window hears of it, which is what
   * makes the preview a preview: a guest's site view is not moved until the
   * authority's `pageCommitted` reaches it.
   */
  function moveSiteView(page: string): void {
    // T14: a new document is a new element at rate 1; the hold on the old one
    // ends here so its deadline cannot fire into the page that replaced it.
    endSiteNudge()
    // T18: a preview and a Cancel move the site view no less than a commit does,
    // so the documents held here are the page being left in every case.
    notePageLeft()
    postToHost({ kind: 'siteCommand', payload: { kind: 'navigate', url: page } })
    if (dev) console.info(`[page] site view -> ${page}`)
  }

  /**
   * T26 / ADR-038's other half: with no page there is no site view. The room
   * holds a file, so the host hides the pane and the app view fills the window
   * exactly as in M1. Everything this window held about the site goes with it:
   * the documents the hidden view still holds are the page the room has left, so
   * a report in flight from one of them is refused (T18); the elected player,
   * its events and its rate hold belong to that page, not to the file; and an
   * alignment this window was waiting for can never arrive, so it is dropped
   * rather than said about a player that no longer matters.
   */
  function hideSiteView(): void {
    endSiteNudge()
    notePageLeft()
    playerFrames.clear()
    playerEvents = []
    elected = null
    unaligned = false
    stopAlignWatch()
    // ADR-038 keeps the host the only owner of the layout, so this is a
    // window-internal command: nothing crosses the wire (§5 has no such frame).
    postToHost(HIDE_SITE_MESSAGE)
    if (dev) console.info('[page] site view hidden')
  }

  /**
   * T27 / ADR-032's amendment: both ways a preview ends without a commit land
   * here. Cancel and a refused `setPage` leave the room exactly where it was, so
   * the site view goes back to the committed page — or, in a room whose page was
   * never set, T26's hide path takes the pane away and the app view fills the
   * window as in M1. The preview's own address is never what is left showing.
   */
  function restoreSiteAfterPreview(): void {
    const side = siteAfterPreview(roomPage)
    if (side.kind === 'show') moveSiteView(side.page)
    else hideSiteView()
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
    // A room that had no page yet has nothing to go back to, so the preview's
    // navigation is undone by T26's hide rather than a second address (T27).
    restoreSiteAfterPreview()
    if (dev) console.info(`[page] cancel ${pending.page}`)
  }

  /**
   * T04b: one popup the host refused. The page decides how often it says so;
   * the host only reports the fact. A repeat from the same host on the same
   * navigation comes back as the same state object, so the line and its timer
   * are left exactly where they are and nothing flickers.
   */
  function notePopupCancelled(host: string, nav: number): void {
    const next = notePopup(popups, { host, nav }, Date.now())
    if (next === popups) return
    popups = next
    armPopupTimer()
    if (dev) console.info(`[popup] cancelled host=${host} nav=${nav}`)
  }

  /** The line clearing itself: nothing else dismisses it, and nothing re-shows it for the same page. */
  function onPopupExpired(): void {
    popupTimer = undefined
    const next = expirePopup(popups, Date.now())
    if (next !== popups) popups = next
    // A clock that disagreed with the timer gets one more wait rather than a spin.
    if (popups.notice !== null) armPopupTimer()
  }

  function armPopupTimer(): void {
    if (popupTimer !== undefined) clearTimeout(popupTimer)
    popupTimer = setTimeout(onPopupExpired, POPUP_NOTICE_MS)
  }

  function stopPopupTimer(): void {
    if (popupTimer !== undefined) clearTimeout(popupTimer)
    popupTimer = undefined
  }

  /**
   * T03b / T95b: the visible Paste button. WebView2's own clipboard grant does
   * the reading (the host allows `ClipboardRead` for this one view), and Ctrl+V
   * and the right-click menu are the engine's, so neither passes through here.
   * T95b: the press does the whole job - fills the field and sends it down
   * `sendPage`, the same path Enter takes - so there is nothing left to press.
   * A refused or empty read sends nothing and leaves the field focused, where
   * Ctrl+V belongs; a stale address is never sent in its place.
   */
  async function pasteAddress(): Promise<void> {
    pageNotice = null
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch (error) {
      pageNotice = 'This window could not read the clipboard — press Ctrl+V in the field instead.'
      if (dev) console.info(`[page] clipboard read failed: ${String(error)}`)
      addressInput?.focus()
      return
    }
    if (text.trim().length === 0) {
      pageNotice = 'The clipboard has nothing to paste.'
      addressInput?.focus()
      return
    }
    pageDraft = text.trim()
    sendPage(pageDraft)
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

  /**
   * ADR-049 / §4.6: a message's own time, `hh:mm`, from the authority's `ts` -
   * everyone reads the same number, whatever their own clock says. Not
   * `formatClock`, which draws a *picture's* position (mm:ss from zero).
   */
  function timeOfDay(ts: number): string {
    const date = new Date(ts)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
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
    // T99 / ADR-047: the host's dock is an attribute on the root element, and it
    // arrives after this page's first paint, so the page watches it rather than
    // reading it once. A document with no attribute (a browser, a test) has no
    // panel and owns its own picture-and-chat layout.
    const root = document.documentElement
    const readPanel = (): void => {
      panel = root.dataset.panel ?? null
    }
    readPanel()
    const panelWatch = new MutationObserver(readPanel)
    panelWatch.observe(root, { attributes: true, attributeFilter: ['data-panel'] })

    // R26's no-typing path: `?join=<encoded link>` is parsed before the first
    // discovery answer can claim this window's own room. T64: the invite link's
    // own form (`/join?c=<code>`) carries the room in this window's address, so
    // the same parser reads it from there - either way the code in the link is
    // the room. A window with a link never asks `/discovery`, which now answers
    // only loopback (`app.ts`); a guest is not loopback.
    const params = new URLSearchParams(location.search)
    const pasted = params.get('join')
    if (pasted !== null) joinText = pasted
    const target = pasted !== null
      ? parseJoinLink(pasted)
      : params.has('c')
        ? parseJoinLink(location.href)
        : null

    if (pasted !== null && target === null) sentence = UNREADABLE_LINK

    if (target === null) {
      void refresh()
    } else {
      fromLink = true
      enteredRoom = true
      payload = joinedFrom({ code: target.code, port: target.port })
      connect(target.host, target.port, target.code)
    }

    // T149 / ADR-049: a notice's own end. One tick for every line on screen:
    // the timer (`until`) and the condition (`when`) are both checked here, and
    // the array comes back identical when nothing ended, so the DOM is not
    // touched four times a second for nothing.
    const noticeWatch = setInterval(() => {
      notices = reapNotices(notices, performance.now())
    }, NOTICE_TICK_MS)

    host?.addEventListener('message', onHostMessage)
    return () => {
      panelWatch.disconnect()
      host?.removeEventListener('message', onHostMessage)
      clearTimeout(timer)
      clearInterval(noticeWatch)
      stopPopupTimer()
      stopPing()
    }
  })
</script>

{#if showAddressBar}
  <!-- T03b: R29's address bar, the page's own element drawn inside the app view
       (ADR-047). The host reserves no strip above the site view and owns no
       height for this bar. HTML, drawn by this page, so the right-click menu,
       Ctrl+V and a visible Paste button are the engine's own behaviour. -->
  <header class="address-bar" data-address-bar>
    <!-- T95b / ADR-047: one row carries both routes at every moment. The Paste
         press acts on its own (fill and send, the same `sendPage` Enter uses),
         and Open a file sits beside the field rather than in a section of its
         own, so a page room and a file room show the same bar. -->
    <div class="bar-row">
      <form onsubmit={submitPage}>
        <div class="bar-field">
          <input
            type="text"
            aria-label="Page address"
            placeholder="Paste a page address"
            autocomplete="off"
            spellcheck="false"
            bind:this={addressInput}
            bind:value={pageDraft}
          />
          <button type="button" class="paste" data-paste onclick={() => void pasteAddress()}>Paste</button>
        </div>
      </form>
      {#if canPick}
        <button
          type="button"
          class="open-file"
          data-open-file
          onclick={requestFile}
          disabled={picking || host === null}
        >
          {picking ? 'Waiting for the file…' : 'Open a file'}
        </button>
      {/if}
    </div>
    {#if pickNotice !== null}
      <p class="bar-notice {pickNotice.kind}" role="status">{pickNotice.text}</p>
    {/if}
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
    {#if popups.notice !== null}
      <!-- T04b: R37's line. Neutral rather than red: nothing failed and no ad
           was blocked — the site asked for a window and this app has one. -->
      <p class="bar-popup" role="status">{popupSentence(popups.notice.host)}</p>
    {/if}
  </header>
{/if}

<main>
  <h1>Watch Party</h1>

  {#if unreachable}
    <p class="sentence">The room process is not answering. Close the window and start Watch Party again.</p>
  {:else if payload === null}
    <p class="sentence">Starting the room…</p>
  {:else if screen === 'first'}
    <!-- T95 / ADR-047: the first screen is this room's front door. The room is
         live from the sidecar's boot, so Start a room enters it rather than
         creating one, and the host's invite is here in full - failure card and
         Try again included (spec §8, §14). Nothing that watches or picks. -->
    {#if endedNotice}
      <!-- T98 / ADR-047: the dead room's one plain line. The first screen below
           is this machine's own front door, reached by `refresh()` - not the
           dead room with an overlay on it - so the line only says what happened
           to the room this window was in. -->
      <p class="ended-line" role="status">{ROOM_OVER_SENTENCE}</p>
    {/if}

    {#if inOwnRoom}
      <section class="invite" data-invite>
        <button type="button" class="start" onclick={enterRoom}>Start a room</button>
        <!-- T150 / ADR-047: the owner inferred a bug from the truth - the room is
             live before the first press. The card says so beside its action, in
             the owner's terms, so the invite can be shared right away. -->
        <p class="already-open">
          The room is already open, so share the invite link below whenever you like -
          <strong>Start a room</strong> only enters it.
        </p>
        <p class="room">Room code <strong data-invite-code>{roomCode ?? payload.roomCode}</strong></p>

      {#if payload.status === 'pending'}
        <p class="sentence">Asking your router to open a port…</p>
      {:else if payload.result !== null}
        <p class="sentence">{payload.result.sentence}</p>

        {#if payload.invite !== null}
          <section>
            <p class="label">Invite link</p>
            <p class="link" data-invite-link>{payload.invite.primary}</p>
            <button type="button" onclick={() => void copy()}>{copied ? 'Copied' : 'Copy invite link'}</button>
            <p class="label fallback">If the link does not open, paste this:</p>
            <p class="link raw" data-invite-raw>{payload.invite.raw}</p>
            {#if payload.invite.lanRaw !== null && payload.invite.lanRaw !== payload.invite.raw}
              <p class="label fallback">On this network:</p>
              <p class="link raw">{payload.invite.lanRaw}</p>
            {/if}
          </section>
        {/if}

        {#if payload.result.kind !== 'ok'}
          <!-- T67, spec §14's last row: no public link exists, so the two
               fallbacks are named — the same-wifi link above, and this
               machine's own port to forward. -->
          <section class="manual">
            <h3>Open the port yourself</h3>
            {#if payload.result.gatewayIp !== null}
              <p>
                Sign in to your router's settings page at
                <span class="link raw">http://{payload.result.gatewayIp}/</span>
                and add one port forward:
              </p>
            {:else}
              <p>Sign in to your router's settings page and add one port forward:</p>
            {/if}
            <ul>
              <li>Port <strong>{payload.result.localPort}</strong></li>
              <li>Protocol <strong>TCP</strong></li>
              <li>Send it to this computer at <strong>{payload.lanIp ?? 'the address the router shows'}</strong></li>
            </ul>
            <p class="label fallback">The link above still works for everyone on your own network.</p>
          </section>
        {/if}

        <p class="detail">{payload.result.detail}</p>
      {/if}

      {#if payload.status === 'ready'}
        <button type="button" class="secondary" onclick={() => void retry()}>Try again</button>
      {/if}
      </section>
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
  {:else}
    <!-- T95 / ADR-047: the watching screen. Tickets 96-99 lay it out; this ticket
         keeps every control it has today: the picker, the player, the chat and
         the roster. The address bar above is gated the same way.
         T96 / ADR-047: `.watch` is the picture area and the chat column. Which
         way round they sit is the **host's**, read off `data-layout` on the root
         element; the column's width is `--chat-column`, also the host's. Neither
         number is written in this file - the fallbacks in the CSS are for a
         browser or a test. -->
    <div class="watch">
      <!-- T99 / ADR-047 ("the host's dock wins"): while the host docks the app
           view as a column the page is the chat column alone, so there is no
           picture element at all - not an empty one - whatever `data-layout`
           says. In file mode the picture is ours and stays. -->
      {#if panel !== 'chat'}
        <div class="picture">
          {#if selfId !== null && playback !== null && !roomEnded}
            <Player
              {playback}
              {revision}
              {realign}
              {nudge}
              {media}
              src={playerSrc}
              {devPlay}
              emptyLine={emptyPictureLine}
              clock={authorityClock}
              rtt={() => estimate.rtt}
              send={sendCommand}
            />
          {:else}
            <!-- T150: the picture area is never blank, and it never tells the
                 owner to wait for themselves. One line, in the role's terms. -->
            <p class="empty-picture">{emptyPictureLine}</p>
          {/if}
        </div>
      {/if}

      <!-- T97 / ADR-047: the invite bar is the chat column's top row, not a
           second panel: the room's code, the host's link and one Copy, with the
           raw fallback one click inside. A guest's bar has no link to offer, so
           it names the code and says the link is the host's. -->
      <section class="invite-bar" data-invite>
        <div class="invite-row">
          <span class="invite-code">Room <strong data-invite-code>{roomCode ?? payload.roomCode}</strong></span>

          {#if payload.invite !== null}
            <span class="invite-link" data-invite-link title={payload.invite.primary}>{payload.invite.primary}</span>
            <button type="button" class="invite-copy" data-invite-copy onclick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              class="invite-more"
              aria-expanded={inviteOpen}
              aria-controls="invite-fallback"
              onclick={() => (inviteOpen = !inviteOpen)}
            >
              Raw address
            </button>
          {:else if inOwnRoom}
            {#if payload.status === 'pending'}
              <span class="invite-note">Asking your router to open a port…</span>
            {:else if payload.result !== null}
              <span class="invite-note">{payload.result.sentence}</span>
              {#if payload.status === 'ready'}
                <button type="button" class="invite-more" onclick={() => void retry()}>Try again</button>
              {/if}
            {/if}
          {:else}
            <span class="invite-note" data-invite-note>The invite link is the host's to share.</span>
          {/if}
        </div>

        {#if connectionLost}
          <!-- T98 / §6's "connection drops": one line. The room's code, chat,
               roster and playback all stay; there is no retry and the line
               promises none (rejoining is M3's, section 13). -->
          <p class="connection-lost" role="status">The connection to the room was lost.</p>
        {/if}

        {#if inviteOpen && payload.invite !== null}
          <div class="invite-fallback" id="invite-fallback">
            <p class="invite-raw" data-invite-raw>{payload.invite.raw}</p>
            {#if payload.invite.lanRaw !== null && payload.invite.lanRaw !== payload.invite.raw}
              <p class="invite-raw">{payload.invite.lanRaw}</p>
            {/if}
            {#if payload.result !== null && payload.result.kind !== 'ok'}
              <p class="invite-reason">{payload.result.sentence}</p>
              {#if payload.status === 'ready'}
                <button type="button" class="secondary" onclick={() => void retry()}>Try again</button>
              {/if}
            {/if}
          </div>
        {/if}
      </section>

      {#if selfId !== null}
        <div class="room-body">
          <section class="chat" aria-label="Chat">
            <h2>Chat</h2>
            <div class="messages" bind:this={chatList}>
              {#each chat as message (message.id)}
                {#if message.kind === 'system'}
                  <p class="system">
                    <span class="time">{timeOfDay(message.ts)}</span>
                    <span class="text">{message.text}</span>
                  </p>
                {:else}
                  <p class="message" class:mine={message.memberId === selfId}>
                    <span class="author">{message.name}</span>
                    <span class="time">{timeOfDay(message.ts)}</span>
                    {#if message.memberId === selfId}<span class="you">you</span>{/if}
                    <span class="text">{message.text}</span>
                  </p>
                {/if}
              {/each}
            </div>
            {#if notices.length > 0}
              <div class="notices">
                {#each notices as entry (entry.id)}
                  <p class="notice" role="status">
                    <span>{entry.text}</span>
                    <button
                      type="button"
                      class="dismiss"
                      aria-label="Dismiss this notice"
                      onclick={() => (notices = dismissNotice(notices, entry.id))}>Dismiss</button
                    >
                  </p>
                {/each}
              </div>
            {/if}
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

          {#if present.length > 0 && !roomEnded}
            <!-- T154 / ADR-049: the roster is one line, "N online", and the names
                 are under it only once a press asks for them. It is a sibling of
                 the chat section, not a row inside its scroller, so a message
                 can never move it (ticket 153). The count and the rows read the
                 same list. -->
            <section class="roster">
              <button
                type="button"
                class="roster-toggle"
                aria-expanded={rosterOpen}
                onclick={() => (rosterOpen = !rosterOpen)}
              >
                <span class="chevron" aria-hidden="true"></span>
                <span class="count">{present.length} online</span>
              </button>

              {#if rosterOpen}
                <ul>
                  {#each present as member (member.id)}
                    <li>
                      <span class="dot {member.status}" title={member.status}></span>
                      <span class="name">{member.displayName}</span>
                      {#if member.id === roomOwner}
                        <span class="crown" role="img" aria-label="the room's owner" title="the room's owner"
                          >&#9819;</span
                        >
                      {/if}
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
              {/if}
            </section>
          {/if}
        </div>
      {/if}
    </div>
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

  /* T150: the card is centred in whatever window it is in. `margin-inline: auto`
     splits the leftover width equally, and on a narrow window `main` is the
     window less its padding, so the card never leaves it. */
  main {
    padding: 2.5rem 3rem;
    max-width: 52rem;
    margin-inline: auto;
  }

  /* T150: the window's scrollbar sits inside the right edge, so a centred block
     would read 15 px left of centre against `innerWidth`. Reserving the same
     gutter on both edges keeps the two gaps equal at every width. The watching
     screen never scrolls (ADR-047), so it is spared the gutter. */
  :global(html:not([data-screen='watching'])) {
    scrollbar-gutter: stable both-edges;
  }

  /* T96 / ADR-047: on the watching screen the page is the window, not a column
     that scrolls. The document takes the window's height and the only scroller
     is the chat's list, so the app mount fills the window and `main` fills what
     the address bar leaves. The first screen keeps the rules above -
     `data-screen` is what separates them, and it is the page's own. */
  :global(html[data-screen='watching']) :global(body) {
    overflow: hidden;
  }

  :global(html[data-screen='watching']) :global(#app) {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  :global(html[data-screen='watching']) main {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    max-width: none;
    padding: 0.75rem 1rem;
    overflow: hidden;
  }

  /* T96 / ADR-047: the picture is this screen's, so the page's own title is not
     drawn above it - the window's title bar says the app's name and the invite
     bar (T97) names the room. The line it cost came out of the picture and the
     chat, which are the two things the room is. */
  :global(html[data-screen='watching']) h1 {
    display: none;
  }

  /* ADR-047: picture left, chat column right, and an unset `data-layout` is
     `wide` - the attribute is the host's, and the threshold is read from it, not
     from a media query. The column's top row is where the routes to something to
     watch live (`bar`), under it the chat and the roster (`body`).
     T99 / ADR-047 ("the host's dock wins"): `data-panel="chat"` on the root
     element means the host has docked this page as the column - the picture is
     the site view then, not ours - and the rules after the narrow ones below
     turn this grid into that one column. */
  .watch {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--chat-column, 380px);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'picture invite'
      'picture body';
    gap: 0.75rem 1rem;
    flex: 1 1 auto;
    min-height: 0;
  }

  .picture {
    grid-area: picture;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* T97 / ADR-047: the invite bar is one row of the chat column - the code, the
     link, one Copy and the disclosure. Short lines and ellipsis keep it to a
     row at the 380 px column; the full link stays in the DOM and in `title`. */
  .invite-bar {
    grid-area: invite;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
    font-size: 0.8rem;
  }

  .invite-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .invite-code {
    flex: 0 0 auto;
    color: #9a9aab;
    white-space: nowrap;
  }

  .invite-code strong {
    font-family: Consolas, monospace;
    letter-spacing: 0.12em;
    color: #e9e9ef;
  }

  .invite-link {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    font-family: Consolas, monospace;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: #7fd0a5;
  }

  .invite-copy,
  .invite-more {
    flex: 0 0 auto;
    padding: 0.2rem 0.55rem;
    font-size: 0.8rem;
  }

  .invite-note {
    flex: 1 1 auto;
    min-width: 0;
    color: #9a9aab;
  }

  /* T98 / §6: a lost connection's one line, inside the chat column. */
  .connection-lost {
    margin: 0.35rem 0 0;
    color: #ffb3a7;
    line-height: 1.4;
  }

  .invite-fallback {
    margin-top: 0.35rem;
    padding-top: 0.35rem;
    border-top: 1px solid #2c2d36;
  }

  .invite-raw {
    margin: 0 0 0.3rem;
    font-family: Consolas, monospace;
    line-height: 1.4;
    overflow-wrap: anywhere;
    color: #e9e9ef;
  }

  .invite-reason {
    margin: 0 0 0.3rem;
    line-height: 1.4;
    color: #ffb3a7;
  }

  /* ADR-047: the column moves under the picture and the picture is bounded to
     at most 60% of the content height, so the chat always has room and its own
     list is still the only thing that scrolls. The three parts are stacked in
     the markup's own order - picture, the routes, the chat - and the picture
     gives way first when the window is too short for the column's controls. */
  :global(html[data-layout='narrow']) .watch {
    display: flex;
    flex-direction: column;
    gap: 0.75rem 0;
  }

  :global(html[data-layout='narrow']) .picture {
    flex: 0 1 auto;
    max-height: 60%;
  }

  /* T97: the bar is the chat's first row in narrow too, so it stays between the
     picture and the messages and never floats over either. */
  :global(html[data-layout='narrow']) .invite-bar {
    flex: 0 0 auto;
  }

  /* The chat's heading and input are not the picture's to squeeze: the column
     asks for no width of its own and keeps eight lines' worth, so the picture
     gives way first and the roster scrolls into view. */
  :global(html[data-layout='narrow']) .room-body {
    flex: 1 1 0;
    min-height: 8rem;
  }

  /* T99 / ADR-047 ("the host's dock wins"): the host has docked this page as the
     chat column, so the picture is the site view's and this page draws one
     column - the invite bar, then the chat, the roster and the controls. These
     rules sit after the narrow ones on purpose: they have the same specificity,
     so `data-panel="chat"` wins over `data-layout="narrow"` by coming later, and
     a narrow page-mode window draws no second, empty picture. */
  :global(html[data-panel='chat']) .watch {
    display: flex;
    flex-direction: column;
    gap: 0.75rem 0;
  }

  :global(html[data-panel='chat']) .invite-bar {
    flex: 0 0 auto;
  }

  :global(html[data-panel='chat']) .room-body {
    flex: 1 1 0;
    min-height: 0;
  }

  /* T03b: the page's own bar at the top of the app view; the host reserves no
     strip above it and gives it no height. Sticky inside the page's own box -
     on the watching screen the page itself does not scroll, only the chat's
     list does (T96), so the bar stays at the top. */
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

  /* T95b / ADR-047: the bar's one row - the field (with the Paste button drawn
     over its right end) and Open a file beside it. The two routes are always
     both here: the field sends a page, the button opens a file. */
  .bar-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .bar-row form {
    flex: 1 1 auto;
    min-width: 0;
    align-items: center;
  }

  .bar-field {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
  }

  /* The field's text stops short of the button, so a long address never runs
     under it: the right padding is the button's own width and its margin. */
  .bar-field input {
    width: 100%;
    padding: 0.35rem 4.9rem 0.35rem 0.5rem;
  }

  .address-bar .paste {
    position: absolute;
    right: 0.3rem;
    top: 50%;
    transform: translateY(-50%);
    padding: 0.25rem 0.65rem;
    font-size: 0.9rem;
  }

  .open-file {
    flex: 0 0 auto;
    padding: 0.35rem 0.7rem;
  }

  .open-file:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .bar-notice {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.25;
    color: #ffb3a7;
  }

  .bar-notice.ok {
    color: #7fd0a5;
  }

  /* T04b: the popup line, in the bar's own quiet grey. It is information, not
     a refusal the person has to answer, and it clears itself in ten seconds. */
  .bar-popup {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.25;
    color: #c9ccd8;
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

  /* T150: the line beside the front door's action - ordinary size, not small
     print, because it answers what the button does. */
  .already-open {
    margin: 0.75rem 0 1.5rem;
    font-size: 1rem;
    line-height: 1.5;
    color: #c8c8d2;
  }

  /* T150: the empty picture is a sentence in the area, not a dead rectangle. */
  .empty-picture {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    min-height: 10rem;
    margin: 0;
    border: 1px dashed #2c2d36;
    border-radius: 8px;
    color: #9a9aab;
    font-size: 1.1rem;
  }

  .sentence.error {
    margin: 0.75rem 0 0;
    color: #ffb3a7;
  }

  /* T98 / ADR-047: the first screen's line after a room ended. One plain
     sentence, not a red panel: the screen around it is a live room. */
  .ended-line {
    margin: 0 0 1.5rem;
    padding: 0.75rem 1rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
    color: #ffb3a7;
    line-height: 1.5;
  }

  .invite {
    padding: 1rem 1.25rem;
    margin: 0 0 1.5rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
  }

  .manual {
    padding: 1rem 1.25rem;
    margin: 0 0 1.5rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
  }

  .manual h3 {
    margin: 0 0 0.5rem;
    font-size: 0.95rem;
    font-weight: 600;
    color: #c8c8d2;
  }

  .manual p {
    margin: 0 0 0.5rem;
    line-height: 1.5;
    color: #9a9aab;
  }

  .manual ul {
    margin: 0 0 0.5rem;
    padding-left: 1.1rem;
    line-height: 1.7;
  }

  .manual strong {
    font-family: Consolas, monospace;
    color: #e9e9ef;
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

  /* ADR-047 / ADR-049: the chat column - the chat's list and its input, with the
     roster under them, and the column is the bar's and the body's two rows. The
     chat takes the column's spare height with a definite size, so the list below
     is the only thing that scrolls: the heading and the input keep their height,
     the invite bar above and the roster below never move. */
  .room-body {
    grid-area: body;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
    min-height: 0;
    /* A valve only: the column does not grow past the body, so this never fires
       while the list has room to give. */
    overflow-y: auto;
  }

  .chat {
    display: flex;
    flex-direction: column;
    /* ADR-049: `flex-basis: 0` is what makes the list's height *definite* rather
       than its content's - the roster below cannot be pushed by a message. */
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .chat h2 {
    margin-top: 0;
  }

  .chat h2,
  .chat form {
    flex: 0 0 auto;
  }

  .roster {
    flex: 0 0 auto;
    min-width: 0;
  }

  /* T154 / ADR-049: one line, "N online", where the names used to be, and the
     names only under it once asked for. A button, so it is keyboard reachable
     and its state is `aria-expanded`; the chevron turns when it opens. */
  .roster-toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: 1px solid #2c2d36;
    border-radius: 6px;
    background: #1a1b22;
    color: #c8c8d2;
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }

  .roster-toggle:hover,
  .roster-toggle:focus-visible {
    border-color: #4a4b57;
    color: #e9e9ef;
  }

  .roster-toggle .count {
    font-variant-numeric: tabular-nums;
  }

  /* A drawn triangle, not a character: the header's own text is the count, so a
     quoted `textContent` reads exactly "2 online". */
  .roster-toggle .chevron {
    width: 0;
    height: 0;
    border-left: 5px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transition: transform 120ms ease;
  }

  .roster-toggle[aria-expanded='true'] .chevron {
    transform: rotate(90deg);
  }

  .roster ul {
    margin: 0.35rem 0 0;
    padding: 0 0.25rem;
    list-style: none;
  }

  .roster li {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    line-height: 1.6;
  }

  /* ADR-049: the crown is the room's owner, which is the snapshot's `owner`.
     Control is a different thing and may be granted (ADR-033). */
  .roster .crown {
    color: #e0b34a;
    font-size: 0.95rem;
  }

  /* ADR-049: the messages are the column's only scroller. The bar is thin and
     its thumb is invisible until the pointer is over the list, so a still list
     is a plain panel and a scrolling one shows a quiet hint. These are the
     standard properties: WebView2 157 honours `scrollbar-width`/`scrollbar-color`
     and drops the legacy `::-webkit-scrollbar` rules when they are set. */
  .messages {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding: 0.5rem 0.75rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
  }

  .messages:hover,
  .messages:focus-within {
    scrollbar-color: #4a4b57 transparent;
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

  /* ADR-049: every line carries its time, small, on the same line as the author;
     a system line has the time and no author. */
  .message .time,
  .system .time {
    margin-right: 0.45rem;
    font-size: 0.72rem;
    color: #6b6b79;
    font-variant-numeric: tabular-nums;
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

  /* T149 / ADR-049: the notices are their own strip between the messages and
     the input - the chat's only scroller stays the messages, so these do not
     scroll away with them. One tone: a notice is news about the person's own
     state, not an alarm, and the dismiss button is always beside it. */
  .notices {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.5rem 0.75rem 0;
  }

  .notice {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0;
    padding: 0.35rem 0.5rem;
    border: 1px solid #4a3f24;
    border-radius: 6px;
    background: #211d14;
    color: #e0b34a;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .notice .dismiss {
    flex: none;
    padding: 0.1rem 0.5rem;
    border-color: #4a3f24;
    background: transparent;
    color: #e0b34a;
    font-size: 0.85rem;
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
</style>
