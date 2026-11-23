import { execFile } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'

import { pmpNat } from '@achingbrain/nat-port-mapper'
import type { Gateway } from '@achingbrain/nat-port-mapper'

import { trace } from './trace.ts'
import { mapPort as mapThroughUpnp, oneLine, searchGateways } from './upnp.ts'
import type { SoapResult, UpnpGateway, UpnpMapping } from './upnp.ts'

const execFileAsync = promisify(execFile)

// T2: one port-mapping attempt at start, then one honest sentence. Discovery
// never throws: every failure is a value the page renders (spec §14).
export const DISCOVERY_TIMEOUT_MS = 8_000

export type DiscoveryKind = 'ok' | 'cgnat' | 'upnp_unavailable' | 'no_gateway' | 'timeout'
export type AddressClass = 'public' | 'private' | 'cgnat' | 'unknown'

export interface DiscoveryResult {
  kind: DiscoveryKind
  /** What the router said its own address is; absent when nothing was mapped. */
  externalIp?: string
  /** The port a guest dials, when a mapping exists. */
  mappedPort: number | null
  localPort: number
  /** For humans: the arms' own words and the gateway, never parsed for facts. */
  detail: string
  addressClass: AddressClass
  /** The router's own refusal code (UPnP SOAP errorCode or NAT-PMP result code); null when none arrived. */
  faultCode: number | null
  /** The gateway's LAN address, when the route table or the NAT-PMP list named one. */
  gatewayIp: string | null
  /** The steps that produced no answer at all; empty when something answered. */
  silent: string[]
  /** True when the run deliberately skipped mapping (WATCHPARTY_NO_MAP). */
  mappingDisabled: boolean
  /** The plain sentence the start screen shows for this state (spec §14). */
  sentence: string
}

export type MappingOutcome =
  | { type: 'mapped'; externalIp: string; mappedPort: number; detail: string }
  | { type: 'refused'; detail: string; faultCode?: number | null }
  | { type: 'silent'; detail: string }
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
  // Every arm stayed silent before the budget was spent: no gateway answered.
  // `timeout` is reserved for a run that actually used the whole budget.
  if (outcome.type === 'silent') return { kind: 'no_gateway', addressClass: 'unknown' }
  if (outcome.type === 'timeout') return { kind: 'timeout', addressClass: 'unknown' }

  const addressClass = classifyAddress(outcome.externalIp)
  // A private or carrier-grade address means the provider is between us and
  // the world: mapping may succeed, but nobody outside can dial it.
  return { kind: addressClass === 'public' ? 'ok' : 'cgnat', addressClass }
}

/** The facts a sentence is built from; never its English `detail`. */
export type SentenceFacts = Pick<DiscoveryResult, 'kind' | 'faultCode' | 'externalIp' | 'mappingDisabled'>

/**
 * One plain sentence per reason (spec §14, T2 item 7, T67, T73). Four distinct
 * endings: no router answered; the router answered and refused, with its own
 * code; a mapping was made but the address it reports is itself private or
 * shared (ADR-023's CGNAT case); and a public address, which is the only one
 * that gets no warning. The code, the address and the reason are fields, so
 * nothing is guessed from `detail` here.
 */
