/**
 * Where the window points when the app is started from a clicked invite link
 * (T2b). Windows hands the whole `watchparty://join?h=…&p=…&c=…` link to the
 * host as one command-line argument; the host appends it to the page's own URL
 * as one percent-encoded `?join=` value and reads nothing inside it.
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
 * Absolute, and ours. Anything else — `--foo`, a path, plain text — is not.
 * The two copies differ in one corner only: a link with broken percent escapes
 * (`watchparty://%zz`) is a URL to Node and not to .NET. Either answer is safe —
 * one drops the parameter, the other lets the join box refuse it (T3b) — and
 * neither crashes.
 */
export function isInviteLink(argument: string): boolean {
  try {
    return new URL(argument.trim()).protocol === INVITE_SCHEME
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
