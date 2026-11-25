/**
 * T148 / ADR-033 rule 1: one person, one seat.
 *
 * The page's address carries the sidecar's port, and the sidecar picks a free
 * port each run, so an origin-scoped store (`localStorage`) is a different
 * person after every restart. A cookie is scoped to the **host**, not the port,
 * so the member id is kept there: the same profile, and the same app folder,
 * finds the same id on a second load and on a later run.
 *
 * The name rides beside the id in the same record. The authority keeps the name
 * a rejoin arrives with, so the page does not send it in `hello`; this is only
 * what the window itself remembers between runs.
 */

export const IDENTITY_COOKIE = 'wp_member'

/** A seat outlives a run of the app, so the cookie does too (a year). */
const MAX_AGE_S = 365 * 24 * 60 * 60

export interface MemberIdentity {
  /** §4.1's stable member id (`crypto.randomUUID`'s shape). */
  id: string
  /** The last name this window set, or `null` while it is `anonymous` (R26). */
  name: string | null
  /**
   * T165 / ADR-053: the proof the room issued this seat on its first join, kept
   * beside the id so the next load can prove the row instead of only quoting
   * its id. Absent in a record written before the proof existed, and on a first
   * load - `hello` then sends only the id, and the room issues a proof with the
   * `welcome` that seats it.
   */
  proof?: string
}

/**
 * A UUID v4-shaped id. `crypto.randomUUID` is missing outside a secure
 * context - a guest's page is served over plain http on a LAN address - but
 * `crypto.getRandomValues` is the one exception that is always there.
 */
export function mintMemberId(): string {
  const api = globalThis.crypto
  if (typeof api.randomUUID === 'function') return api.randomUUID()
  const bytes = api.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The stored record, or `null` when it is absent or unreadable. */
export function decodeIdentity(raw: string | null): MemberIdentity | null {
  if (raw === null || raw.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || id.trim().length === 0) return null
    const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : null
    // T165: the seat proof rides in the same record; a record from before it
    // existed simply has none, and the next `welcome` supplies one.
    const proof = typeof record.proof === 'string' && record.proof.length > 0 ? record.proof : undefined
    return proof === undefined ? { id, name } : { id, name, proof }
  } catch {
    return null
  }
}

/** What one cookie value holds; encoded so `;` and non-ASCII cannot split it. */
export function encodeIdentity(identity: MemberIdentity): string {
  return encodeURIComponent(JSON.stringify(identity))
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  for (const part of document.cookie.split(';')) {
    const equals = part.indexOf('=')
    if (equals === -1) continue
    if (part.slice(0, equals).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(equals + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function writeCookie(name: string, value: string, maxAgeS: number): void {
  if (typeof document === 'undefined') return
  // `value` is already `encodeIdentity()`'s output, so it holds no `;`, `=`,
  // space or non-ASCII of its own; encoding it again would make the record
  // unreadable on the next load (measured 2026-11-24, ticket 148).
  document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAgeS}; SameSite=Lax`
}

/**
 * This window's identity: the stored one, or a fresh id written where the next
 * load of the same profile will find it. The in-page copy answers a reconnect
 * (the socket is replaced, the page is not) even when cookies are refused.
 */
let remembered: MemberIdentity | null = null

export function memberIdentity(): MemberIdentity {
  if (remembered !== null) return remembered
  const stored = decodeIdentity(readCookie(IDENTITY_COOKIE))
  const identity = stored ?? { id: mintMemberId(), name: null }
  remembered = identity
  if (stored === null) writeCookie(IDENTITY_COOKIE, encodeIdentity(identity), MAX_AGE_S)
  return identity
}

/** Keeps the name beside the id whenever this window sets one. */
export function rememberMemberName(name: string | null): MemberIdentity {
  const identity = { ...memberIdentity(), name }
  remembered = identity
  writeCookie(IDENTITY_COOKIE, encodeIdentity(identity), MAX_AGE_S)
  return identity
}

/**
 * T165 / ADR-053: keeps the proof the room issued this seat, so the next load
 * of the same profile can present it instead of only quoting its id. The page
 * gets it in its own `welcome`; it is written only when it changes, so a
 * reconnect that re-seats the row does not rewrite the cookie for nothing.
 */
export function rememberSeatProof(proof: string | null): MemberIdentity {
  const identity = memberIdentity()
  if ((identity.proof ?? null) === proof) return identity
  const updated: MemberIdentity =
    proof === null ? { id: identity.id, name: identity.name } : { ...identity, proof }
  remembered = updated
  writeCookie(IDENTITY_COOKIE, encodeIdentity(updated), MAX_AGE_S)
  return updated
}
