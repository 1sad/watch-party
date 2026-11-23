import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  classifyAddress,
  classifyMapping,
  discover,
  faultCodeOf,
  releaseMapping,
  sentenceFor,
} from '../../src/server/discovery.ts'
import type { MappingOutcome, SentenceFacts } from '../../src/server/discovery.ts'
import { parseLocation } from '../../src/server/upnp.ts'
import { trace } from '../../src/server/trace.ts'

const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

interface FakeRouter {
  base: string
  /** Every SOAP action the router was asked to perform, in order. */
  actions: string[]
  close: () => Promise<void>
}

/**
 * A gateway that answers the description and the three SOAP calls, so the
 * app's own UPnP arm is exercised without a router on the network (T66b).
 * A `mapFault` makes `AddPortMapping` fail the way a real router does; a
 * `hangMap` makes it never answer at all (T78, fault 6).
 */
async function fakeRouter(
  options: { mapFault?: number; externalIp?: string; faultText?: string; hangMap?: boolean } = {},
): Promise<FakeRouter> {
  const actions: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/xml' })
      response.end(DESCRIPTION)
      return
    }
    const header = String(request.headers.soapaction ?? '')
    const action = header.split('#')[1]?.replace(/"/g, '') ?? 'none'
    actions.push(action)
    request.resume()
    if (action === 'AddPortMapping' && options.hangMap === true) {
      // The request is read and never answered: only the client's own timeout
      // ends it, which is what a router stuck on the map looks like (T78).
      return
    }
    request.on('end', () => {
      if (action === 'AddPortMapping' && options.mapFault !== undefined) {
        response.writeHead(500, { 'Content-Type': 'text/xml' })
        response.end(
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${options.mapFault}</errorCode><errorDescription>${options.faultText ?? 'ConflictInMappingEntry'}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
        )
        return
      }
      const body =
        action === 'GetExternalIPAddress'
          ? `<NewExternalIPAddress>${options.externalIp ?? '203.0.113.9'}</NewExternalIPAddress>`
          : ''
      response.writeHead(200, { 'Content-Type': 'text/xml' })
      response.end(
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${body}</u:${action}Response></s:Body></s:Envelope>`,
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    base: `http://127.0.0.1:${address.port}`,
    actions,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

test('an empty NAT-PMP list sends the app to its own UPnP arm, and the SOAP answers become the verdict (T66b)', async () => {
  const router = await fakeRouter()
  try {
    const result = await discover({
      localPort: 45123,
      lanIp: '192.168.10.20',
      timeoutMs: 3_000,
      natPmpGateways: [],
      upnpSearch: async () => [{ location: `${router.base}/rootDesc.xml`, host: '127.0.0.1' }],
    })

    // The verdict the app builds from the router's own answers, with no
    // NAT-PMP attempt in the way.
    assert.equal(result.kind, 'ok')
    assert.equal(result.addressClass, 'public')
    assert.equal(result.externalIp, '203.0.113.9')
    assert.equal(result.mappedPort, 45123)
    assert.equal(result.localPort, 45123)
    assert.deepEqual(router.actions, ['AddPortMapping', 'GetExternalIPAddress'])

    // The mapping is taken down when the room stops (the safety line).
    await releaseMapping()
    assert.deepEqual(router.actions, ['AddPortMapping', 'GetExternalIPAddress', 'DeletePortMapping'])
  } finally {
    await router.close()
  }
})

test("a router's SOAP fault reaches the verdict as the router's own code (T66b)", async () => {
  const router = await fakeRouter({ mapFault: 718 })
  try {
    const result = await discover({
      localPort: 45123,
      lanIp: '192.168.10.20',
      timeoutMs: 3_000,
      natPmpGateways: [],
      upnpSearch: async () => [{ location: `${router.base}/rootDesc.xml`, host: '127.0.0.1' }],
    })

    assert.equal(result.kind, 'upnp_unavailable')
    assert.equal(result.mappedPort, null)
    assert.equal(result.faultCode, 718)
    assert.match(result.sentence, /718/)
    assert.match(result.detail, /718/)
    assert.deepEqual(router.actions, ['AddPortMapping'])
  } finally {
    await router.close()
  }
})

test("one non-ASCII word from the router cannot reach a discovery: line (T75)", async () => {
  // A router that describes its refusal in its own alphabet: a non-breaking
  // space, a curly apostrophe and an accented letter. Before T75 these bytes
  // reached stdout, where PowerShell's Get-Content turns them to garbage.
  const router = await fakeRouter({ mapFault: 718, faultText: 'Conflit\u00a0d\u2019entr\u00e9e \u2014 ConflictInMappingEntry' })
  const writes: string[] = []
  const originalWrite = process.stdout.write
  // Capture only the trace's own lines: with `node --test` the runner shares
  // stdout with a binary event channel, which must keep flowing and is not
  // part of the log. `trace()` writes one complete line per call.
  const capture = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (text.startsWith('discovery: ')) {
      writes.push(text.replace(/\r?\n$/, ''))
      return true
    }
    return (originalWrite as unknown as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest)
  }
  process.stdout.write = capture as typeof process.stdout.write
  try {
    const result = await discover({
      localPort: 45123,
      lanIp: '192.168.10.20',
      timeoutMs: 3_000,
      natPmpGateways: [],
      upnpSearch: async () => [{ location: `${router.base}/rootDesc.xml`, host: '127.0.0.1' }],
    })
    // The verdict is unchanged by the alphabet: still the router's own code.
    assert.equal(result.kind, 'upnp_unavailable')
    assert.equal(result.faultCode, 718)
  } finally {
    process.stdout.write = originalWrite
    await router.close()
  }

  const captured = writes.join('\n')
  // Counted on the lines themselves (the joiner is not trace output): each one
  // is a whole `discovery:` line with its terminator already removed.
  const bad = writes.join('').match(/[^\x20-\x7e]/g)?.length ?? 0
  console.log(`TRACE-ASCII: bad=${bad}`)
  // The router's own words were printed, or this test proves nothing - as
  // `?` where it left printable ASCII, which is the whole point of T75.
  assert.match(captured, /Conflit d\?entr\?e \? ConflictInMappingEntry/)
  assert.equal(bad, 0, 'the trace is ASCII whatever the router says')
})

test('a byte outside ASCII cannot reach a discovery: line, the location header on (T79)', async () => {
  // T75 fixed the fields its ticket named. The SSDP `LOCATION` header was still
  // taken from the wire verbatim (`parseLocation` only trims), so a LAN device
  // or a misconfigured router could put its own alphabet in one of the only
  // lines AGENTS.md rule 10 exists for. The guarantee now lives in `trace()`
  // (item 1), so this aims at `trace()` with the bytes a device really supplies.
  const reply = Buffer.from(
    'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1/root\u00e9\u2014desc.xml\r\nST: upnp:rootdevice\r\n\r\n',
    'utf8',
  )
  const location = parseLocation(reply)
  assert.ok(location !== null, 'the reply is a well-formed SSDP answer')
  // The device's bytes arrive intact: handing them over unchanged is still
  // `parseLocation`'s job. Making the line ASCII is `trace()`'s.
  assert.match(location, /[\u00e9\u2014]/)

  const { lines } = await withCapturedTrace(async () => {
    trace(0, `upnp=search answer host=192.168.1.1 location=${location}`)
  })

  const bad = lines.join('').match(/[^\x20-\x7e]/g)?.length ?? 0
  console.log(`TRACE-ASCII: bad=${bad} path=trace-from-location`)
  // The field still printed, marked where it was not printable: proof the byte
  // came through this path rather than being dropped before it reached it.
  assert.match(lines.join('\n'), /location=http:\/\/192\.168\.1\.1\/root\?\?desc\.xml/)
  assert.equal(bad, 0, 'the trace is ASCII whatever field a device fills')
})

function mapped(externalIp: string): MappingOutcome {
  return { type: 'mapped', externalIp, mappedPort: 52341, detail: 'router said so' }
}

test('10.0.33.122 → cgnat: a private "public" address is E1\'s diagnosis', () => {
  assert.equal(classifyAddress('10.0.33.122'), 'private')
  const verdict = classifyMapping(mapped('10.0.33.122'))
  assert.equal(verdict.kind, 'cgnat')
  assert.equal(verdict.addressClass, 'private')
})

test('100.64.1.5 → cgnat: the carrier-grade range is shared by definition', () => {
  assert.equal(classifyAddress('100.64.1.5'), 'cgnat')
  assert.equal(classifyMapping(mapped('100.64.1.5')).kind, 'cgnat')
})

test('192.168.1.9 → cgnat: a home-router address is not reachable from outside', () => {
  assert.equal(classifyAddress('192.168.1.9'), 'private')
  assert.equal(classifyMapping(mapped('192.168.1.9')).kind, 'cgnat')
})

test('203.0.113.9 → ok: a public address can accept visitors', () => {
  assert.equal(classifyAddress('203.0.113.9'), 'public')
  assert.equal(classifyMapping(mapped('203.0.113.9')).kind, 'ok')
})

test('a refusal → upnp_unavailable', () => {
  const verdict = classifyMapping({ type: 'refused', detail: 'no router answered UPnP' })
  assert.equal(verdict.kind, 'upnp_unavailable')
  assert.equal(verdict.addressClass, 'unknown')
})

test('an 8-second silence → timeout, not a crasher', () => {
  const verdict = classifyMapping({ type: 'timeout', detail: 'the router did not answer within 8 seconds' })
  assert.equal(verdict.kind, 'timeout')
  assert.equal(verdict.addressClass, 'unknown')
})

test('172.16/12 is private too, and 172.32 is not', () => {
  assert.equal(classifyAddress('172.16.0.1'), 'private')
  assert.equal(classifyAddress('172.31.255.254'), 'private')
  assert.equal(classifyAddress('172.32.0.1'), 'public')
})

test('both arms silent says no gateway answered, and it is not a clock running out (T73)', async () => {
  const result = await discover({
    localPort: 45123,
    lanIp: '192.168.10.20',
    timeoutMs: 3_000,
    natPmpGateways: [],
    upnpSearch: async () => [],
  })

  console.log(`SENTENCE: no gateway answered -> ${result.sentence}`)
  assert.equal(result.kind, 'no_gateway')
  assert.equal(result.faultCode, null)
  assert.match(result.sentence, /No router answered/)
  assert.doesNotMatch(result.sentence, /did not open the port/)
  assert.deepEqual(result.silent, ['gateway', 'upnp-search'])
})

/** Run `discover` with its trace lines kept, the way T75's capture does. */
async function withCapturedTrace<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const writes: string[] = []
  const originalWrite = process.stdout.write
  const capture = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (text.startsWith('discovery: ')) {
      writes.push(text.replace(/\r?\n$/, ''))
      return true
    }
    return (originalWrite as unknown as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest)
  }
  process.stdout.write = capture as typeof process.stdout.write
  try {
    return { value: await run(), lines: writes }
  } finally {
    process.stdout.write = originalWrite
  }
}

test('a router that answers the description but never the map is not "no router answered" (T78)', async () => {
  // Fault 6: the search found the gateway and the description answered, then
  // AddPortMapping hangs. T73 inferred "answered" from the outcome's shape, so
  // this run ended with silent ['upnp-map'] and the screen denied the router
  // had answered at all.
  const router = await fakeRouter({ hangMap: true })
  try {
    const { value: result, lines } = await withCapturedTrace(() =>
      discover({
        localPort: 45123,
        lanIp: '192.168.10.20',
        timeoutMs: 1_500,
        natPmpGateways: [],
        upnpSearch: async () => [{ location: `${router.base}/rootDesc.xml`, host: '127.0.0.1' }],
      }),
    )

    const description = lines.find((line) => line.includes('upnp=description'))
    console.log(`TRACE: ${description ?? 'no description line'}`)
    console.log(
      `SENTENCE: description answered, map hung -> kind=${result.kind} sentence=${result.sentence || '(none)'}`,
    )
    // The trace says the router answered, so the verdict must not deny it.
    assert.match(description ?? '', /upnp=description host=127\.0\.0\.1 result=ok/)
    assert.equal(router.actions[0], 'AddPortMapping')
    assert.equal(result.replied, true)
    assert.equal(result.kind, 'upnp_unavailable')
    assert.doesNotMatch(result.sentence, /No router answered/)
    assert.match(result.sentence, /Your router answered, but opening the port did not finish/)
  } finally {
    await router.close()
  }
})

test('a NAT-PMP socket error is not the router refusing, but its result code still is (T78)', async () => {
  // The library rejects map() with a socket error's own code, a string that is
  // not a result code. T73 treated every non-abort rejection as an answer, so
  // the screen blamed the router for a failure it never saw.
  const localError = Object.assign(new Error('bind EADDRINUSE 0.0.0.0:5351'), { code: 'EADDRINUSE' })
  const socketError = await discover({
    localPort: 45123,
    lanIp: '192.168.10.20',
    timeoutMs: 3_000,
    natPmpGateways: ['192.168.10.1'],
    natPmpClient: () => ({
      map: async () => {
        throw localError
      },
      externalIp: async () => '',
      stop: async () => {},
    }),
    upnpSearch: async () => [],
  })

  console.log(`SENTENCE: local socket error -> kind=${socketError.kind} sentence=${socketError.sentence}`)
  assert.equal(faultCodeOf(localError), null)
  assert.equal(socketError.replied, false)
  assert.equal(socketError.faultCode, null)
  assert.equal(socketError.kind, 'no_gateway')
  assert.match(socketError.sentence, /No router answered/)
  assert.doesNotMatch(socketError.sentence, /refused|did not open the port/)

  // The counter-case: the router's own NAT-PMP result code is a number, and it
  // does make the router a replier, so the same seam still says it refused.
  const refusedError = Object.assign(new Error('Not Authorized/Refused'), { code: 2 })
  const refused = await discover({
    localPort: 45123,
    lanIp: '192.168.10.20',
    timeoutMs: 3_000,
    natPmpGateways: ['192.168.10.1'],
    natPmpClient: () => ({
      map: async () => {
        throw refusedError
      },
      externalIp: async () => '',
      stop: async () => {},
    }),
    upnpSearch: async () => [],
  })

  assert.equal(refused.replied, true)
  assert.equal(refused.kind, 'upnp_unavailable')
  assert.equal(refused.faultCode, 2)
  assert.match(refused.sentence, /answered and refused/)
  assert.match(refused.sentence, /code 2/)
})

test('a NAT-PMP map that succeeds and then hangs still counts as the router answering (T78)', async () => {
  // Fault 2: map() came back, then the external-address read never does. Before
  // T78 this ended at `timeout` with silent ['natpmp'] and the screen said the
  // router had not answered, while the trace held natpmp=response result=mapped.
  const result = await discover({
    localPort: 45123,
    lanIp: '192.168.10.20',
    timeoutMs: 1_500,
    natPmpGateways: ['192.168.10.1'],
    natPmpClient: () => ({
      map: async () => ({
        externalHost: '',
        externalPort: 45123,
        internalHost: '192.168.10.20',
        internalPort: 45123,
        protocol: 'TCP' as const,
      }),
      externalIp: (options) =>
        new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      stop: async () => {},
    }),
    upnpSearch: async () => [],
  })

  console.log(`SENTENCE: natpmp mapped, external read hung -> kind=${result.kind} sentence=${result.sentence}`)
  assert.equal(result.replied, true)
  assert.equal(result.kind, 'upnp_unavailable')
  assert.equal(result.faultCode, null)
  assert.doesNotMatch(result.sentence, /No router answered/)
  assert.match(result.sentence, /Your router answered, but opening the port did not finish/)
})

test("a NAT-PMP refusal keeps the router's own code as a field (T73)", () => {
  const error = Object.assign(new Error('Not Authorized/Refused (gateway may have NAT-PMP disabled)'), {
    code: 2,
  })
  assert.equal(faultCodeOf(error), 2)
  assert.equal(faultCodeOf(new Error('no code attached')), null)
  assert.equal(faultCodeOf('no object'), null)

  const text = sentenceFor({ kind: 'upnp_unavailable', faultCode: 2, mappingDisabled: false, replied: true })
  assert.match(text, /code 2/)
  assert.doesNotMatch(text, /gave no error code/)
})

function facts(overrides: Partial<SentenceFacts>): SentenceFacts {
  return { kind: 'upnp_unavailable', faultCode: null, mappingDisabled: false, replied: false, ...overrides }
}

test('the deliberate off switch is a field, not a sentence to search (T73)', () => {
  const text = sentenceFor(facts({ mappingDisabled: true }))
  assert.match(text, /WATCHPARTY_NO_MAP/)
  assert.doesNotMatch(text, /gave no error code/)
})

test('each reason gets its own sentence, and only a public address offers the world (T67, T73)', () => {
  const cases: Array<[string, string]> = [
    ['no gateway answered', sentenceFor(facts({ kind: 'no_gateway' }))],
    ['gateway answered and refused, with its own code', sentenceFor(facts({ faultCode: 718 }))],
    ['mapped, but the address is private or shared', sentenceFor(facts({ kind: 'cgnat', externalIp: '100.64.1.5' }))],
    ['mapped and public', sentenceFor(facts({ kind: 'ok', externalIp: '203.0.113.9' }))],
  ]

  const texts = cases.map(([reason, text]) => {
    console.log(`SENTENCE: ${reason} -> ${text}`)
    return text
  })

  // No two reasons share a sentence: the reader can tell them apart.
  assert.equal(new Set(texts).size, 4)
  // The router's own code is carried through, not replaced by "did not answer".
  assert.match(texts[1], /718/)
  // The CGNAT case names the address the router reported.
  assert.match(texts[2], /100\.64\.1\.5/)
  assert.doesNotMatch(texts[2], /Share the invite link/)
  // Only the public verdict promises an outside visitor.
  assert.match(texts[3], /Share the invite link/)
  assert.doesNotMatch(texts[0], /Share the invite link/)
  assert.doesNotMatch(texts[1], /Share the invite link/)
})
