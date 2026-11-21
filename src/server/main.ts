import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { portLine } from '../shared/port.ts'
import { newRoomCode } from '../shared/room.ts'
import { createSidecarServer } from './app.ts'
import { discover, findLanIp } from './discovery.ts'
import type { DiscoveryResult } from './discovery.ts'
import { buildInviteLinks } from './invite.ts'
import type { InviteLinks } from './invite.ts'
import { createRoom } from './room.ts'
import { attachRoomSocket } from './socket.ts'

// src/server/main.ts → repo root, which holds package.json and dist/.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // Fall through: a missing or unreadable package.json must not stop the page.
  }
  return '0.0.0'
}

interface StartPayload {
  status: 'pending' | 'ready'
  roomCode: string
  lanIp: string | null
  localPort: number
  result: DiscoveryResult | null
  invite: InviteLinks | null
}

// The listener binds every interface: a guest has to reach this, and the
// window still loads it from 127.0.0.1 (ADR-034). One listener, two jobs.
const lanIp = findLanIp()
const roomCode = newRoomCode()
const mapPorts = process.env.WATCHPARTY_NO_MAP !== '1'
const dev = process.env.NODE_ENV !== 'production'

let startState: StartPayload = {
  status: 'pending',
  roomCode,
  lanIp,
  localPort: 0,
  result: null,
  invite: buildInviteLinks({ kind: 'upnp_unavailable', mappedPort: null, lanIp, localPort: 0, code: roomCode }),
}

// The room lives here and nowhere else (ADR-034): the host reads one port line
// and knows nothing about codes, members or frames. The socket shares the page's
// listener, so the window and a guest dial the same port (T3 item 1).
const room = createRoom(roomCode)

function log(line: string): void {
  process.stdout.write(`${line}\n`)
}

const server = createSidecarServer({
  distDir: join(root, 'dist'),
  // T6b's clip stays served for the tests (T9a3 makes it the tests' only
  // consumer: the page no longer opens on it; `/fixture` is one path, nothing
  // more, and `tests/integration/sidecar.test.ts` is what still reads it).
  fixture: join(root, 'tests', 'fixtures', 'fixture.mp4'),
  // T9a1: `/media/<id>` streams the one file the owner registered; the id is
  // the only thing a guest's window ever holds.
  media: () => room.media,
  log,
  version: readVersion(),
  start: () => startState,
  retryDiscovery: () => void runDiscovery(),
})

attachRoomSocket(server, room, {
  log,
  // Dev-only: one line per `state`, so a check can count them in the host log.
  // A production sidecar (`NODE_ENV=production`) passes nothing and logs none.
  debug: dev ? (line) => process.stdout.write(`[dev] ${line}\n`) : undefined,
})

server.on('error', (error: Error) => {
  process.stderr.write(`sidecar: cannot listen: ${error.message}\n`)
  process.exit(1)
})

let discovering = false

async function runDiscovery(): Promise<void> {
  if (discovering) return
  discovering = true
  try {
    // Listen first, then map (T2 Method notes): a mapping that succeeds while
    // the listener is down produces a link that fails for the guest.
    startState = {
      ...startState,
      status: 'pending',
      result: null,
      invite: buildInviteLinks({
        kind: 'upnp_unavailable',
        mappedPort: null,
        lanIp,
        localPort: startState.localPort,
        code: roomCode,
      }),
    }

    const result = await discover({
      localPort: startState.localPort,
      lanIp,
      map: mapPorts,
    })

    startState = {
      status: 'ready',
      roomCode,
      lanIp,
      localPort: startState.localPort,
      result,
      invite: buildInviteLinks({
        kind: result.kind,
        externalIp: result.externalIp,
        mappedPort: result.mappedPort,
        lanIp,
        localPort: result.localPort,
        code: roomCode,
      }),
    }

    if (dev) {
      // The three lines E1's method is read from (T2 item 4). They are also
      // what the host's log shows, because the host logs sidecar stdout.
      process.stdout.write(`[dev] discovery: mapped address ${result.externalIp ?? 'none'}\n`)
      process.stdout.write(`[dev] discovery: address class ${result.addressClass}\n`)
      process.stdout.write(`[dev] discovery: verdict ${result.kind}\n`)
    }
  } finally {
    discovering = false
  }
}

server.listen(0, '0.0.0.0', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    process.stderr.write('sidecar: listening but no port\n')
    process.exit(1)
  }

  startState = { ...startState, localPort: address.port }
  // The host parses exactly this line, and nothing else, from stdout.
  process.stdout.write(`${portLine(address.port)}\n`)
  // T9a3: file mode's opening state, said once after the PORT line (which must
  // stay first) so a check can tell "no file yet" from "the pick never
  // happened". A fresh window shows the picker and plays nothing; the T6b
  // fixture is served for the tests only, never opened by the page any more.
  log('[media] none set - the room opens with no file')
  void runDiscovery()
})
