// T66b, ADR-045: the app speaks UPnP itself, from a socket bound to port 0.
//
// The library binds UDP 1900 (`@achingbrain/nat-port-mapper`
// `dist/src/upnp/discovery.js:40`), which Windows' SSDP service already holds
// on every interface, so the router's unicast replies never reach the app
// (ticket 66: zero answers on 1900, one in milliseconds from an ephemeral
// port). This file does the small part of the protocol the app needs: one
// M-SEARCH per gateway version, the device description, then
// `AddPortMapping`, `GetExternalIPAddress` and `DeletePortMapping`. Node's
// `dgram` and `http` only - ADR-045 allows no new dependency.
//
// Every step writes one ASCII `discovery:` line through `trace()`, with its
// outcome and its elapsed `ms=`. A SOAP fault is printed with the router's own
// `errorCode`, because that code is the reason vocabulary the page needs.
import { createSocket } from 'node:dgram'
import type { RemoteInfo, Socket as DgramSocket } from 'node:dgram'
import { request } from 'node:http'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

import { trace } from './trace.ts'

export const SEARCH_HOST = '239.255.255.250'
export const SEARCH_PORT = 1900
/** Both gateway versions, in the order the probe and the library ask them. */
export const SEARCH_TYPES = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
] as const
/** The router's own lease is the cleanup if the app is killed (ADR-045). */
export const DEFAULT_LEASE_SECONDS = 3_600
/** A description or a SOAP answer bigger than this is not one we understand. */
const MAX_BODY_BYTES = 256 * 1024
/** A delete after the room has already stopped must not wait long. */
const DELETE_TIMEOUT_MS = 3_000

export interface UpnpGateway {
  /** The description URL the router answered with. */
  location: string
  /** The router's address, for the trace. */
  host: string
}

export interface UpnpService {
  serviceType: string
  /** Absolute, resolved against the description URL the router gave. */
  controlUrl: string
}

export interface SoapResult {
  /** The HTTP status; 0 when no answer arrived at all. */
  status: number
  /** The router's own UPnP `errorCode`, when it sent a SOAP fault. */
  faultCode: number | null
  faultText: string | null
  body: string
}

export type UpnpOutcome =
  | { type: 'mapped'; externalIp: string; externalPort: number; detail: string; status: number; faultCode: null }
  | { type: 'refused'; detail: string; status: number; faultCode: number | null }
  | { type: 'timeout'; detail: string }

export interface UpnpMapping {
  outcome: UpnpOutcome
  /** The steps that produced no answer, named for the attempt's `verdict=` line. */
  silent: string[]
  /** Undoes the mapping this call created; null when the router holds none. */
  release: (() => Promise<SoapResult>) | null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/** One line's worth of an error: ASCII, no newlines, no stray quotes. */
export function oneLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .replace(/[^\x20-\x7e]/g, '?')
}

function remaining(deadline: number): number {
  return Math.max(deadline - Date.now(), 0)
}

// ---------------------------------------------------------------- the search

/** Every non-internal IPv4 address, the interfaces the search speaks from. */
function localAddresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      addresses.push(entry.address)
    }
  }
  return addresses
}

interface SearchSocket {
  address: string
  socket: DgramSocket
}

/** One socket on one address, at port 0 - the whole point of ADR-045. */
function openSearchSocket(address: string, t0: number): Promise<DgramSocket | null> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false

    socket.on('error', (error) => {
      if (settled) return
      settled = true
      trace(t0, `upnp=search bind local=${address} result=failed detail="${oneLine(messageOf(error))}"`)
      socket.close()
      resolve(null)
    })

    socket.bind(0, address, () => {
      if (settled) return
      settled = true
      try {
        socket.setBroadcast(true)
      } catch {
        // Not needed to send to a multicast group; a failure here changes nothing.
      }
      trace(t0, `upnp=search bind local=${address} port=${socket.address().port} result=listening`)
      resolve(socket)
    })
  })
}

function searchMessage(st: string): Buffer {
  // The library's own shape: `commands/discover/index.js` in @achingbrain/ssdp.
  const lines = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SEARCH_HOST}:${SEARCH_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 1',
    `ST: ${st}`,
  ]
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)
}

