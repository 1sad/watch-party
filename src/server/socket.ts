import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer } from 'ws'

import { normalizeName } from '../shared/names.ts'
import { admitChat, formatClock, newChatBudget, type ChatBudget } from '../shared/chat.ts'
import {
  errorFrame,
  warningFrame,
  type ChatMessage,
  type ClientFrame,
  type ErrorCode,
  type Member,
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
          const state: ServerFrame = {
            type: 'state',
            playback: room.playback,
            revision: room.revision,
            by: member.id,
          }
          const text = JSON.stringify(state)
          for (const peer of sockets.keys()) peer.send(text)
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