export function sentenceFor(facts: SentenceFacts): string {
  const sameNetwork = 'Everyone on the same network can join with the link above'
  const manual = `, or you can open the port yourself with the steps below.`

  switch (facts.kind) {
    case 'ok':
      return 'This connection can accept visitors. Share the invite link with your friends.'
    case 'cgnat':
      return `The port was opened, but the address your router reports (${facts.externalIp ?? 'a private or shared one'}) is itself private or shared: your provider sits between you and the internet, so nothing on this computer can fix that. ${sameNetwork}; the steps below show the port to forward if you have a public address to forward it to.`
    case 'upnp_unavailable':
      if (facts.mappingDisabled) {
        return `Port mapping is turned off for this run (WATCHPARTY_NO_MAP), so no public address was made. ${sameNetwork}${manual}`
      }
      if (facts.faultCode !== null) {
        return `Your router answered and refused to open the port, with its own error code ${facts.faultCode}. Friends on other networks cannot join yet. ${sameNetwork}${manual}`
      }
      return `Your router did not open the port and gave no error code. Friends on other networks cannot join yet. ${sameNetwork}${manual}`
    case 'no_gateway':
    case 'timeout':
      return `No router answered: neither way of asking produced a reply. Friends on other networks cannot join yet. ${sameNetwork}${manual}`
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
  /**
   * T66b seams. The real ones are the machine's route table and the app's own
   * SSDP search; a test supplies an empty list and a fake router so the UPnP
   * arm is exercised without touching a network.
   */
  natPmpGateways?: string[]
  upnpSearch?: (options: { timeoutMs: number; t0: number }) => Promise<UpnpGateway[]>
}

interface AttemptStep {
  outcome: MappingOutcome
  /** The steps that produced no answer, named for the final `verdict=` line. */
  silent: string[]
}

/** One attempt. Never throws; every ending is a `DiscoveryResult`. */
export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const t0 = Date.now()
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS
  trace(t0, `start local_port=${options.localPort} lan_ip=${options.lanIp ?? 'none'} budget_ms=${timeoutMs}`)

  // A retry re-maps the port: the previous mapping must not outlive the
  // attempt that made it (ADR-045).
  await releaseMapping()

  // The router's own LAN address is the page a person opens to forward a port
  // by hand, so it is looked up before the branches that skip mapping (T67).
  const gatewayIp = options.natPmpGateways !== undefined
    ? (options.natPmpGateways[0] ?? null)
    : await findDefaultGateway(t0)

  if (options.map === false) {
    trace(t0, 'map=disabled reason=WATCHPARTY_NO_MAP')
    return finish({ type: 'refused', detail: 'port mapping is disabled (WATCHPARTY_NO_MAP)' }, options, t0, [], gatewayIp)
  }

  if (options.lanIp === null) {
    trace(t0, 'map=skipped reason=no-lan-ip')
    return finish({ type: 'refused', detail: 'no local network address to map' }, options, t0, [], gatewayIp)
  }

  let step: AttemptStep
  try {
    step = await mapPort(options, timeoutMs, t0, gatewayIp)
  } catch (error) {
    // mapPort catches everything it knows about; this is the last belt.
    trace(t0, `map=error ${describeError(error)}`)
    step = { outcome: { type: 'refused', detail: messageOf(error) }, silent: ['unexpected'] }
  }
  return finish(step.outcome, options, t0, step.silent, gatewayIp)
}

function finish(
  outcome: MappingOutcome,
  options: DiscoverOptions,
  t0: number,
  silent: string[],
  gatewayIp: string | null,
): DiscoveryResult {
  const result = toResult(outcome, options, gatewayIp, silent)
  const mappedPort = result.mappedPort === null ? 'none' : String(result.mappedPort)
  const silentSteps = result.silent.length === 0 ? 'none' : result.silent.join(',')
  trace(t0, `verdict=${result.kind} address_class=${result.addressClass} mapped_port=${mappedPort} silent=${silentSteps}`)
  return result
}

function toResult(
  outcome: MappingOutcome,
  options: DiscoverOptions,
  gatewayIp: string | null,
  silent: string[],
): DiscoveryResult {
  const { kind, addressClass } = classifyMapping(outcome)
  // `detail` is for humans only: the arms' own words, plus the router's page
  // address so the manual door can name it.
  const detail = gatewayIp === null ? outcome.detail : `${outcome.detail}; gateway ${gatewayIp}`
  const result: DiscoveryResult = {
    kind,
    mappedPort: outcome.type === 'mapped' ? outcome.mappedPort : null,
    localPort: options.localPort,
    detail,
    addressClass,
    faultCode: outcome.type === 'refused' ? (outcome.faultCode ?? null) : null,
    gatewayIp,
    silent: [...new Set(silent)],
    mappingDisabled: options.map === false,
    sentence: '',
  }
  if (outcome.type === 'mapped') result.externalIp = outcome.externalIp
  result.sentence = sentenceFor(result)
  return result
}

// A successful mapping must outlive this call: stopping the gateway unmaps the
// port. The router's own lease (one hour) is the cleanup if the app is killed.
let activeGateway: Gateway | null = null
// T66b: the app's own UPnP mapping, undone on a clean stop (ADR-045); the
// router's lease is what covers a crash.
let activeUpnp: (() => Promise<SoapResult>) | null = null

/**
 * Undo whatever this process mapped: the NAT-PMP gateway and the app's own
 * UPnP mapping. Called on retry and when the room stops (main.ts).
 */
export async function releaseMapping(): Promise<void> {
  const gateway = activeGateway
  activeGateway = null
  if (gateway !== null) await gateway.stop().catch(() => {})

  const release = activeUpnp
  activeUpnp = null
  if (release !== null) await release().catch(() => {})
}

const NAT_PMP_BUDGET_MS = 2_500
/** Long enough for a router that answers in milliseconds; short of the budget. */
const UPNP_LISTEN_MS = 2_500