/** The `LOCATION` header of one SSDP reply, or null when it is not one. */
export function parseLocation(buffer: Buffer): string | null {
  const lines = buffer.toString('utf8').split(/\r?\n/)
  if (!/^HTTP\/1\.1 200/.test(lines[0] ?? '')) return null
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    if (line.slice(0, colon).trim().toUpperCase() !== 'LOCATION') continue
    const location = line.slice(colon + 1).trim()
    return location.length === 0 ? null : location
  }
  return null
}

export interface SearchOptions {
  /** How long to listen after both M-SEARCHes have gone out. */
  timeoutMs: number
  t0?: number
}

/**
 * Both M-SEARCHes at once, from a socket per interface bound to port 0, and
 * every distinct description URL the router answers with. Never throws.
 */
export async function searchGateways(options: SearchOptions): Promise<UpnpGateway[]> {
  const t0 = options.t0 ?? Date.now()
  const addresses = localAddresses()
  const sockets: SearchSocket[] = []
  for (const address of addresses) {
    const socket = await openSearchSocket(address, t0)
    if (socket !== null) sockets.push({ address, socket })
  }

  if (sockets.length === 0) {
    trace(t0, `upnp=search outcome=no-socket interfaces=${addresses.join(',') || 'none'}`)
    return []
  }

  const found = new Map<string, UpnpGateway>()
  const onMessage = (buffer: Buffer, remote: RemoteInfo): void => {
    const location = parseLocation(buffer)
    if (location === null || found.has(location)) return
    found.set(location, { location, host: remote.address })
    // `location` is the SSDP header verbatim - a device's own bytes, not ours.
    // It needs no `oneLine()`: `trace()` makes every line ASCII (T79).
    trace(t0, `upnp=search answer host=${remote.address} location=${location}`)
  }
  for (const { socket } of sockets) socket.on('message', onMessage)

  for (const st of SEARCH_TYPES) {
    const message = searchMessage(st)
    const version = st.endsWith(':2') ? '2' : '1'
    for (const { socket, address } of sockets) {
      socket.send(message, 0, message.length, SEARCH_PORT, SEARCH_HOST, (error) => {
        if (error !== null) {
          trace(t0, `upnp=search send st=${version} via=${address} result=failed detail="${oneLine(messageOf(error))}"`)
        }
      })
    }
  }

  await wait(options.timeoutMs)

  for (const { socket } of sockets) {
    socket.removeListener('message', onMessage)
    socket.close()
  }

  trace(t0, `upnp=search outcome=${found.size === 0 ? 'none' : 'found'} answers=${found.size}`)
  return [...found.values()]
}

// ----------------------------------------------------------- the description

/** XML text with entities decoded; enough for a description and a SOAP body. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

/** The text of the first `name` element, with any namespace prefix allowed. */
export function tagText(xml: string, name: string): string | null {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i')
  const match = pattern.exec(xml)
  return match === null ? null : decodeEntities(match[1].trim())
}

/** The WAN services the gateway offers, in document order, control URLs absolute. */
export function parseDescription(xml: string, base: string): UpnpService[] {
  const services: UpnpService[] = []
  const pattern = /<service\b[^>]*>([\s\S]*?)<\/service>/gi
  let match = pattern.exec(xml)
  while (match !== null) {
    const block = match[1]
    const serviceType = tagText(block, 'serviceType')
    const controlUrl = tagText(block, 'controlURL')
    if (serviceType !== null && controlUrl !== null) {
      try {
        services.push({ serviceType, controlUrl: new URL(controlUrl, base).toString() })
      } catch {
        // A control URL that will not resolve is not one we can call.
      }
    }
    match = pattern.exec(xml)
  }
  return services
}

/** The one service that maps ports: IP first, PPPoE routers second. */
const SERVICE_PREFERENCE = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
]

export function pickService(services: UpnpService[]): UpnpService | null {
  for (const wanted of SERVICE_PREFERENCE) {
    const found = services.find((service) => service.serviceType === wanted)
    if (found !== undefined) return found
  }
  return null
}

// ------------------------------------------------------------------ the HTTP

interface HttpAnswer {
  status: number
  body: string
}

