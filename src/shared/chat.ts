/**
 * §4.6's chat limits, in one module. The sidecar enforces them (T4) and the page
 * (T4b) reads the same numbers instead of re-declaring them.
 *
 * Everything here is pure: the clock is passed in, so the limiter can be tested
 * without waiting and two members in the same millisecond stay reproducible.
 */

import type { ChatMessage, ChatRefusalCode } from './protocol.ts'

/** §4.6: one pasted wall of text cannot be a single message. */
export const CHAT_MAX_CHARS = 2000
/** §4.6: 5 messages per 10 s per member, then a warning and a mute. */
export const CHAT_RATE_LIMIT = 5
export const CHAT_RATE_WINDOW_MS = 10_000
export const CHAT_MUTE_MS = 10_000
/** §4.6: the rate limit alone permits 10 000 characters in a 10 s window. */
export const CHAT_BYTES_PER_MINUTE = 32 * 1024
export const CHAT_BYTES_WINDOW_MS = 60_000
/** §4.6: the ring buffer, sent to a late joiner as `chatTail`. */
export const CHAT_BUFFER_SIZE = 100

/** One member's use of the room's chat, in server milliseconds. */
export interface ChatBudget {
  /** When each accepted message arrived, inside the rate window. */
  accepted: number[]
  /** Size and arrival of each accepted message, inside the bytes window. */
  bytes: Array<{ ts: number; bytes: number }>
  /** No message is accepted at or before this instant. */
  mutedUntil: number
}

export function newChatBudget(): ChatBudget {
  return { accepted: [], bytes: [], mutedUntil: 0 }
}

export type ChatVerdict =
  | { ok: true }
  /** `muted` is true exactly when this refusal started the mute, so the
   *  warning is said once and the error frame is said every time. */
  | { ok: false; code: ChatRefusalCode; muted: boolean }

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Decides one message and records it when accepted. The order of the checks is
 * the order §4.6 lists them: a mute outranks everything, then one message's
 * length, then the minute's bytes, then the burst rate.
 */
export function admitChat(budget: ChatBudget, text: string, now: number): ChatVerdict {
  budget.accepted = budget.accepted.filter((at) => at > now - CHAT_RATE_WINDOW_MS)
  budget.bytes = budget.bytes.filter((entry) => entry.ts > now - CHAT_BYTES_WINDOW_MS)

  if (budget.mutedUntil > now) return { ok: false, code: 'chat_rate_limited', muted: false }
  if (text.length > CHAT_MAX_CHARS) return { ok: false, code: 'chat_too_long', muted: false }

  const bytes = utf8Length(text)
  const used = budget.bytes.reduce((total, entry) => total + entry.bytes, 0)
  if (used + bytes > CHAT_BYTES_PER_MINUTE) {
    return { ok: false, code: 'chat_byte_limit', muted: false }
  }

  if (budget.accepted.length >= CHAT_RATE_LIMIT) {
    budget.mutedUntil = now + CHAT_MUTE_MS
    return { ok: false, code: 'chat_rate_limited', muted: true }
  }

  budget.accepted.push(now)
  budget.bytes.push({ ts: now, bytes })
  return { ok: true }
}

/**
 * Appends to the ring buffer in place and drops whatever fell out of the front.
 * The buffer is the only chat history there is (§4.6: no paging in v1).
 */
export function pushChat(buffer: ChatMessage[], message: ChatMessage): ChatMessage {
  buffer.push(message)
  if (buffer.length > CHAT_BUFFER_SIZE) buffer.splice(0, buffer.length - CHAT_BUFFER_SIZE)
  return message
}

/** §4.6's "seeked to 12:34": whole minutes, seconds zero-padded. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
