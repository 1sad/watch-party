import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer } from 'ws'

import { normalizeName } from '../shared/names.ts'
import { admitChat, formatClock, newChatBudget, type ChatBudget } from '../shared/chat.ts'
import {
  errorFrame,
  pageCommittedFrame,
  ROOM_OVER_SENTENCE,
  stateFrame,
  warningFrame,
  type ChatMessage,
  type ClientFrame,
  type ErrorCode,
  type Member,
  type Playback,
  type PlaybackReason,
  type ServerFrame,
} from '../shared/protocol.ts'
import {
  CORRECTION_DEADBAND_SECONDS,
  clampToMedia,
  decideCorrection,
  reportFrom,
  targetFor,
} from '../shared/timing.ts'
import {
  applyCommand,
  cancelPage,
  commitDuePage,
  discardRoom,
  displayNameOf,
  dropPendingPage,
  joinRoom,
  markOffline,
  postChat,
  postSystemChat,
  renameMember,
  setMedia,
  snapshot,
  stagePage,
  wireMembers,
  type RoomState,
} from './room.ts'

/** Only what this file uses of a `ws` socket; the library's types are not installed. */
interface PeerSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface RoomSocketOptions {
  now?: () => number
  newId?: () => string
  /**
   * ADR-030: the window's own page holds control, and a guest's never does.
   * The sidecar tells them apart by where the connection came from — the window
   * loads the page from 127.0.0.1, a guest dials the LAN address.
   */
  isLocal?: (remoteAddress: string | undefined) => boolean
  /**
   * A dev-only line per `state` frame, so T6b's "exactly one `state` per
   * command" is countable in the host log. `main.ts` passes it only when it is
   * not a production sidecar; it is not a wire feature and changes no rule.
   */
  debug?: (line: string) => void
  /**
   * One line per file the room registers (T9a2). The picker's checks are the
   * page's; this is the sidecar's own record that a file was accepted, with the
   * duration the owner's page measured — which is how a check tells an accepted
   * pick from a refused one.
   */
  log?: (line: string) => void
  /**
   * T71: the refusal book, shared with the HTTP gate so a wrong code costs the
   * same callers the same minute whichever door they knock on. `main.ts` passes
   * one instance to both; a test that does not pass one gets its own.
   */
  refusals?: RefusalBook
}

/**
 * T148 / ADR-033 rule 1: the older socket of a re-seated member is closed with
 * this pair, so the room holds one connection per seat and the person's other
 * window can tell why. 4001 is in the application range `ws` accepts
 * (3000-4999); the reason is ASCII (`AGENTS.md` rule 10).
 */
export const SEAT_REUSED_CLOSE_CODE = 4001
export const SEAT_REUSED_CLOSE_REASON = 'seat reused'

/**
 * T148b / ADR-049: presence is what the room hears, not what its socket map
 * once held. A member whose last `ping` is older than this is marked `offline`
 * and drops out of the count and the roster (§4.4: `offline` at 20 s). The
 * integration harness sets `WATCHPARTY_PRESENCE_MS=1500` on its own process so
 * the case does not wait 20 s; the shipped sidecar has no such variable and
 * uses this default.
 */
export const PRESENCE_SWEEP_MS = 20_000

/** The cutoff in force, read when a room's socket is attached so a test can set it. */
function presenceSweepMs(): number {
  const override = Number(process.env.WATCHPARTY_PRESENCE_MS)
  return Number.isFinite(override) && override >= 1 ? override : PRESENCE_SWEEP_MS
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  )
}

/**
 * T68, ADR-044: a wrong code stops being free. Two counters, both measured from
 * the authority's clock (`options.now`, so a test can move it):
 *
 * - one socket is closed after `SOCKET_REFUSAL_LIMIT` refused joins on it;
 * - one address is barred for `ADDRESS_BLOCK_MS` once it has
 *   `ADDRESS_REFUSAL_LIMIT` refused joins inside `ADDRESS_REFUSAL_WINDOW_MS`.
 *
 * The socket limit is the cheap one (the page lets a person retype a typo); the
 * address limit is what a script cannot afford, because it has to spend four
 * sockets to reach it and then waits a minute. The state lives here, beside the
 * sockets, and nowhere in the room: no protocol frame changes.
 */
