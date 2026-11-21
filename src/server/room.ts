import { isAbsolute } from 'node:path'

import type {
  ChatMessage,
  CommandFrame,
  ErrorCode,
  Media,
  Member,
  Playback,
  PlaybackReason,
  RoomSnapshot,
  WireMember,
} from '../shared/protocol.ts'
import { ANONYMOUS, displayNames } from '../shared/names.ts'
import { pushChat } from '../shared/chat.ts'
import { contentTypeFor } from '../shared/media.ts'
import { expected, scheduledStartAt, seekIsDuplicate } from '../shared/timing.ts'

/** §12: five people is a constraint of the design, not a setting. */
export const MAX_MEMBERS = 5

/**
 * §4.2's file half plus the one fact that stays in this process: the absolute
 * path the sidecar streams from. `snapshot()` strips it (T9a1's Safety line).
 */
export type RoomMedia = Media & { path: string }

/** §4.1, in memory, owned by the sidecar (ADR-034: the host learns nothing). */
export interface RoomState {
  code: string
  createdAt: number
  /** The window's own member; `null` until it joins. A guest can never be it. */
  owner: string | null
  authority: { memberId: string; epoch: number }
  /** Always `[owner]` in M1 (phase slice §5); grants are T33. */
  controllers: string[]
  page: string | null
  media: RoomMedia | null
  playback: Playback
  /** Monotonic on every mutation (§4.3 invariant 2). */
  revision: number
  members: Map<string, Member>
  chat: ChatMessage[]
  /** Monotonic across the room's chat, so ids sort the way arrival ordered them. */
  chatSeq: number
}

export function createRoom(code: string, now: () => number = Date.now): RoomState {
  return {
    code,
    createdAt: now(),
    owner: null,
    authority: { memberId: '', epoch: 0 },
    controllers: [],
    page: null,
    media: null,
    playback: { playing: false, position: 0, updatedAt: now(), rate: 1 },
    revision: 0,
    members: new Map(),
    chat: [],
    chatSeq: 0,
  }
}

export type JoinResult = { ok: true; member: Member } | { ok: false; code: ErrorCode }

/**
 * Adds the member, and settles the owner seat the first time the window's own
 * page arrives. A connection from a guest can never take it: control is the
 * owner's alone in M1 (ADR-030, phase slice §5), so `controllers` is only ever
 * `[owner]`.
 */
export function joinRoom(
  room: RoomState,
  member: Member,
  options: { isLocal: boolean },
): JoinResult {
  if (room.members.size >= MAX_MEMBERS) return { ok: false, code: 'room_full' }

  room.members.set(member.id, member)
  if (room.owner === null && options.isLocal) {
    room.owner = member.id
    room.authority = { memberId: member.id, epoch: room.authority.epoch }
    room.controllers = [member.id]
  }
  room.revision += 1
  return { ok: true, member }
}

export function renameMember(
  room: RoomState,
  memberId: string,
  name: string | null,
  now: () => number = Date.now,
): boolean {
  const member = room.members.get(memberId)
  if (member === undefined) return false
  member.name = name
  member.lastSeen = now()
  room.revision += 1
  return true
}

/** The one file a `setMedia` frame asks the room to hold. */
export interface MediaRegistration {
  id: string
  title: string
  duration: number
  /** Absolute, on the owner's own disk; the sidecar streams it, nobody else sees it. */
  path: string
}

export type SetMediaResult = { ok: true } | { ok: false; code: ErrorCode }

/**
 * §7.2 file mode: the owner picks one file, the room remembers it, and `page`
 * is cleared because the two kinds of media never coexist (§4.2).
 *
 * Every refusal returns before the first assignment, so `room.media`,
 * `room.page` and `revision` are untouched — the same rule `applyCommand()`
 * keeps, for the same reason (T9a1's Safety line). `pathExists` is injected so
 * this module keeps its one dependency rule: the caller owns the filesystem.
 */
