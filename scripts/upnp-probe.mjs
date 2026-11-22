// Tells what the router answers to each UPnP gateway version, from this machine
// (T66). The app asks only for `InternetGatewayDevice:2` and its search sends
// one datagram, so "no router answered UPnP" covers a router that speaks
// version 1, a lost packet and a blocked reply alike. This probe separates
// them: the same M-SEARCH, twice, once per version, on the same socket per
// interface, with every answer's description URL printed.
//
//   node scripts/upnp-probe.mjs [--port 1900]
//
// stdout carries the answer and nothing else, one value per line:
//
//   PROBE: socket local=<ip> port=<n|0> result=<listening|failed> [detail="..."]
//   PROBE: st=<1|2> answers=<n> location=<url|none>
//   ANSWER: search=<1|2> from=<ip> via=<ip> reply_st=<urn|none> location=<url>
//
// A silent router prints `location=none` for that search; that is an answer,
// not a failure. Exit is non-zero only when no socket would open at all - the
// state in which the app's own client yields no gateway for a reason that has
// nothing to do with the router.
//
// The default port is 1900 because that is what the library binds (reuseAddr,
// `dist/src/upnp/discovery.js:40`), so this run is the app's own situation and
// a reply the Windows SSDP service takes instead of this process is missing
// here too. `--port 0` is the control: the same two searches from an ephemeral
// port, which tells a router that says nothing from a reply this machine never
// got. Nothing here is shipped code and it adds no dependency (ADR-035).
import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

const SEARCH_HOST = '239.255.255.250'
const SEARCH_PORT = 1900
/** The library sends `MX: 1`; a conforming router answers within that second. */
const LISTEN_MS = 3_000
const VERSIONS = [
  { search: '2', st: 'urn:schemas-upnp-org:device:InternetGatewayDevice:2' },
  { search: '1', st: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1' },
]

function out(line) {
  process.stdout.write(`${line}\n`)
}

/** `--port 0` binds an ephemeral port; the default is the library's own 1900. */
function bindPort(argv) {
  const index = argv.indexOf('--port')
  if (index === -1) return SEARCH_PORT
  const port = Number(argv[index + 1])
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    out('PROBE: none reason=bad-port')
    process.exit(1)
  }
  return port
}

/** Every non-internal IPv4 address, the interfaces the library binds on. */
function localAddresses() {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      addresses.push(entry.address)
    }
  }
  return addresses
}

/** One socket on one address at the chosen port; `socket === null` when it failed. */
function openSocket(address, port) {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false

    socket.on('error', (error) => {
      const detail = String(error?.message ?? error).replace(/\s+/g, ' ')
      if (settled) {
        // A port-unreachable from a router that never opened its SOAP port can
        // surface here; it must not take the run down.
        out(`PROBE: socket local=${address} error="${detail}"`)
        return
      }
      settled = true
      socket.close()
      out(`PROBE: socket local=${address} port=${port} result=failed detail="${detail}"`)
      resolve(null)
    })

    socket.bind(port, address, () => {
      if (settled) return
      settled = true
      try {
        socket.setBroadcast(true)
      } catch {
        // Not needed to send to a multicast group; a failure here changes nothing.
      }
      out(`PROBE: socket local=${address} port=${socket.address().port} result=listening`)
      resolve(socket)
    })
  })
}

function searchMessage(st) {
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

/** One SSDP reply, or null when the datagram is not one. */
function parseReply(buffer) {
  const lines = buffer.toString('utf8').split(/\r?\n/)
  if (!/^HTTP\/1\.1 200/.test(lines[0] ?? '')) return null
  const headers = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    headers[line.slice(0, colon).trim().toUpperCase()] = line.slice(colon + 1).trim()
  }
  return headers
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sendAndCollect(sockets, entry) {
  /** location+remote -> answer; one line per distinct reply, whoever sent it. */
  const answers = new Map()

  for (const { address, socket } of sockets) {
    socket.removeAllListeners('message')
    socket.on('message', (buffer, remote) => {
      const headers = parseReply(buffer)
      if (headers === null || headers.LOCATION === undefined) return
      answers.set(`${headers.LOCATION}\n${remote.address}`, {
        from: remote.address,
        via: address,
        replySt: headers.ST ?? 'none',
        location: headers.LOCATION,
      })
    })
    const message = searchMessage(entry.st)
    await new Promise((resolve) => {
      socket.send(message, 0, message.length, SEARCH_PORT, SEARCH_HOST, (error) => {
        if (error) {
          out(`PROBE: send search=${entry.search} via=${address} result=failed detail="${String(error.message).replace(/\s+/g, ' ')}"`)
        }
        resolve()
      })
    })
  }

  await wait(LISTEN_MS)

  const found = [...answers.values()]
  for (const { socket } of sockets) socket.removeAllListeners('message')

  for (const answer of found) {
    out(`ANSWER: search=${entry.search} from=${answer.from} via=${answer.via} reply_st=${answer.replySt} location=${answer.location}`)
  }
  const locations = [...new Set(found.map((answer) => answer.location))]
  out(`PROBE: st=${entry.search} answers=${locations.length} location=${locations.length === 0 ? 'none' : locations.join(',')}`)
}

async function main() {
  const port = bindPort(process.argv.slice(2))
  const addresses = localAddresses()
  if (addresses.length === 0) {
    out('PROBE: none reason=no-ipv4-interface')
    process.exitCode = 1
    return
  }

  const sockets = []
  for (const address of addresses) {
    const socket = await openSocket(address, port)
    if (socket !== null) sockets.push({ address, socket })
  }
  if (sockets.length === 0) {
    out(`PROBE: none reason=no-socket interfaces=${addresses.join(',')}`)
    process.exitCode = 1
    return
  }

  out(`PROBE: searching host=${SEARCH_HOST} port=${SEARCH_PORT} interfaces=${sockets.map((s) => s.address).join(',')} listen_ms=${LISTEN_MS}`)
  for (const entry of VERSIONS) await sendAndCollect(sockets, entry)
  for (const { socket } of sockets) socket.close()
}

await main()