function httpRequest(
  url: string,
  body: string | null,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      run()
    }

    const req = request(
      new URL(url),
      { method: body === null ? 'GET' : 'POST', headers, timeout: Math.max(timeoutMs, 1) },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= MAX_BODY_BYTES) chunks.push(chunk)
        })
        response.on('end', () => {
          finish(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        })
        response.on('error', (error: Error) => finish(() => reject(error)))
      },
    )
    req.on('timeout', () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs)} ms`)))
    req.on('error', (error: Error) => finish(() => reject(error)))
    if (body !== null) req.write(body)
    req.end()
  })
}

function readDescription(gateway: UpnpGateway, timeoutMs: number, t0: number): Promise<UpnpService | null> {
  return httpRequest(gateway.location, null, {}, timeoutMs).then(
    (answer) => {
      const services = answer.status === 200 ? parseDescription(answer.body, gateway.location) : []
      const service = pickService(services)
      if (service === null) {
        trace(
          t0,
          `upnp=description host=${gateway.host} result=failed status=${answer.status} services=${services.length}`,
        )
        return null
      }
      trace(
        t0,
        `upnp=description host=${gateway.host} result=ok status=${answer.status} service=${service.serviceType} control=${service.controlUrl}`,
      )
      return service
    },
    (error: unknown) => {
      trace(t0, `upnp=description host=${gateway.host} result=failed detail="${oneLine(messageOf(error))}"`)
      return null
    },
  )
}

// ------------------------------------------------------------------ the SOAP

function soapEnvelope(serviceType: string, action: string, args: Array<[string, string | number]>): string {
  const inner = args.map(([name, value]) => `<${name}>${value}</${name}>`).join('')
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">${inner}</u:${action}>
  </s:Body>
</s:Envelope>`
}

/** The router's fault code and text, when the body carries a SOAP fault. */
export function parseFault(xml: string): { faultCode: number | null; faultText: string | null } {
  const code = tagText(xml, 'errorCode')
  if (code !== null && /^-?\d+$/.test(code)) {
    return { faultCode: Number(code), faultText: tagText(xml, 'errorDescription') }
  }
  if (/<(?:[\w.-]+:)?Fault\b/i.test(xml)) {
    return { faultCode: null, faultText: tagText(xml, 'faultstring') }
  }
  return { faultCode: null, faultText: null }
}

/** One SOAP action on the gateway's control URL. Throws only when nothing answered. */
export async function callAction(
  service: UpnpService,
  action: string,
  args: Array<[string, string | number]>,
  timeoutMs: number,
): Promise<SoapResult> {
  const body = soapEnvelope(service.serviceType, action, args)
  const answer = await httpRequest(
    service.controlUrl,
    body,
    {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': String(Buffer.byteLength(body)),
      SOAPAction: `"${service.serviceType}#${action}"`,
      Connection: 'close',
    },
    timeoutMs,
  )
  return { status: answer.status, body: answer.body, ...parseFault(answer.body) }
}

// ------------------------------------------------------------------- the map

export interface UpnpMapOptions {
  gateway: UpnpGateway
  localPort: number
  lanIp: string
  /** Budget for description, map, external address and any undo. */
  timeoutMs: number
  /** The attempt's start, so `ms=` matches the other `discovery:` lines. */
  t0?: number
  leaseSeconds?: number
  description?: string
}

/** A failed step, in the shape the attempt needs and the trace already wrote. */
function failure(
  step: 'search' | 'description' | 'map' | 'external' | 'delete',
  error: unknown,
  t0: number,
  deadline: number,
): { outcome: UpnpOutcome; silent: string[] } {
  const detail = messageOf(error)
  if (Date.now() >= deadline) {
    trace(t0, `upnp=${step} result=timeout detail="${oneLine(detail)}"`)
    return {
      outcome: { type: 'timeout', detail: `UPnP ${step} did not answer within the budget` },
      silent: [`upnp-${step}`],
    }
  }
  trace(t0, `upnp=${step} result=failed detail="${oneLine(detail)}"`)
  return { outcome: { type: 'refused', detail, status: 0, faultCode: null }, silent: [`upnp-${step}`] }
}

/** A fault the router answered with: HTTP 500 plus its own `errorCode`. */
function faulted(step: 'map' | 'external' | 'delete', answer: SoapResult, t0: number): void {
  const code = answer.faultCode ?? answer.status
  trace(t0, `upnp=${step} response result=fault code=${code} detail="${oneLine(answer.faultText ?? 'no error text')}"`)
}

