import { execFile } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'

import { pmpNat, upnpNat } from '@achingbrain/nat-port-mapper'
import type { Gateway } from '@achingbrain/nat-port-mapper'

const execFileAsync = promisify(execFile)

// T2: one port-mapping attempt at start, then one honest sentence. Discovery
// never throws: every failure is a value the page renders (spec §14).
export const DISCOVERY_TIMEOUT_MS = 8_000

export type DiscoveryKind = 'ok' | 'cgnat' | 'upnp_unavailable' | 'timeout'
export type AddressClass = 'public' | 'private' | 'cgnat' | 'unknown'

export interface DiscoveryResult {
  kind: DiscoveryKind
  /** What the router said its own address is; absent when nothing was mapped. */
  externalIp?: string
  /** The port a guest dials, when a mapping exists. */
  mappedPort: number | null
  localPort: number
  detail: string
  addressClass: AddressClass
  /** The plain sentence the start screen shows for this state (spec §14). */
  sentence: string
}

export type MappingOutcome =
  | { type: 'mapped'; externalIp: string; mappedPort: number; detail: string }
  | { type: 'refused'; detail: string }
  | { type: 'timeout'; detail: string }

/**
 * The verdict is decided by the address's own class, never by a third-party
 * lookup (ADR-023). E1's router reported `10.0.33.122` as its "public"
 * address; that class is the whole diagnosis.
 */
export function classifyAddress(ip: string): AddressClass {
  if (!isIPv4(ip)) return 'unknown'

  const [a, b] = ip.split('.').map(Number)

  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'

  // Not routable from a friend's network either, but not a shared public
  // address: there is nothing useful to say, so it stays unclassified.
  if (a === 0 || a === 127 || a >= 224) return 'unknown'
  if (a === 169 && b === 254) return 'unknown'

  return 'public'
}

export function classifyMapping(outcome: MappingOutcome): {
  kind: DiscoveryKind
  addressClass: AddressClass
} {
  if (outcome.type === 'refused') return { kind: 'upnp_unavailable', addressClass: 'unknown' }
  if (outcome.type === 'timeout') return { kind: 'timeout', addressClass: 'unknown' }

  const addressClass = classifyAddress(outcome.externalIp)
  // A private or carrier-grade address means the provider is between us and
  // the world: mapping may succeed, but nobody outside can dial it.
  return { kind: addressClass === 'public' ? 'ok' : 'cgnat', addressClass }
}

/** The one plain sentence per state (spec §14, T2 item 7). No jargon. */
export function sentenceFor(kind: DiscoveryKind): string {
  switch (kind) {
    case 'ok':
      return 'This connection can accept visitors. Share the invite link with your friends.'
    case 'cgnat':
      return 'This connection cannot accept visitors — your provider shares your address. Everyone on the same network can still join using the local link below.'
    case 'upnp_unavailable':
      return 'Your router did not open a port. Look for "UPnP" (or "NAT-PMP") in the router settings and turn it on, then try again. Everyone on the same network can still join using the local link below.'
    case 'timeout':
      return 'Your router did not answer within 8 seconds. Check that UPnP is turned on in the router settings, then try again. Everyone on the same network can still join using the local link below.'
  }
}

/**
 * The address a guest on the same network dials. Tailscale-style virtual
 * interfaces also report 100.64/10, so an ordinary private address wins.
 */
export function findLanIp(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  const candidates: string[] = []
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      candidates.push(address.address)
    }
  }

  const rank = (ip: string): number => {
    const [a, b] = ip.split('.').map(Number)
    if (a === 192 && b === 168) return 0
    if (classifyAddress(ip) === 'private') return 1
    if (classifyAddress(ip) === 'cgnat') return 2
    return 3
  }

  candidates.sort((left, right) => rank(left) - rank(right))
  return candidates[0] ?? null
}

export interface DiscoverOptions {
  localPort: number
  lanIp: string | null
  timeoutMs?: number
  /** False is the deliberate-disabled path used to prove the safety claim. */
  map?: boolean
}

/** One attempt. Never throws; every ending is a `DiscoveryResult`. */
export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS

  if (options.map === false) {
    return toResult({ type: 'refused', detail: 'port mapping is disabled (WATCHPARTY_NO_MAP)' }, options)
  }

  if (options.lanIp === null) {
    return toResult({ type: 'refused', detail: 'no local network address to map' }, options)
  }

  let outcome: MappingOutcome
  try {
    outcome = await mapPort(options.localPort, options.lanIp, timeoutMs)
  } catch (error) {
    // mapPort catches everything it knows about; this is the last belt.
    outcome = { type: 'refused', detail: messageOf(error) }
  }
  return toResult(outcome, options)
}

function toResult(outcome: MappingOutcome, options: DiscoverOptions): DiscoveryResult {
  const { kind, addressClass } = classifyMapping(outcome)
  const result: DiscoveryResult = {
    kind,
    mappedPort: outcome.type === 'mapped' ? outcome.mappedPort : null,
    localPort: options.localPort,
    detail: outcome.detail,
    addressClass,
    sentence: sentenceFor(kind),
  }
  if (outcome.type === 'mapped') result.externalIp = outcome.externalIp
  return result
}