export function setMedia(
  room: RoomState,
  memberId: string,
  file: MediaRegistration,
  pathExists: (path: string) => boolean,
): SetMediaResult {
  if (!room.controllers.includes(memberId)) return { ok: false, code: 'not_controller' }

  // ADR-035's map decides playability here, once; `/media/<id>` serves the
  // content type this line stored rather than deriving a second answer.
  const contentType = contentTypeFor(file.path)
  if (contentType === null) return { ok: false, code: 'unsupported_media' }
  if (!isAbsolute(file.path)) return { ok: false, code: 'bad_media' }
  if (!pathExists(file.path)) return { ok: false, code: 'bad_media' }

  room.media = {
    kind: 'file',
    id: file.id,
    title: file.title,
    duration: file.duration,
    contentType,
    path: file.path,
  }
  room.page = null
  room.revision += 1
  return { ok: true }
}

/** Presence follows the socket (§4.4): a closed socket is `offline`, not gone. */
export function markOffline(
  room: RoomState,
  memberId: string,
  now: () => number = Date.now,
): boolean {
  const member = room.members.get(memberId)
  if (member === undefined) return false
  member.status = 'offline'
  member.lastSeen = now()
  room.revision += 1
  return true
}

/**
 * §4.4's last line, and ADR-024's file half: "a replica held by an app that has
 * not noticed its peers left is discarded when its last connection fails; there
 * is no timer and nothing to clean up." A file room is over when its owner
 * leaves, so everything it held — the file's path, the members, the chat — is
 * dropped here rather than kept as a tombstone (T9b check 3).
 *
 * `owner` is `null` afterwards, which is also what makes the room unusable if
 * anything still held a reference: no owner means nobody may pick or control.
 */
export function discardRoom(room: RoomState, now: () => number = Date.now): void {
  room.owner = null
  room.authority = { memberId: '', epoch: room.authority.epoch }
  room.controllers = []
  room.page = null
  room.media = null
  room.playback = { playing: false, position: 0, updatedAt: now(), rate: 1 }
  room.members.clear()
  room.chat = []
  room.revision += 1
}

export type CommandOutcome =
  | {
      ok: true
      applied: true
      reason: PlaybackReason
      /** §6.4: the instant a play settled on, fixed at this press and never recomputed. */
      startAt?: number
      /** The largest `rtt` known to the authority at that press (the `report` input). */
      maxRtt?: number
      /** `startAt − press`, for the log line that shows floor vs RTT. */
      leadMs?: number
    }
  /** Accepted as a command, but it changed nothing: §5's idempotency rule. */
  | { ok: true; applied: false }
  | { ok: false; code: ErrorCode }

/**
 * `play`, `pause`, `seek`: the room actions of §4.3 invariant 11 and ADR-030,
 * and the **only** writer of `playback` (§4.3 invariant 1, T6a's Safety line).
 *
 * The guard below is the only place that asks whether a member holds control.
 * A refusal returns before anything is assigned, so `revision` cannot move —
 * that is the Safety line of T3, in one line per mutation.
 *
 * §5's idempotency rule lives here too, because it is a fact about the room,
 * not about a socket: a `play` while playing, a `pause` while paused, or a
 * `seek` that lands within `SEEK_SKIP_SECONDS` of the expected position is the
 * second arrival of something that already happened. It is reported as
 * `applied: false` so the caller broadcasts nothing and `revision` stays put —
 * that is what removes the "local fire + broadcast fire" double apply. The
 * thresholds are in `timing.ts`, beside `expected()`.
 */
