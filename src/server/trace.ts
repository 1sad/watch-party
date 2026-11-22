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
  process.stdout.write(`discovery: ${line} ms=${Date.now() - t0}\n`)
}
