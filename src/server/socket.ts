import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer } from 'ws'

import { normalizeName } from '../shared/names.ts'
import { admitChat, formatClock, newChatBudget, type ChatBudget } from '../shared/chat.ts'
import {
  errorFrame,
  stateFrame,
  warningFrame,
  type ChatMessage,
  type ClientFrame,
  type ErrorCode,
  type Member,
  type PlaybackReason,
  type ServerFrame,
} from '../shared/protocol.ts'
import {
  applyCommand,
  displayNameOf,
  joinRoom,
  markOffline,
  postChat,
  postSystemChat,
  renameMember,
  snapshot,
  wireMembers,
  type RoomState,
} from './room.ts'

/** Only what this file uses of a `ws` socket; the library's types are not installed. */
interface PeerSocket {
  send(data: string): void
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
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  )
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

  const sockets = new Map<PeerSocket, Member>()
  /** §4.6's limits are per member, kept beside the sockets rather than in the room. */
  const budgets = new Map<string, ChatBudget>()
  const wss = new WebSocketServer({ server, path: '/' })

  const send = (socket: PeerSocket, frame: ServerFrame): void => {
    socket.send(JSON.stringify(frame))
  }

  const fail = (socket: PeerSocket, code: ErrorCode): void => {
    send(socket, errorFrame(code))
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
        `position=${room.playback.position.toFixed(3)} by=${by}`,
    )
    for (const socket of sockets.keys()) socket.send(text)
  }

  const joinMember = (socket: PeerSocket, frame: ClientFrame, remoteAddress: string | undefined): void => {
    if (frame.type !== 'hello') return
    if (frame.code !== room.code) {
      // The socket stays open: the page shows one sentence and lets them retype.
      fail(socket, 'bad_room')
      return
    }

    const joinedAt = now()
    const candidate: Member = {
      id: newId(),
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

    const result = joinRoom(room, candidate, { isLocal: isLocal(remoteAddress) })
    if (!result.ok) {
      fail(socket, result.code)
      return
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
    })
    // §4.3 invariant 9 has no separate frame here: the snapshot *is* the
    // command, and `room.revision` travels with it. A newcomer's arrival must
    // produce no `state` for anyone (T6b's Safety line), so the alignment is a
    // welcome and nothing else.
    broadcastMembers()
    broadcastChat(postSystemChat(room, result.member.id, (label) => `${label} joined`, now))
  }

  wss.on('connection', (socket: PeerSocket, request: IncomingMessage) => {
    socket.on('error', () => {
      // A socket that dies mid-frame is the close handler's business.
    })

    socket.on('message', (data) => {
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
          // honest (the 10 s / 20 s presence ladder is a later ticket), and the
          // same frame is the clock sample. `t1` is the receive instant and `t2`
          // the send one; the member works out its own offset from all four and
          // the authority never learns it (§4.3 invariant 4).
          if (typeof frame.t0 !== 'number' || !Number.isFinite(frame.t0)) return
          member.lastSeen = now()
          const t1 = now()
          send(socket, { type: 'pong', t0: frame.t0, t1, t2: now() })
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
            // The warning names a member's own state, so it goes to that member only.
            if (verdict.muted) send(socket, warningFrame(verdict.code))
            fail(socket, verdict.code)
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
          return
        }
        default:
          // §5: unknown message types are ignored, not fatal (forward compatibility).
          // `report` lands here until the ticket that reads it: it is a member's
          // own measurement, never a command, so it cannot move `playback` or
          // `revision` (§4.3 invariant 1, T6a's Safety line).
          return
      }
    })

    socket.on('close', () => {
      const member = sockets.get(socket)
      if (member === undefined) return
      const label = displayNameOf(room, member.id)
      sockets.delete(socket)
      budgets.delete(member.id)
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
