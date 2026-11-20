import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { portLine } from '../shared/port.ts'
import { createSidecarServer } from './app.ts'

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

// Loopback only for now: the room's listener (all interfaces, ADR-023) is a
// later ticket's change, not this one's.
const server = createSidecarServer({ distDir: join(root, 'dist'), version: readVersion() })

server.on('error', (error: Error) => {
  process.stderr.write(`sidecar: cannot listen: ${error.message}\n`)
  process.exit(1)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    process.stderr.write('sidecar: listening but no port\n')
    process.exit(1)
  }
  // The host parses exactly this line, and nothing else, from stdout.
  process.stdout.write(`${portLine(address.port)}\n`)
})
