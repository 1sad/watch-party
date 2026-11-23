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
 * A `mapFault` makes `AddPortMapping` fail the way a real router does.
 */
async function fakeRouter(
  options: { mapFault?: number; externalIp?: string; faultText?: string } = {},
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

test("a NAT-PMP refusal keeps the router's own code as a field (T73)", () => {
  const error = Object.assign(new Error('Not Authorized/Refused (gateway may have NAT-PMP disabled)'), {
    code: 2,
  })
  assert.equal(faultCodeOf(error), 2)
  assert.equal(faultCodeOf(new Error('no code attached')), null)
  assert.equal(faultCodeOf('no object'), null)

  const text = sentenceFor({ kind: 'upnp_unavailable', faultCode: 2, mappingDisabled: false })
  assert.match(text, /code 2/)
  assert.doesNotMatch(text, /gave no error code/)
})

function facts(overrides: Partial<SentenceFacts>): SentenceFacts {
  return { kind: 'upnp_unavailable', faultCode: null, mappingDisabled: false, ...overrides }
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