export const SOCKET_REFUSAL_LIMIT = 5
export const ADDRESS_REFUSAL_LIMIT = 20
export const ADDRESS_REFUSAL_WINDOW_MS = 60_000
export const ADDRESS_BLOCK_MS = 60_000

/** What one refused join cost, and what the authority does about it. */
export interface RefusalDecision {
  /** Refused joins on this one socket, this one included. */
  socketRefusals: number
  /** This socket has had its `SOCKET_REFUSAL_LIMIT`; close it. */
  closeSocket: boolean
  /** Refused joins from this address inside the window, this one included. */
  addressRefusals: number
  /** The address is barred now, for `ADDRESS_BLOCK_MS`. */
  blockAddress: boolean
}

export interface RefusalBook {
  /** Counts one refused join, keyed by the socket and by its address. */
  refuse(socket: object, address: string): RefusalDecision
  /** Forgets a closed socket; an address keeps its own window. */
  forget(socket: object): void
  /** True while this address is barred. */
  blocked(address: string): boolean
}

export function createRefusalBook(now: () => number = Date.now): RefusalBook {
  const perSocket = new WeakMap<object, number>()
  const perAddress = new Map<string, number[]>()
  const blockedUntil = new Map<string, number>()

  return {
    refuse(socket, address) {
      const socketRefusals = (perSocket.get(socket) ?? 0) + 1
      perSocket.set(socket, socketRefusals)

      const at = now()
      const recent = (perAddress.get(address) ?? []).filter((time) => at - time < ADDRESS_REFUSAL_WINDOW_MS)
      recent.push(at)
      perAddress.set(address, recent)

      const blockAddress = recent.length >= ADDRESS_REFUSAL_LIMIT
      if (blockAddress) blockedUntil.set(address, at + ADDRESS_BLOCK_MS)

      return {
        socketRefusals,
        closeSocket: socketRefusals >= SOCKET_REFUSAL_LIMIT,
        addressRefusals: recent.length,
        blockAddress,
      }
    },

    forget(socket) {
      perSocket.delete(socket)
    },

    blocked(address) {
      const until = blockedUntil.get(address)
      if (until === undefined) return false
      if (now() < until) return true
      blockedUntil.delete(address)
      return false
    },
  }
}

/**
 * The room's WebSocket endpoint on the sidecar's one listener (§5, T3 item 1).
 *
 * The shape of this file is deliberate:
 * - one dispatch `switch`, whose `default` is §5's rule that unknown frame
 *   types are ignored rather than fatal — every later frame type passes here;
 * - `fail()` is the only caller of the one error-frame producer, `errorFrame()`;
 * - every controller-only frame goes through `applyCommand`, the one guard.
 */
