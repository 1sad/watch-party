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
  | 'stale_host'
  | ChatRefusalCode

/** One sentence per code, shown as written (§5: "a refusal is explicit"). */
export const ERROR_SENTENCES: Record<ErrorCode, string> = {
  bad_room: 'That room code does not match this room.',
  room_full: 'This room is full — five people is the limit.',
  not_controller: 'Only the person who started the room can change this.',
  bad_media: 'That file cannot be played — it is missing from this machine, or its path is not absolute.',
  unsupported_media: 'File mode plays MP4, M4V, WebM and MOV files only.',
  stale_host: 'This window is out of date — it no longer leads the room, so its pick was not used.',
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
 *
 * §5's rule for every authority-bearing frame: it carries the epoch the sender
 * holds, and a stale one is refused rather than applied (§4.3 invariant 6).
 */
export interface SetMediaFrame {
  type: 'setMedia'
  id: string
  title: string
  duration: number
  path: string
  epoch: number
}

/**
 * m→a: the room's page (R21, §5). **Staged, not applied** (ADR-032): the
 * authority holds it for its own window, sends it to nobody, and either
 * `cancelPage` clears it or `pageCommitted` announces it.
 *
 * `stageMs` is §5's field and is the sender's suggestion only. The authority
 * owns the window (`PAGE_STAGE_MS` in `room.ts`), because a client that could
 * shorten it — or a slow one that could stretch it — would own the undo.
 * `epoch` is §5's rule for authority-bearing frames (§4.3 invariant 6).
 */
export interface SetPageFrame {
  type: 'setPage'
  page: string
  stageMs?: number
  epoch: number
}

/**
 * m→a: cancels the sender's own pending page (§5). "Nobody else ever hears of
 * it" is the whole point of the window: no frame, no chat line, no flicker.
 */
export interface CancelPageFrame {
  type: 'cancelPage'
  epoch: number
}

/**
 * a→m: the staged page is now the room's (§5, ADR-032). Every window navigates,
 * and the room's playback is at position 0, paused — a new page is a new film.
 * `by` is the member who staged it; `at` is the authority's commit instant.
 */
export interface PageCommittedFrame {
  type: 'pageCommitted'
  page: string
  by: string
  at: number
}

/** The single place a `pageCommitted` is made, for the reason `stateFrame()` is one. */
export function pageCommittedFrame(page: string, by: string, at: number): PageCommittedFrame {
  return { type: 'pageCommitted', page, by, at }
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
  | SetPageFrame
  | CancelPageFrame
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

/**
 * a→m: the room's one file changed (T9a3). `welcome`'s snapshot already carries
 * `media`; this is the same field for a window that was **already** in the room
 * when the owner picked, because §5 has no other frame that moves it and a
 * window that is never told cannot play the file.
 */
export interface MediaFrame {
  type: 'media'
  media: Media | null
}

export interface MembersFrame {
  type: 'members'
  members: WireMember[]
}

/**
 * §14/§7.2/ADR-024: a file room ends when its owner's app does, because the only
 * copy of the bytes is in that app. The authority says so on the way out, so a
 * window that is still here is told plainly and never left to guess (T9b).
 *
 * The sentence is one constant because the authority posts it as a system line
 * and a page whose authority went with its process states the same fact itself;
 * two copies would let the overlay and the chat disagree.
 */
export const ROOM_OVER_SENTENCE = 'The room ended because its owner left.'

export interface RoomOverFrame {
  type: 'roomOver'
  /** The one reason M1 has: the owner's app is gone, so the room is over. */
  reason: 'owner_left'
}

/**
 * Why a `state` was sent (§5, §6.4): `applyCommand` in `room.ts` picks one, and
 * a play that settles a beat is `play` with the beat in `Playback.startAt`;
 * nothing sends `start`. `join` stays vocabulary until the authority needs to
 * align a joiner with more than the `welcome` snapshot: on load the snapshot is
 * the alignment (§4.3 invariant 9), and a joiner's arrival must broadcast no
 * `state` at all (T6b's Safety line).
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
  | MediaFrame
  | PageCommittedFrame
  | StateFrame
  | RoomOverFrame
  | ErrorFrame
  | WarningFrame
  | ChatFrame
  | PongFrame
  | NudgeFrame
