import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { classifyAddress, classifyMapping, discover, releaseMapping } from '../../src/server/discovery.ts'
import type { MappingOutcome } from '../../src/server/discovery.ts'

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
async function fakeRouter(options: { mapFault?: number; externalIp?: string } = {}): Promise<FakeRouter> {
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
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${options.mapFault}</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
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
    assert.match(result.detail, /718/)
    assert.deepEqual(router.actions, ['AddPortMapping'])
  } finally {
    await router.close()
  }
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