/**
 * One mapping attempt, two ways in. NAT-PMP first because it answers in about
 * a quarter of a second here and needs no discovery. UPnP second, spoken by
 * this app through `upnp.ts` because the library's client binds UDP 1900,
 * which Windows' SSDP service already holds (ADR-045).
 */
async function mapPort(
  options: DiscoverOptions,
  timeoutMs: number,
  t0: number,
  gatewayIp: string | null,
): Promise<AttemptStep> {
  const localPort = options.localPort
  const lanIp = options.lanIp as string
  const deadline = Date.now() + timeoutMs
  const attempts: string[] = []
  const silent: string[] = []
  let sawTimeout = false
  // Whether any arm answered at all, and the first code a refusal named. They
  // decide "no gateway answered" without waiting for the clock (T73).
  let answered = false
  let faultCode: number | null = null

  const candidates: string[] = options.natPmpGateways ?? (gatewayIp === null ? [] : [gatewayIp])

  if (candidates.length === 0) {
    silent.push('gateway')
    trace(t0, 'natpmp=skipped reason=no-gateway')
    attempts.push('NAT-PMP: no default gateway found')
  }

  for (const gatewayIp of candidates) {
    const budget = Math.min(NAT_PMP_BUDGET_MS, deadline - Date.now())
    if (budget <= 0) {
      silent.push('budget')
      trace(t0, `natpmp=skipped reason=no-budget budget_ms=${budget}`)
      attempts.push('NAT-PMP: no budget left')
      break
    }
    trace(t0, `natpmp=request gateway=${gatewayIp} local_port=${localPort} budget_ms=${budget}`)
    const pmp = await mapWithNatPmp(localPort, lanIp, gatewayIp, budget, t0)
    if (pmp.outcome.type === 'mapped') {
      trace(t0, 'upnp=skipped reason=mapped-by-natpmp')
      return { outcome: pmp.outcome, silent }
    }
    if (pmp.outcome.type === 'timeout') {
      sawTimeout = true
      silent.push('natpmp')
    } else if (pmp.outcome.type === 'refused') {
      // A refusal is an answer: the router spoke, even if it named no code.
      answered = true
      if (pmp.outcome.faultCode !== undefined && pmp.outcome.faultCode !== null && faultCode === null) {
        faultCode = pmp.outcome.faultCode
      }
      silent.push(...pmp.silent)
    }
    attempts.push(`NAT-PMP: ${pmp.outcome.detail}`)
  }

  const remaining = deadline - Date.now()
  if (remaining > 0) {
    trace(t0, `upnp=search start st=2,1 from=ephemeral timeout_ms=${Math.min(UPNP_LISTEN_MS, remaining)}`)
    const search = options.upnpSearch ?? searchGateways
    let gateways: UpnpGateway[]
    try {
      gateways = await search({ timeoutMs: Math.min(UPNP_LISTEN_MS, remaining), t0 })
    } catch (error) {
      trace(t0, `upnp=search result=failed ${describeError(error)}`)
      gateways = []
    }
    const upnp = await mapWithUpnp(gateways, localPort, lanIp, deadline, t0)
    if (upnp.outcome.type === 'mapped') {
      const addressClass = classifyAddress(upnp.outcome.externalIp)
      trace(t0, `upnp=address class=${addressClass}`)
      activeUpnp = upnp.release
      return {
        outcome: {
          type: 'mapped',
          externalIp: upnp.outcome.externalIp,
          mappedPort: upnp.outcome.externalPort,
          detail: `router reported ${upnp.outcome.externalIp} (${addressClass})`,
        },
        silent,
      }
    }
    if (upnp.outcome.type === 'timeout') {
      sawTimeout = true
    } else {
      // A fault or a bad answer is not silence: the gateway replied.
      if (upnp.silent.length === 0) answered = true
      if (upnp.outcome.type === 'refused' && upnp.outcome.faultCode !== null && faultCode === null) {
        faultCode = upnp.outcome.faultCode
      }
    }
    silent.push(...upnp.silent)
    attempts.push(`UPnP: ${upnp.outcome.detail}`)
  } else {
    silent.push('budget')
    trace(t0, 'upnp=skipped reason=no-budget')
    attempts.push('UPnP: no budget left')
  }

  trace(t0, `attempts="${oneLine(attempts.join('; '))}"`)
  if (answered) {
    return { outcome: { type: 'refused', detail: attempts.join('; '), faultCode }, silent }
  }
  // The two silent arms end at about 5 s, well short of the 8 s budget: the
  // reason is their silence, not a clock running out (T73).
  if (sawTimeout && Date.now() >= deadline - 100) {
    return { outcome: { type: 'timeout', detail: `no answer within ${Math.round(timeoutMs / 1000)} seconds` }, silent }
  }
  return { outcome: { type: 'silent', detail: attempts.join('; ') }, silent }
}