function refusedAnswer(answer: SoapResult): { outcome: UpnpOutcome; silent: string[] } {
  const code = answer.faultCode ?? answer.status
  const text = answer.faultText ?? 'no error text'
  // The router answered, so no arm is silent here (T73); the step is already
  // named by `faulted`'s trace line above.
  return {
    outcome: { type: 'refused', detail: `router refused with code ${code} (${text})`, status: answer.status, faultCode: answer.faultCode },
    silent: [],
  }
}

function deleter(service: UpnpService, externalPort: number, t0: number): () => Promise<SoapResult> {
  let done = false
  return async () => {
    if (done) return { status: 0, faultCode: null, faultText: 'already removed', body: '' }
    done = true
    try {
      const answer = await callAction(
        service,
        'DeletePortMapping',
        [
          ['NewRemoteHost', ''],
          ['NewExternalPort', externalPort],
          ['NewProtocol', 'TCP'],
        ],
        DELETE_TIMEOUT_MS,
      )
      if (answer.status === 200 && answer.faultCode === null) {
        trace(t0, `upnp=delete response result=deleted external_port=${externalPort} code=${answer.status}`)
      } else {
        faulted('delete', answer, t0)
      }
      return answer
    } catch (error) {
      trace(t0, `upnp=delete result=failed detail="${oneLine(messageOf(error))}"`)
      return { status: 0, faultCode: null, faultText: messageOf(error), body: '' }
    }
  }
}

/**
 * The description, `AddPortMapping`, `GetExternalIPAddress`, and a way to undo
 * the mapping. Never throws: a router that says nothing, a router that refuses
 * and a router that maps but cannot name its address are three outcomes.
 */
export async function mapPort(options: UpnpMapOptions): Promise<UpnpMapping> {
  const t0 = options.t0 ?? Date.now()
  const deadline = Date.now() + options.timeoutMs
  const service = await readDescription(options.gateway, remaining(deadline), t0)
  if (service === null) {
    return {
      outcome: { type: 'refused', detail: `no port-mapping service at ${options.gateway.host}`, status: 0, faultCode: null },
      silent: [],
      release: null,
    }
  }

  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const externalPort = options.localPort
  trace(
    t0,
    `upnp=map request protocol=TCP external_port=${externalPort} internal=${options.lanIp}:${options.localPort} lease_s=${leaseSeconds}`,
  )

  const mapStarted = Date.now()
  let mapped: SoapResult
  try {
    mapped = await callAction(
      service,
      'AddPortMapping',
      [
        ['NewRemoteHost', ''],
        ['NewExternalPort', externalPort],
        ['NewProtocol', 'TCP'],
        ['NewInternalPort', options.localPort],
        ['NewInternalClient', options.lanIp],
        ['NewEnabled', 1],
        ['NewPortMappingDescription', options.description ?? 'Watch Party'],
        ['NewLeaseDuration', leaseSeconds],
      ],
      remaining(deadline),
    )
  } catch (error) {
    return { ...failure('map', error, t0, deadline), release: null }
  }

  if (mapped.faultCode !== null || mapped.status !== 200) {
    faulted('map', mapped, t0)
    return { ...refusedAnswer(mapped), release: null }
  }
  trace(t0, `upnp=map response result=mapped external_port=${externalPort} code=${mapped.status} request_ms=${Date.now() - mapStarted}`)

  const release = deleter(service, externalPort, t0)
  let external: SoapResult
  try {
    external = await callAction(service, 'GetExternalIPAddress', [], remaining(deadline))
  } catch (error) {
    // The mapping exists but its address is unknown: nobody could dial it, so
    // hand the undo back and let the attempt say why.
    return { ...failure('external', error, t0, deadline), release }
  }

  if (external.faultCode !== null || external.status !== 200) {
    faulted('external', external, t0)
    return { ...refusedAnswer(external), release }
  }

  const externalIp = (tagText(external.body, 'NewExternalIPAddress') ?? '').trim()
  trace(t0, `upnp=external ip=${externalIp === '' ? 'none' : externalIp}`)
  if (!isIPv4(externalIp)) {
    return {
      outcome: { type: 'refused', detail: `router reported a non-IPv4 address: ${externalIp}`, status: external.status, faultCode: null },
      silent: [],
      release,
    }
  }

  return {
    outcome: {
      type: 'mapped',
      externalIp,
      externalPort,
      detail: `router reported ${externalIp}`,
      status: mapped.status,
      faultCode: null,
    },
    silent: [],
    release,
  }
}
