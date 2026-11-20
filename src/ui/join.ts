/**
 * What a person pastes into the join box, and where it points (T3b item 1).
 *
 * The start screen shows two forms of the same link, so both are accepted
 * (`spec.md` §5, R26):
 *
 *   watchparty://join?h=<host>&p=<port>&c=<code>   the Copy button's form
 *   http://<host>:<port>/join?c=<code>             the raw fallback
 *
 * Pure, like the timing maths: no DOM, no socket, so `node --test` can check it.
 * Nothing here decides whether the room exists — that is the other sidecar's
 * answer, which arrives as an `error` frame.
 */
import { isRoomCode } from '../shared/room-code.ts'

export interface JoinTarget {
  host: string
  port: number
  code: string
  /** The host's one listener: the socket lives beside the page it serves (§5). */
  socketUrl: string
}

/** One refusal, one place (T2's rule): the box cannot read what was pasted. */
export const UNREADABLE_LINK = 'That does not look like a Watch Party link.'

/** The link is well-formed but nothing answered on that address. */
export const UNREACHABLE_ROOM = 'Could not reach that room.'

/** IPv4 or a DNS name; the invite links never carry anything else. */
const HOST_PATTERN = /^[A-Za-z0-9.-]+$/

export function parseJoinLink(raw: string): JoinTarget | null {
  const text = raw.trim()
  if (text.length === 0) return null

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }

  if (url.protocol !== 'watchparty:' && url.protocol !== 'http:') return null
  const custom = url.protocol === 'watchparty:'

  // The custom form keeps host and port in `h`/`p`; the HTTP form has them in
  // the address itself, with `c` as the query.
  const host = (url.searchParams.get('h') ?? (custom ? '' : url.hostname)).trim()
  const portText = url.searchParams.get('p') ?? (custom ? '' : url.port)
  const code = (url.searchParams.get('c') ?? '').trim().toUpperCase()

  if (!HOST_PATTERN.test(host)) return null
  if (!isRoomCode(code)) return null

  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  return { host, port, code, socketUrl: `ws://${host}:${port}/` }
}
