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

/**
 * §4.2's file half, as the wire sees it (T9a1). It deliberately has no
 * filesystem path: the room holds that, the sidecar serves the bytes, and every
 * other window asks for `/media/<id>` on the owner's machine. The field §4.2
 * calls `title` is the display name the roster shows.
 */
export interface FileMedia {
  kind: 'file'
  id: string
  title: string
  duration: number
  /** One of ADR-035's four, derived from the extension when the file was set. */
  contentType: string
}

/** §4.2. Website mode leaves `media` null and carries the address in `page`. */
export type Media = FileMedia

/** `spec.md` §4.1, minus `members`/`chat`, which travel beside it. */
export interface RoomSnapshot {
  code: string
  createdAt: number
  owner: string | null
  authority: { memberId: string; epoch: number }
  controllers: string[]
  page: string | null
  /** §4.2: file mode sets this and clears `page`; website mode is the reverse. */
  media: Media | null
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

export type ErrorCode =
  | 'bad_room'
  | 'room_full'
  | 'not_controller'
  | 'bad_media'
  | 'unsupported_media'
  | ChatRefusalCode

/** One sentence per code, shown as written (§5: "a refusal is explicit"). */
export const ERROR_SENTENCES: Record<ErrorCode, string> = {
  bad_room: 'That room code does not match this room.',
  room_full: 'This room is full — five people is the limit.',
  not_controller: 'Only the person who started the room can change this.',
  bad_media: 'That file cannot be played — it is missing from this machine, or its path is not absolute.',
  unsupported_media: 'File mode plays MP4, M4V, WebM and MOV files only.',
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

/**
 * m→a: the owner names the one file the room plays (§7.2, R11). The path is an
 * absolute path on the owner's own machine and is never sent back out: guests
 * only ever see `Media.id` and fetch `/media/<id>` from this sidecar.
 */
export interface SetMediaFrame {
  type: 'setMedia'
  id: string
  title: string
  duration: number
  path: string
}

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

/**
 * m→a: §5's `report`, every 3 s while playing. It is a measurement, never a
 * command: it cannot move `playback` or `revision` (§4.3 invariant 1). `rtt` is
 * the member's own T5 estimate; the authority keeps the largest one for the
 * scheduled start's `max(2 × maxRtt, 1.5 s)` (§6.4, T8).
 */
export interface ReportFrame {
  type: 'report'
  /** Media seconds, in the member's own copy's time; `reportFrom` removes the offset. */
  position: number
  /** `< 3` means buffering, and §6.7 forbids a nudge then. */
  readyState: number
  buffered: number
  rate: number
  duration?: number
  origin?: string
  rtt: number
}

/**
 * a→m: §6.3's one correction, to **that member only** (never a broadcast).
 * A nudge carries 0.95 or 1.05; the page restores to 1 itself, and
 * `untilAuthorityMs` is the authority-clock bound that survives a lost restore
 * (T7b2). A seek or a paused snap is a targeted `state` instead, so it takes
 * the page's existing path for moving the playhead.
 */
export interface NudgeFrame {
  type: 'nudge'
  target: number
  rate: number
  untilAuthorityMs: number
}

export type ClientFrame =
  | HelloFrame
  | RenameFrame
  | CommandFrame
  | SetMediaFrame
  | ChatSendFrame
  | PingFrame
  | ReportFrame

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

/**
 * Why a `state` was sent (§5, §6.4). `start` is a scheduled start (§6.4, with
 * `Playback.startAt`) and arrives with T8. `join` stays vocabulary until the
 * authority needs to align a joiner with more than the `welcome` snapshot: on
 * load the snapshot is the alignment (§4.3 invariant 9), and a joiner's arrival
 * must broadcast no `state` at all (T6b's Safety line).
 */
export type PlaybackReason = 'play' | 'pause' | 'seek' | 'start' | 'join'

export interface StateFrame {
  type: 'state'
  playback: Playback
  revision: number
  by: string
  reason: PlaybackReason
}

/**
 * The single place a `state` frame is made, for the same reason `errorFrame()`
 * is one: an accepted command is announced in exactly one shape, and a frame
 * with no `reason` cannot be built by accident.
 */
export function stateFrame(
  playback: Playback,
  revision: number,
  by: string,
  reason: PlaybackReason,
): StateFrame {
  return { type: 'state', playback, revision, by, reason }
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
  | NudgeFrame