export function attachRoomSocket(
  server: Server,
  room: RoomState,
  options: RoomSocketOptions = {},
): WebSocketServer {
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomUUID
  const isLocal = options.isLocal ?? isLoopback
  const debug = options.debug ?? (() => {})
  const log = options.log ?? (() => {})

  const sockets = new Map<PeerSocket, Member>()
  /** §4.6's limits are per member, kept beside the sockets rather than in the room. */
  const budgets = new Map<string, ChatBudget>()
  /**
   * T68: refused joins, per socket and per address. Beside `budgets` for the
   * same reason: a fact about this caller's session, not about the room.
   * T71: the book may arrive already shared with the HTTP gate, so a barred
   * address stays barred on both doors.
   */
  const refusals = options.refusals ?? createRefusalBook(now)
  /** Sockets this file has ended for guessing; their late frames are ignored. */
  const closing = new Set<PeerSocket>()
  /**
   * §6.3's "at most one correction per client per 5 s". It is beside the
   * sockets for the same reason the chat budget is: a fact about this member's
   * session, not about the room.
   */
  const lastCorrectionAt = new Map<string, number>()
  const wss = new WebSocketServer({ server, path: '/' })

  const send = (socket: PeerSocket, frame: ServerFrame): void => {
    socket.send(JSON.stringify(frame))
  }

  const fail = (socket: PeerSocket, code: ErrorCode, retryAfterMs?: number): void => {
    send(socket, errorFrame(code, retryAfterMs))
  }

  // `members` goes to everyone, sender included (§5: a command echoes to its sender).
  const broadcastMembers = (): void => {
    const payload: ServerFrame = { type: 'members', members: wireMembers(room) }
    const text = JSON.stringify(payload)
    for (const socket of sockets.keys()) socket.send(text)
  }

  // Chat goes to everyone, sender included: that is why no page keeps chat state (§5).
  const broadcastChat = (message: ChatMessage): void => {
    const payload: ServerFrame = { type: 'chat', ...message }
    const text = JSON.stringify(payload)
    for (const socket of sockets.keys()) socket.send(text)
  }

  // §5: `state` goes to everyone, sender included, so the sender adopts the
  // authority's `revision` rather than its own guess. One call per *applied*
  // command, so a skipped duplicate is silent (T6a item 4).
  const broadcastState = (by: string, reason: PlaybackReason): void => {
    const payload: ServerFrame = stateFrame(room.playback, room.revision, by, reason)
    const text = JSON.stringify(payload)
    debug(
      `state rev=${room.revision} reason=${reason} playing=${room.playback.playing} ` +
        `position=${room.playback.position.toFixed(3)} startAt=${room.playback.startAt ?? 'none'} by=${by}`,
    )
    for (const socket of sockets.keys()) socket.send(text)
  }

  /**
   * T148b / ADR-049: a member is present only while the room hears from it.
   * The close handler above is the only other path to `offline`, so a socket
   * that dies without a close (Wi-Fi dropping, a suspended laptop) leaves its
   * row `online` for the rest of the evening. This sweep marks that silence:
   * it never closes a socket, never writes `playback` and never touches the one
   * writer's commands. The owner's seat is exempt while its socket is open -
   * the window that serves the room must not make the count say it is empty.
   *
   * The tick is a quarter of the cutoff (capped at one second), so the count
   * drops within a second of the 20 s the spec names rather than at the next
   * full window; the test's 1500 ms cutoff therefore settles inside 4 s.
   */
  const presenceMs = presenceSweepMs()
  const presenceTickMs = Math.min(1000, Math.max(1, Math.floor(presenceMs / 4)))
  const presenceSweep = setInterval(() => {
    const at = now()
    let changed = false
    for (const member of room.members.values()) {
      if (member.status === 'offline') continue
      if (at - member.lastSeen <= presenceMs) continue
      if (room.owner === member.id) {
        const open = [...sockets.values()].some((seated) => seated.id === member.id)
        if (open) continue
      }
      markOffline(room, member.id, () => at)
      changed = true
    }
    if (changed) broadcastMembers()
  }, presenceTickMs)
  presenceSweep.unref?.()
  wss.on('close', () => clearInterval(presenceSweep))

  /**
   * ADR-032's window, owned by the authority and by nothing else. One timer per
   * pending page; it is the only thing that turns `pendingPage` into a
   * `pageCommitted`. No client holds a timer for this, so a slow or frozen
   * window can neither commit early nor late — the page it previews has no say.
   */
  let pageTimer: ReturnType<typeof setTimeout> | null = null

  const stopPageTimer = (): void => {
    if (pageTimer === null) return
    clearTimeout(pageTimer)
    pageTimer = null
  }

  // §5's `pageCommitted` goes to everyone, sender included: every app navigates
  // now, and a later joiner reads the same page from its `welcome` snapshot.
  const commitPage = (): void => {
    const previous = room.page
    const commit = commitDuePage(room, now)
    if (commit === null) return
    const text = JSON.stringify(pageCommittedFrame(commit.page, commit.by, commit.at))
    for (const socket of sockets.keys()) socket.send(text)
    log(`[page] committed page=${commit.page} by=${commit.by} at=${commit.at}`)
    // ADR-049: the room's log says where it went, once, at the commit and never
    // at the stage - a cancelled preview posts nothing, because this function is
    // the only place a page becomes the room's. A re-commit of the page the room
    // already holds says nothing a second time.
    if (commit.page !== previous) {
      broadcastChat(postSystemChat(room, commit.by, () => `Moved to ${commit.page}`, now))
    }
  }

  const startPageTimer = (expiresAt: number): void => {
    stopPageTimer()
    pageTimer = setTimeout(() => {
      pageTimer = null
      const pending = room.pendingPage
      if (pending === null) return
      // A timer that fired a hair early waits out the rest of the window rather
      // than dropping the change: the commit is the authority's decision, and it
      // happens when the window has really ended.
      if (now() < pending.expiresAt) {
        startPageTimer(pending.expiresAt)
        return
      }
      commitPage()
    }, Math.max(0, expiresAt - now()))
    pageTimer.unref?.()
  }

  const joinMember = (socket: PeerSocket, frame: ClientFrame, remoteAddress: string | undefined): void => {
    if (frame.type !== 'hello') return
    const address = remoteAddress ?? 'unknown'
    // T68: a barred address is refused without looking at the code at all, so a
    // guesser that has spent its minute gets one final answer and no comparison.
    if (refusals.blocked(address)) {
      fail(socket, 'bad_room')
      closing.add(socket)
      socket.close()
      return
    }
    // F4: the end is final. The code is left in place, so this has to be asked
    // first — without it a late hello would match, and a loopback client would
    // be seated as a fresh owner of a room the spec says cannot exist.
    if (room.closed) {
      fail(socket, 'bad_room')
      return
    }
    if (frame.code !== room.code) {
      // The socket stays open until it has spent its refusals: the page shows one
      // sentence and lets them retype, and T68 makes a script pay for the loop.
      const verdict = refusals.refuse(socket, address)
      fail(socket, 'bad_room')
      if (verdict.blockAddress) {
        log(
          `[gate] address refused for ${ADDRESS_BLOCK_MS / 1000}s ` +
            `refusals=${verdict.addressRefusals} addr=${address}`,
        )
      }
      if (verdict.closeSocket) {
        closing.add(socket)
        // `close()`, not a drop: the frame above must reach the caller, which is
        // how a test - and a person - sees the fifth refusal end the attempt.
        socket.close()
        log(`[gate] closed socket refusals=${verdict.socketRefusals} addr=${address}`)
      }
      return
    }

    const joinedAt = now()
    // T148 / ADR-033 rule 1: the page's stored id chooses the seat. A client
    // that sends none - a scripted one, or an older page - is a new person and
    // gets a fresh row, exactly as before the field existed.
    // T165 / ADR-053: the id is a quote unless it arrives with the proof the room
    // issued that page (`members` broadcasts every id, so an id is public). A
    // hello naming an occupied row without its proof is seated as a new member.
    const requestedId = typeof frame.id === 'string' ? frame.id.trim() : ''
    const presentedProof = typeof frame.proof === 'string' ? frame.proof : ''
    const candidate: Member = {
      id: requestedId.length === 0 ? newId() : requestedId,
      name: normalizeName(frame.name),
      joinedAt,
      transport: 'app',
      status: 'online',
      lastSeen: joinedAt,
      rtt: 0,
      timelineOffset: 0,
      source: null,
      driftStrikes: 0,
      ready: false,
      address: null,
    }

    const result = joinRoom(room, candidate, {
      isLocal: isLocal(remoteAddress),
      ...(presentedProof.length === 0 ? {} : { proof: presentedProof }),
      mintId: newId,
    })
    if (!result.ok) {
      fail(socket, result.code)
      return
    }
    if (result.seatClaimRefused) {
      // T165: the refused id and the presented proof are data from the wire, and
      // a newline in either would forge a log line (AGENTS.md rule 10), so the
      // line is fixed and names neither.
      log('[room] seat claim refused: a hello named an occupied seat without its proof')
    }

    // T148: one row, one connection. The socket the row pointed at is dropped
    // from the map **before** it is closed, because its close handler reads a
    // seat's absence as a departure - and for the owner that is the room's end.
    // `closing` makes the replaced socket's late frames (a second `hello`, above
    // all) inert rather than a re-seat that would kick this new connection.
    for (const [previous, seated] of sockets) {
      if (seated.id !== result.member.id) continue
      sockets.delete(previous)
      closing.add(previous)
      previous.close(SEAT_REUSED_CLOSE_CODE, SEAT_REUSED_CLOSE_REASON)
      log(`[room] reseated id=${seated.id} addr=${address}`)
    }
    sockets.set(socket, result.member)
    send(socket, {
      type: 'welcome',
      selfId: result.member.id,
      room: snapshot(room),
      members: wireMembers(room),
      // §4.6: the ring buffer itself, already trimmed to the last 100 by `postChat`.
      chatTail: room.chat.slice(),
      epoch: room.authority.epoch,
      // T165 / ADR-053: this connection's own proof, so the page can keep it in
      // its cookie and prove the seat on its next load. Never broadcast.
      proof: result.proof,
    })
    // §4.3 invariant 9 has no separate frame here: the snapshot *is* the
    // command, and `room.revision` travels with it. A newcomer's arrival must
    // produce no `state` for anyone (T6b's Safety line), so the alignment is a
    // welcome and nothing else.
    broadcastMembers()
    broadcastChat(postSystemChat(room, result.member.id, (label) => `${label} joined`, now))
    // T68 box 3's other half: an accepted join is one line, so "a correct code
    // still works" is readable beside the refused sockets. It rides the dev
    // channel like the page's other counting lines: the shipped log's shape is
    // pinned by a contract test that a new line at join time would break.
    debug(`[room] joined id=${result.member.id} addr=${address}`)
  }

  wss.on('connection', (socket: PeerSocket, request: IncomingMessage) => {
    socket.on('error', () => {
      // A socket that dies mid-frame is the close handler's business.
    })

    socket.on('message', (data) => {
      // T68: a socket this file ended for guessing is already closed; anything
      // still in flight from it must not be counted or answered.
      if (closing.has(socket)) return
      const frame = parseFrame(data)
      // Not JSON, or no `type`: nothing to dispatch on, same rule as unknown types.
      if (frame === null) return

      const member = sockets.get(socket)
      if (member === undefined) {
        joinMember(socket, frame, request.socket.remoteAddress)
        return
      }

      switch (frame.type) {
        case 'rename': {
          renameMember(room, member.id, normalizeName(frame.name), now)
          broadcastMembers()
          return
        }
        case 'play':
        case 'pause':
        case 'seek': {
          const result = applyCommand(room, member.id, frame, now)
          if (!result.ok) {
            fail(socket, result.code)
            return
          }
          // §5's idempotency rule: an accepted-but-unchanged command is not
          // news. No `state`, no `revision` bump, and no "seeked to" line.
          if (!result.applied) return
          // §6.4's decision, once per press: the instant and the input that
          // produced it, so the manual gate can read floor vs RTT.
          if (result.startAt !== undefined) {
            debug(
              `scheduled-start startAt=${result.startAt} maxRtt=${result.maxRtt ?? 0} ` +
                `leadMs=${result.leadMs ?? 0} reason=${result.reason}`,
            )
          }
          broadcastState(member.id, result.reason)
          if (frame.type === 'seek') {
            // §4.6's third sentence: the authority's position, never the client's text.
            broadcastChat(
              postSystemChat(
                room,
                member.id,
                (label) => `${label} seeked to ${formatClock(room.playback.position)}`,
                now,
              ),
            )
          }
          return
        }
        case 'ping': {
          // §6.1: one loop, two jobs. The beat keeps this member's `lastSeen`
          // honest (the 10 s / 20 s presence ladder is T17's), and the
          // same frame is the clock sample. `t1` is the receive instant and `t2`
          // the send one; the member works out its own offset from all four and
          // the authority never learns it (§4.3 invariant 4).
          if (typeof frame.t0 !== 'number' || !Number.isFinite(frame.t0)) return
          member.lastSeen = now()
          const t1 = now()
          send(socket, { type: 'pong', t0: frame.t0, t1, t2: now() })
          return
        }
        case 'report': {
          // §5: a measurement, never a command. It may produce a correction to
          // **this member only**; it can never move `playback` or `revision`
          // (§4.3 invariant 1, T6a's Safety line).
          if (
            typeof frame.position !== 'number' ||
            !Number.isFinite(frame.position) ||
            typeof frame.readyState !== 'number' ||
            !Number.isFinite(frame.readyState) ||
            typeof frame.rtt !== 'number' ||
            !Number.isFinite(frame.rtt)
          ) {
            return
          }

          const at = now()
          // §6.4: the authority's `maxRtt` input arrives on every report (T8).
          member.rtt = Math.max(0, frame.rtt)

          // §4.5's sign, once: the member's playhead in room time versus where
          // the room says this member's copy should be.
          const target =
            typeof frame.duration === 'number' && Number.isFinite(frame.duration)
              ? clampToMedia(targetFor(room.playback, member, at), frame.duration)
              : targetFor(room.playback, member, at)
          const drift = reportFrom(frame.position, member) - target
          const bad = Math.abs(drift) >= CORRECTION_DEADBAND_SECONDS
          // §6.3's first guard: consecutive bad reports, cleared by a good one.
          // A buffering report still counts — the drift is real even though the
          // correction has to wait (§6.7).
          member.driftStrikes = bad ? member.driftStrikes + 1 : 0

          const decision = decideCorrection({
            drift,
            playing: room.playback.playing,
            readyState: frame.readyState,
            driftStrikes: member.driftStrikes,
            lastCorrectionAt: lastCorrectionAt.get(member.id) ?? null,
            nowMs: at,
            target,
          })

          // The manual gate (T7b2) reads this rather than guessing: every input
          // and the action chosen, one line per report, dev builds only.
          debug(
            `correction member=${member.id} drift=${drift.toFixed(3)} ` +
              `readyState=${frame.readyState} strikes=${member.driftStrikes} ` +
              `last=${lastCorrectionAt.get(member.id) ?? 'none'} action=${decision.action} ` +
              `rate=${decision.rate}`,
          )

          if (decision.action === 'none') return
          lastCorrectionAt.set(member.id, at)

          if (decision.action === 'nudge') {
            // §6.3, to that one client only: a rate, the place the gap is
            // heading, and the authority-clock bound the page enforces (T7b2).
            send(socket, {
              type: 'nudge',
              target: decision.target ?? target,
              rate: decision.rate,
              untilAuthorityMs: decision.untilAuthorityMs ?? at,
            })
            return
          }

          // A hard seek (§6.3) or a paused snap (§6.3) is a **targeted**
          // `state`: the frame shape the page already applies, sent to this
          // socket alone. `room.playback` is untouched, so no revision moves
          // and no other member is disturbed (R8).
          const correction: Playback = {
            ...room.playback,
            position: decision.target ?? target,
            updatedAt: at,
          }
          send(socket, stateFrame(correction, room.revision, room.authority.memberId, 'seek'))
          return
        }
        case 'setMedia': {
          // §7.2, owner-only and checked by `setMedia()` before anything is
          // assigned. A frame that cannot be read is ignored (§5), not refused:
          // the same rule `report` and `chat` keep.
          if (
            typeof frame.id !== 'string' ||
            typeof frame.title !== 'string' ||
            typeof frame.duration !== 'number' ||
            !Number.isFinite(frame.duration) ||
            typeof frame.path !== 'string' ||
            typeof frame.epoch !== 'number' ||
            !Number.isFinite(frame.epoch)
          ) {
            return
          }
          const result = setMedia(room, member.id, frame, existsSync)
          if (!result.ok) {
            fail(socket, result.code)
            return
          }
          // A successful pick cleared any pending page (§4.2), so its window has
          // nothing left to commit and the timer goes with it. A **refused** pick
          // returned above, leaving the pending page exactly where it was.
          stopPageTimer()
          // T9a2: the room's record of what it accepted, with the duration the
          // owner's page measured before this frame was sent. A refused pick
          // never reaches here, so this line's absence is the proof that no file
          // was registered.
          const registered = room.media
          if (registered !== null) {
            log(
              `[media] registered id=${registered.id} title=${registered.title} ` +
                `duration=${registered.duration} type=${registered.contentType} path=${registered.path}`,
            )
          }
          // T9a3: every window already here learns the same field `welcome`
          // carries — the owner's included, which otherwise hears nothing of its
          // own pick. It is the wire snapshot, so the path stays in this process.
          const mediaText = JSON.stringify({ type: 'media', media: snapshot(room).media } satisfies ServerFrame)
          for (const socket of sockets.keys()) socket.send(mediaText)
          // T166 / R44, ADR-050 item 1: `setMedia()` has moved the room to
          // position 0, paused, and this is the authority publishing it - the
          // frame §5 already has, not a second reset. It follows the `media`
          // frame so a window that was holding its own preview has already
          // dropped it (the pick ends the page), and the page applies the reset
          // to the new film instead of seeking it to the old film's position.
          broadcastState(member.id, 'media')
          // ADR-049: the pick is the room's log's second event - one dimmed line
          // at the moment the file becomes the room's, naming the file by the
          // title the picker gave it (never the path, which stays here).
          if (registered !== null) {
            broadcastChat(postSystemChat(room, member.id, () => `Opened ${registered.title}`, now))
          }
          return
        }
        case 'setPage': {
          // A frame that cannot be read is ignored (§5), the same rule `report`,
          // `chat` and `setMedia` keep.
          if (
            typeof frame.page !== 'string' ||
            typeof frame.epoch !== 'number' ||
            !Number.isFinite(frame.epoch)
          ) {
            return
          }
          const result = stagePage(room, member.id, frame.page, frame.epoch, now)
          if (!result.ok) {
            // `bad_page` is not a wire code (§5 has none, and inventing one is a
            // protocol change), so an address that cannot be shared is dropped
            // silently like an unreadable frame.
            if (result.code !== 'bad_page') fail(socket, result.code)
            return
          }
          // ADR-032: nothing goes to any client — the initiator included — until
          // the window ends. The initiator's own preview is local to their
          // window (03b); only the authority's timer speaks here.
          startPageTimer(result.pending.expiresAt)
          return
        }
        case 'cancelPage': {
          if (typeof frame.epoch !== 'number' || !Number.isFinite(frame.epoch)) return
          const result = cancelPage(room, member.id, frame.epoch)
          if (!result.ok) {
            fail(socket, result.code)
            return
          }
          // §5: "nobody else ever hears of it" — no frame, no chat line.
          if (result.cancelled) stopPageTimer()
          return
        }
        case 'chat': {
          // Not text is not a frame we know how to refuse: §5 ignores what it cannot read.
          if (typeof frame.text !== 'string' || frame.text.length === 0) return
          const at = now()
          const budget = budgets.get(member.id) ?? newChatBudget()
          budgets.set(member.id, budget)
          const verdict = admitChat(budget, frame.text, at)
          if (!verdict.ok) {
            // T149: the window the server began the mute in is not the window
            // this client receives it in, so the remaining time travels with
            // the refusal and the page's notice is timed from it. It is the
            // limiter's own `mutedUntil`, read and never written: the rate
            // limit itself is untouched.
            const retryAfterMs = Math.max(0, budget.mutedUntil - at)
            // The warning names a member's own state, so it goes to that member only.
            if (verdict.muted) send(socket, warningFrame(verdict.code, retryAfterMs))
            fail(socket, verdict.code, verdict.code === 'chat_rate_limited' ? retryAfterMs : undefined)
            return
          }
          const message = postChat(
            room,
            {
              kind: 'user',
              memberId: member.id,
              name: displayNameOf(room, member.id),
              text: frame.text,
            },
            () => at,
          )
          broadcastChat(message)
          // T22: one line per accepted message, the sender and the length - never
          // the text, and ASCII whatever was typed (`AGENTS.md` rule 10). The
          // message id lets this line be paired with the page's own line.
          log(`[chat] m=${message.id} from=${member.id} chars=${frame.text.length}`)
          return
        }
        default:
          // §5: unknown message types are ignored, not fatal (forward compatibility).
          return
      }
    })

    socket.on('close', () => {
      refusals.forget(socket)
      closing.delete(socket)
      const member = sockets.get(socket)
      if (member === undefined) return
      const label = displayNameOf(room, member.id)
      sockets.delete(socket)
      budgets.delete(member.id)
      lastCorrectionAt.delete(member.id)
      // ADR-032: the initiator leaving mid-window discards the pending entry —
      // nobody else ever learns what they nearly changed (§5).
      if (dropPendingPage(room, member.id)) stopPageTimer()

      // §14's "owner leaves in file mode: room ends, everyone told plainly, no
      // pretend recovery" (ADR-024). File mode is the only mode this phase has,
      // so the end fires whether or not a file was picked. Website mode's
      // transfer of authority (T22) is a later mode, not a counter-case.
      if (room.owner === member.id) {
        // No window outlives the room it belonged to.
        stopPageTimer()
        // One system line, not "sam left" plus a second line: the room's end is
        // the one fact worth telling, and chat carries it exactly once (§4.6).
        broadcastChat(postChat(room, { kind: 'system', name: label, text: ROOM_OVER_SENTENCE }, now))
        const over = JSON.stringify({ type: 'roomOver', reason: 'owner_left' } satisfies ServerFrame)
        // Every client, not only `sockets`: `wss.close()` stops new upgrades but
        // leaves existing clients open, and a socket that connected without a
        // `hello` never entered `sockets`. It must not survive to try one.
        for (const remaining of wss.clients) {
          remaining.send(over)
          if (sockets.has(remaining)) {
            // `close()`, not `terminate()`: the frame above must leave before the
            // socket does, and `ws` flushes what is queued before the close frame.
            remaining.close()
          } else {
            remaining.terminate()
          }
        }
        sockets.clear()
        budgets.clear()
        lastCorrectionAt.clear()
        // §4.4: the replica is discarded when its last connection fails. The
        // file's path goes with it (so `/media/<id>` is a 404 from here), and the
        // endpoint closes, so a window that tries to rejoin finds no room at all.
        discardRoom(room, now)
        wss.close()
        // T130: this line is the host's whole "the room is over" signal, and its
        // prefix `[room] over ` (trailing space included) is the token the host
        // matches - host/WatchParty.Host/RoomOverLine.cs, read by MainForm.cs'
        // sidecar-stdout arm. Change the wording here and change it there.
        log(`[room] over reason=owner_left id=${member.id}`)
        return
      }

      broadcastChat(postChat(room, { kind: 'system', name: label, text: `${label} left` }, now))
      markOffline(room, member.id, now)
      broadcastMembers()
    })
  })

  return wss
}

/** A frame is dispatchable only if it is an object carrying a string `type`. */
function parseFrame(data: unknown): (ClientFrame & Record<string, unknown>) | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(data))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const type = (parsed as { type?: unknown }).type
  if (typeof type !== 'string') return null
  return parsed as ClientFrame & Record<string, unknown>
}
