/**
 * T65: one ASCII line per step, on stdout only. Stdout reaches the host log
 * even in the shipped build (`NODE_ENV=production`), so this is never behind
 * the sidecar's `dev` gate and never goes through `@libp2p/logger` (silent
 * without `DEBUG`). The sockets and datagrams of the UPnP module are its own
 * (`upnp.ts`), so a line says only what that file saw (AGENTS.md rule 10: ASCII).
 *
 * `t0` is when the attempt began; `ms=` is the elapsed time at the line.
 */
export function trace(t0: number, line: string): void {
  // The ASCII half of the rule is enforced here, not at each call site (T79):
  // a field the device supplies reached the line raw even after `oneLine()`
  // covered the fields T75 named (`location=`, the SSDP header verbatim). One
  // replace here means no call site can forget, and `oneLine()` stays what it
  // is - quotes and whitespace for the fields that need it.
  const ascii = line.replace(/[^\x20-\x7e]/g, '?')
  process.stdout.write(`discovery: ${ascii} ms=${Date.now() - t0}\n`)
}
