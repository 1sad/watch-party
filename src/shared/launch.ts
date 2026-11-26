/**
 * Where the window points when the app is started from a clicked invite link
 * (T2b). Windows hands the whole link — the app's `watchparty://join?h=…&p=…&c=…`
 * form or, since T193, the one plain `http://<host>:<port>/join?c=<code>` address
 * the screen prints (ADR-056) — to the host as one command-line argument; the
 * host appends it to the page's own URL as one percent-encoded `?join=` value and
 * reads nothing inside it.
 *
 * `h`, `p` and `c` belong to the join box (T3b, `join.ts`), which is why the
 * only question asked here is "is this argument an invite link at all".
 *
 * Pure, like the timing maths: no registry, no process, no window. Twin of
 * `host/WatchParty.Host/LaunchLink.cs`, the copy that runs in the window — the
 * same arrangement `port.ts` has with `PortLine.cs`, and this table is the one
 * `node --test` checks.
 */
export const INVITE_SCHEME = 'watchparty:'

/**
 * Absolute, and ours: an absolute `watchparty:` URI, or the plain invitation's
 * shape — an absolute `http:` URI whose path is `/join` and whose query starts
 * with `?c=`. Anything else — `--foo`, a path, plain text — is not. The code's
 * own shape is the join box's to read (T183), so this reads as little of the
 * plain address as it reads of `watchparty://`'s `h`/`p`/`c`.
 *
 * The two copies differ in one corner only: a link with broken percent escapes
 * (`watchparty://%zz`) is a URL to Node and not to .NET. Either answer is safe —
 * one drops the parameter, the other lets the join box refuse it (T3b) — and
 * neither crashes.
 */
export function isInviteLink(argument: string): boolean {
  try {
    const url = new URL(argument.trim())
    if (url.protocol === INVITE_SCHEME) return true

    // T193 / ADR-056: the one invitation the screen prints is the plain address,
    // so a window handed it on the command line opens on the room the same way a
    // watchparty:// link does (R57). The scheme is http only — the page's parser
    // refuses https — and the path and `?c=` prefix mirror LaunchLink.cs exactly.
    return (
      url.protocol === 'http:'
      && url.pathname === '/join'
      && url.search.startsWith('?c=')
    )
  } catch {
    return false
  }
}

/**
 * The page URL, with `?join=<encoded link>` when the app was launched by a
 * link. `baseUrl` has no query today; the separator is handled anyway so a
 * later one cannot silently produce two `?`.
 */
export function pageUrl(baseUrl: string, args: readonly string[]): string {
  const invite = args.map((argument) => argument.trim()).find(isInviteLink)
  if (invite === undefined) return baseUrl

  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}join=${encodeURIComponent(invite)}`
}