export function applyCommand(
  room: RoomState,
  memberId: string,
  frame: CommandFrame,
  now: () => number = Date.now,
): CommandOutcome {
  if (!room.controllers.includes(memberId)) return { ok: false, code: 'not_controller' }

  const at = now()
  const reported = frame.position
  // No usable position is not "0": the room's own expectation is the playhead
  // the sender was looking at, and it comes from the one function that owns it.
  const target =
    typeof reported === 'number' && Number.isFinite(reported)
      ? reported
      : expected(room.playback, at)

  if (frame.type === 'play' && room.playback.playing) return { ok: true, applied: false }
  if (frame.type === 'pause' && !room.playback.playing) return { ok: true, applied: false }
  if (frame.type === 'seek' && seekIsDuplicate(room.playback, at, target)) {
    return { ok: true, applied: false }
  }

  // §6.4: the beat is decided *here*, at the press, from the RTTs known at this
  // instant. Nothing after this line — a join, a report, a reconnect — may
  // recompute it; the value is stored in `playback.startAt` and travels with
  // every `state` and `welcome` from now on.
  const maxRtt = Math.max(0, ...[...room.members.values()].map((member) => member.rtt))
  const startAt = scheduledStartAt(at, maxRtt)

  if (frame.type === 'play') {
    room.playback.playing = true
    room.playback.position = target
  } else if (frame.type === 'pause') {
    room.playback.playing = false
    room.playback.position = target
  } else {
    room.playback.playing = frame.wasPlaying === true
    room.playback.position = target
  }

  if (room.playback.playing) {
    // §5: `position` is valid at `updatedAt`. During the lead the playhead has
    // not moved, so `updatedAt` is the beat itself; `expected()` holds the
    // pressed position until that instant and advances from it afterwards.
    room.playback.updatedAt = startAt
    room.playback.startAt = startAt
    room.revision += 1
    return {
      ok: true,
      applied: true,
      reason: frame.type,
      startAt,
      maxRtt,
      leadMs: startAt - at,
    }
  }

  room.playback.updatedAt = at
  delete room.playback.startAt
  room.revision += 1
  return { ok: true, applied: true, reason: frame.type }
}

/** The `room` half of `welcome` (§5): everything but members and chat. */
export function snapshot(room: RoomState): RoomSnapshot {
  return {
    code: room.code,
    createdAt: room.createdAt,
    owner: room.owner,
    authority: room.authority,
    controllers: room.controllers,
    page: room.page,
    media: room.media === null ? null : wireMedia(room.media),
    playback: room.playback,
    revision: room.revision,
  }
}

/**
 * Explicit field by field, not a spread minus `path`: a field added to the
 * room's media later must be a deliberate wire change, never an accidental
 * leak of where the owner's file lives.
 */
function wireMedia(media: RoomMedia): Media {
  return {
    kind: media.kind,
    id: media.id,
    title: media.title,
    duration: media.duration,
    contentType: media.contentType,
  }
}

/** Members in join order, each with the label the roster shows (§4.1, names.ts). */
export function wireMembers(room: RoomState): WireMember[] {
  const members = [...room.members.values()].sort(
    (left, right) => left.joinedAt - right.joinedAt || (left.id < right.id ? -1 : 1),
  )
  const labels = displayNames(members)
  return members.map((member) => ({ ...member, displayName: labels.get(member.id) ?? '' }))
}

/** The label this member's row shows, for a system sentence (§4.6, names.ts). */
export function displayNameOf(room: RoomState, memberId: string): string {
  if (!room.members.has(memberId)) return ANONYMOUS
  return displayNames([...room.members.values()]).get(memberId) ?? ANONYMOUS
}

export interface ChatEntry {
  kind: ChatMessage['kind']
  memberId?: string
  /** The display name at send time, already resolved by the caller. */
  name: string
  text: string
}

/**
 * §4.6: the id and the timestamp are the authority's, so a client cannot
 * backdate a message, and the buffer keeps only the last 100.
 */
export function postChat(
  room: RoomState,
  entry: ChatEntry,
  now: () => number = Date.now,
): ChatMessage {
  room.chatSeq += 1
  const message: ChatMessage = {
    id: `m${String(room.chatSeq).padStart(6, '0')}`,
    kind: entry.kind,
    ...(entry.memberId === undefined ? {} : { memberId: entry.memberId }),
    name: entry.name,
    text: entry.text,
    ts: now(),
  }
  return pushChat(room.chat, message)
}

/** The three sentences M1 has: joined, left, seeked (§4.6's list, no user input). */
export function postSystemChat(
  room: RoomState,
  memberId: string,
  sentence: (label: string) => string,
  now: () => number = Date.now,
): ChatMessage {
  const label = displayNameOf(room, memberId)
  return postChat(room, { kind: 'system', name: label, text: sentence(label) }, now)
}