// A successful mapping must outlive this call: stopping the gateway unmaps the
// port. The router's own lease (one hour) is the cleanup if the app is killed.
let activeGateway: Gateway | null = null

const NAT_PMP_BUDGET_MS = 2_500

/**
 * One mapping attempt, two ways in. NAT-PMP first because Windows' own SSDP
 * service owns UDP 1900, which is where the UPnP client must bind; NAT-PMP
 * needs no discovery and E1's router answers it. UPnP is still tried, because
 * many routers only speak it.
 */
async function mapPort(localPort: number, lanIp: string, timeoutMs: number): Promise<MappingOutcome> {
  const deadline = Date.now() + timeoutMs
  const attempts: string[] = []
  let sawTimeout = false

  const gatewayIp = await findDefaultGateway()
  if (gatewayIp !== null) {
    const budget = Math.min(NAT_PMP_BUDGET_MS, deadline - Date.now())
    if (budget > 0) {
      const pmp = await mapWithNatPmp(localPort, lanIp, gatewayIp, budget)
      if (pmp.type === 'mapped') return pmp
      sawTimeout = sawTimeout || pmp.type === 'timeout'
      attempts.push(`NAT-PMP: ${pmp.detail}`)
    }
  } else {
    attempts.push('NAT-PMP: no default gateway found')
  }

  const remaining = deadline - Date.now()
  if (remaining > 0) {
    const upnp = await mapWithUpnp(localPort, lanIp, remaining)
    if (upnp.type === 'mapped') return upnp
    sawTimeout = sawTimeout || upnp.type === 'timeout'
    attempts.push(`UPnP: ${upnp.detail}`)
  }

  if (sawTimeout && Date.now() >= deadline - 100) {
    return { type: 'timeout', detail: `no answer within ${Math.round(timeoutMs / 1000)} seconds` }
  }
  return { type: 'refused', detail: attempts.join('; ') }
}

async function mapWithNatPmp(
  localPort: number,
  lanIp: string,
  gatewayIp: string,
  timeoutMs: number,
): Promise<MappingOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const gateway = pmpNat(gatewayIp)
  let keepMapping = false

  try {
    const mapping = await gateway.map(localPort, lanIp, {
      protocol: 'tcp',
      description: 'Watch Party',
      signal: controller.signal,
    })
    const externalIp = (await gateway.externalIp({ signal: controller.signal })).trim()

    if (!isIPv4(externalIp)) {
      return { type: 'refused', detail: `router reported a non-IPv4 address: ${externalIp}` }
    }

    keepMapping = true
    activeGateway = gateway
    return {
      type: 'mapped',
      externalIp,
      mappedPort: mapping.externalPort,
      detail: `router reported ${externalIp} (${classifyAddress(externalIp)})`,
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return { type: 'timeout', detail: `NAT-PMP did not answer within ${Math.round(timeoutMs / 1000)} seconds` }
    }
    return { type: 'refused', detail: messageOf(error) }
  } finally {
    clearTimeout(timer)
    if (!keepMapping) {
      // Fire and forget: some gateways never settle this, and a failed
      // mapping has nothing to wait for.
      void gateway.stop().catch(() => {})
    }
  }
}

async function mapWithUpnp(localPort: number, lanIp: string, timeoutMs: number): Promise<MappingOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const client = upnpNat()
  let gateway: Gateway | null = null
  let keepMapping = false

  try {
    for await (const found of client.findGateways({ signal: controller.signal })) {
      gateway = found
      const mapping = await found.map(localPort, lanIp, {
        protocol: 'tcp',
        description: 'Watch Party',
        signal: controller.signal,
      })
      const externalIp = (await found.externalIp({ signal: controller.signal })).trim()

      if (!isIPv4(externalIp)) {
        return { type: 'refused', detail: `router reported a non-IPv4 address: ${externalIp}` }
      }

      keepMapping = true
      activeGateway = found
      return {
        type: 'mapped',
        externalIp,
        mappedPort: mapping.externalPort,
        detail: `router reported ${externalIp} (${classifyAddress(externalIp)})`,
      }
    }
    return { type: 'refused', detail: 'no router answered UPnP' }
  } catch (error) {
    if (controller.signal.aborted) {
      return { type: 'timeout', detail: `UPnP did not answer within ${Math.round(timeoutMs / 1000)} seconds` }
    }
    return { type: 'refused', detail: messageOf(error) }
  } finally {
    clearTimeout(timer)
    if (!keepMapping && gateway !== null) {
      void gateway.stop().catch(() => {})
    }
  }
}

/** The default IPv4 route's gateway, from Windows' own table (no dependency). */
export async function findDefaultGateway(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('route', ['print', '-4'], { timeout: 3_000, windowsHide: true })
    for (const line of stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length >= 4 && columns[0] === '0.0.0.0' && columns[1] === '0.0.0.0' && isIPv4(columns[2])) {
        return columns[2]
      }
    }
  } catch {
    // A missing route command just means no NAT-PMP attempt.
  }
  return null
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}