async function mapWithNatPmp(
  localPort: number,
  lanIp: string,
  gatewayIp: string,
  timeoutMs: number,
  t0: number,
): Promise<AttemptStep> {
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
    trace(t0, `natpmp=response result=mapped external_port=${mapping.externalPort}`)
    const externalIp = (await gateway.externalIp({ signal: controller.signal })).trim()
    const addressClass = classifyAddress(externalIp)
    trace(t0, `natpmp=external ip=${externalIp === '' ? 'none' : externalIp}`)
    trace(t0, `natpmp=address class=${addressClass}`)

    if (!isIPv4(externalIp)) {
      return {
        outcome: { type: 'refused', detail: `router reported a non-IPv4 address: ${externalIp}` },
        silent: [],
      }
    }

    keepMapping = true
    activeGateway = gateway
    return {
      outcome: {
        type: 'mapped',
        externalIp,
        mappedPort: mapping.externalPort,
        detail: `router reported ${externalIp} (${addressClass})`,
      },
      silent: [],
    }
  } catch (error) {
    if (controller.signal.aborted) {
      trace(t0, `natpmp=response result=timeout budget_ms=${timeoutMs}`)
      return {
        outcome: { type: 'timeout', detail: `NAT-PMP did not answer within ${Math.round(timeoutMs / 1000)} seconds` },
        silent: ['natpmp'],
      }
    }
    trace(t0, `natpmp=response result=refused ${describeError(error)}`)
    // The library's NAT-PMP result code lives on `error.code` (err-code);
    // carry it so the screen can name the router's own reason (T73).
    return { outcome: { type: 'refused', detail: messageOf(error), faultCode: faultCodeOf(error) }, silent: [] }
  } finally {
    clearTimeout(timer)
    if (!keepMapping) {
      // Fire and forget: some gateways never settle this, and a failed
      // mapping has nothing to wait for.
      void gateway.stop().catch(() => {})
    }
  }
}

/** The app's own UPnP: each gateway found, described and asked to map. */
async function mapWithUpnp(
  gateways: UpnpGateway[],
  localPort: number,
  lanIp: string,
  deadline: number,
  t0: number,
): Promise<UpnpMapping> {
  let last: UpnpMapping = {
    outcome: { type: 'refused', detail: 'no router answered UPnP', status: 0, faultCode: null },
    silent: ['upnp-search'],
    release: null,
  }
  for (const gateway of gateways) {
    const budget = deadline - Date.now()
    if (budget <= 0) {
      return { outcome: { type: 'timeout', detail: 'UPnP did not answer within the budget' }, silent: ['upnp-search'], release: null }
    }
    last = await mapThroughUpnp({ gateway, localPort, lanIp, timeoutMs: budget, t0 })
    if (last.outcome.type === 'mapped') return last
    // A router that mapped but could not name its address has already been
    // asked to remove it; the next description is tried clean.
    if (last.release !== null) {
      await last.release().catch(() => {})
      last = { ...last, release: null }
    }
  }
  return last
}

/** The default IPv4 route's gateway, from Windows' own table (no dependency). */
export async function findDefaultGateway(t0: number = Date.now()): Promise<string | null> {
  if (process.platform !== 'win32') {
    trace(t0, 'gateway=none route_ms=0 reason=not-win32')
    return null
  }
  const routeStart = Date.now()
  try {
    const { stdout } = await execFileAsync('route', ['print', '-4'], { timeout: 3_000, windowsHide: true })
    for (const line of stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length >= 4 && columns[0] === '0.0.0.0' && columns[1] === '0.0.0.0' && isIPv4(columns[2])) {
        trace(t0, `gateway=${columns[2]} route_ms=${Date.now() - routeStart}`)
        return columns[2]
      }
    }
  } catch (error) {
    trace(t0, `gateway=none route_ms=${Date.now() - routeStart} ${describeError(error)}`)
    return null
  }
  trace(t0, `gateway=none route_ms=${Date.now() - routeStart}`)
  return null
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/** The numeric code a thrown error carries, if any (NAT-PMP's result code). */
export function faultCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'number' && Number.isInteger(code)) return code
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  return null
}

/** The library's error text, plus the code it attached (NAT-PMP's result code). */
function describeError(error: unknown): string {
  const message = oneLine(messageOf(error))
  const code = faultCodeOf(error)
  const codePart = code === null ? '' : `code=${String(code)} `
  return `${codePart}detail="${message}"`
}
