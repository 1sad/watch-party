/**
 * The wire, from `spec.md` §4.1 and §5. Shared because the page and the sidecar
 * have to agree on it, and because a frame type is not a server concern.
 *
 * The envelope key is `type`. Everything unknown is ignored (§5), so adding a
 * frame later never breaks an older window.
 */

export type MemberStatus = 'online' | 'suspect' | 'offline'
export type Transport = 'app' | 'addon'

export interface MemberSource {
  origin: string
  duration?: number
  w?: number
  h?: number
}

/** `spec.md` §4.1 — exactly these fields, no additions. */
export interface Member {
  id: string
  /** As the person typed it, trimmed; `null` renders as `anonymous` (R26). */
  name: string | null
  joinedAt: number
  transport: Transport
  status: MemberStatus
  lastSeen: number
  rtt: number
  timelineOffset: number
  source: MemberSource | null
  driftStrikes: number
  ready: boolean
  address: string | null
}

/**
 * A member as it goes over the wire: §4.1 plus the label the roster shows.
 * The label is derived by `displayNames()` in `names.ts`, never stored, so a
 * renamed member's duplicate suffix moves without rewriting anyone's name.
 */
export interface WireMember extends Member {
  displayName: string
}

export interface Playback {
  playing: boolean
  position: number
  updatedAt: number
  rate: number
  startAt?: number
  timelineDuration?: number
}

/** `spec.md` §4.1, minus `members`/`chat`, which travel beside it. */
export interface RoomSnapshot {
  code: string
  createdAt: number
  owner: string | null
  authority: { memberId: string; epoch: number }
  controllers: string[]
  page: string | null
  /** §4.2's union arrives with file mode (T6); M1 is website mode only. */
  media: null
  playback: Playback
  revision: number
}

/** The refusals only chat can raise, so `ErrorCode` and the limiter share them. */
export type ChatRefusalCode = 'chat_too_long' | 'chat_rate_limited' | 'chat_byte_limit'

/**
 * §4.6's message, exactly. `kind` is what makes a system line dimmable, and a
 * system message never carries a `memberId`: the sentence names no one.
 */
export interface ChatMessage {
  /** Server-assigned and sortable, so every replica shows the same order. */
  id: string
  kind: 'user' | 'system'
  memberId?: string
  /** The display name at send time; for a system line, whoever caused it. */
  name: string
  text: string
  ts: number
}

export type ErrorCode = 'bad_room' | 'room_full' | 'not_controller' | ChatRefusalCode

/** One sentence per code, shown as written (§5: "a refusal is explicit"). */
export const ERROR_SENTENCES: Record<ErrorCode, string> = {
  bad_room: 'That room code does not match this room.',
  room_full: 'This room is full — five people is the limit.',
  not_controller: 'Only the person who started the room can change this.',
  chat_too_long: 'A chat message can be at most 2000 characters.',
  chat_rate_limited: 'That is too many messages in a row — wait a few seconds.',
  chat_byte_limit:
    'You have sent a lot of text in the last minute — wait a moment before sending more.',
}

/**
 * The soft half of §4.6's rate limit: sent once, to the member who was muted,
 * and never to the room — a per-member fact does not go in chat.
 */
export const CHAT_MUTE_WARNING =
  'You are sending messages too quickly, so chat is muted for 10 seconds.'

export interface ErrorFrame {
  type: 'error'
  code: ErrorCode
  message: string
}

/**
 * The single place an `error` frame is made, so its shape cannot drift
 * between the tickets that raise one (T3 onward).
 */
export function errorFrame(code: ErrorCode): ErrorFrame {
  return { type: 'error', code, message: ERROR_SENTENCES[code] }
}

/**
 * A notice that is not a refusal of this exact message but changes what the
 * member may do next (§4.6: "a soft warning and a 10 s mute"). Same shape as
 * `error`, one sentence, only ever sent to the member it concerns.
 */
export interface WarningFrame {
  type: 'warning'
  code: ErrorCode
  message: string
}

export function warningFrame(code: ErrorCode): WarningFrame {
  return { type: 'warning', code, message: CHAT_MUTE_WARNING }
}

export interface HelloFrame {
  type: 'hello'
  code: string
  name?: string | null
  lastEpoch?: number
}

export interface RenameFrame {
  type: 'rename'
  /** `null` clears the name back to `anonymous` (§5). */
  name: string | null
}

export interface PlayFrame {
  type: 'play'
  position?: number
}

export interface PauseFrame {
  type: 'pause'
  position?: number
}

export interface SeekFrame {
  type: 'seek'
  position: number
  wasPlaying?: boolean
}

export type CommandFrame = PlayFrame | PauseFrame | SeekFrame

/** m→a: what the member typed. The authority supplies everything else (§5). */
export interface ChatSendFrame {
  type: 'chat'
  text: string
}

/**
 * m→a: §6.1's one loop with two jobs — the liveness beat and the clock sample.
 * The authority echoes `t0` untouched; the member alone computes the offset
 * (§4.3 invariant 4: the authority never holds a member's offset).
 */
export interface PingFrame {
  type: 'ping'
  /** The member's `Date.now()` when the ping left. */
  t0: number
}

/** a→m: §6.1's four instants, two of them the authority's own. */
export interface PongFrame {
  type: 'pong'
  t0: number
  /** The authority's clock when the ping arrived. */
  t1: number
  /** The authority's clock when the pong left. */
  t2: number
}

export type ClientFrame = HelloFrame | RenameFrame | CommandFrame | ChatSendFrame | PingFrame

export interface WelcomeFrame {
  type: 'welcome'
  selfId: string
  room: RoomSnapshot
  members: WireMember[]
  chatTail: ChatMessage[]
  epoch: number
}

export interface MembersFrame {
  type: 'members'
  members: WireMember[]
}

export interface StateFrame {
  type: 'state'
  playback: Playback
  revision: number
  by: string
  reason?: string
}

/** a→m: one message, to every member including its sender (§5). */
export type ChatFrame = ChatMessage & { type: 'chat' }

export type ServerFrame =
  | WelcomeFrame
  | MembersFrame
  | StateFrame
  | ErrorFrame
  | WarningFrame
  | ChatFrame
  | PongFrame
