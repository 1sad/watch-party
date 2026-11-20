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

export interface ChatMessage {
  id: string
  name: string
  text: string
  ts: number
}

export type ErrorCode = 'bad_room' | 'room_full' | 'not_controller'

/** One sentence per code, shown as written (§5: "a refusal is explicit"). */
export const ERROR_SENTENCES: Record<ErrorCode, string> = {
  bad_room: 'That room code does not match this room.',
  room_full: 'This room is full — five people is the limit.',
  not_controller: 'Only the person who started the room can change this.',
}

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

export type ClientFrame = HelloFrame | RenameFrame | CommandFrame

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

export type ServerFrame = WelcomeFrame | MembersFrame | StateFrame | ErrorFrame
