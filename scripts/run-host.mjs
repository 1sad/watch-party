// Starts the .NET host, which owns the window and the sidecar process.
// The SDK is installed per user and is not on PATH in a fresh shell
// (AGENTS.md), so it is resolved here rather than assumed.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `--cdp-port <n>` is what `npm run dev:debug` passes (T8c): the host then opens
// its DevTools endpoint on loopback, which is how a shell drives the window.
// Without the switch the host opens no endpoint at all — the normal build must
// not carry a listening port, and `npm run dev` passes nothing.
const cdpPort = readCdpPort(process.argv.slice(2))

function readCdpPort(args) {
  const flag = args.find((arg) => arg === '--cdp-port' || arg.startsWith('--cdp-port='))
  if (flag === undefined) return null

  const value = flag.includes('=') ? flag.slice('--cdp-port='.length) : args[args.indexOf(flag) + 1]
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(`watch-party: --cdp-port needs a port number, got ${value === undefined ? 'nothing' : `"${value}"`}.`)
    process.exit(2)
  }

  return port
}

const candidates = [
  process.env.WATCHPARTY_DOTNET,
  process.env.DOTNET_ROOT && join(process.env.DOTNET_ROOT, 'dotnet.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'dotnet', 'dotnet.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'dotnet', 'dotnet.exe'),
].filter(Boolean)

const dotnet = candidates.find((candidate) => existsSync(candidate))

if (!dotnet) {
  console.error(
    'watch-party: the .NET SDK was not found. Expected it at %LOCALAPPDATA%\\Microsoft\\dotnet\\dotnet.exe (AGENTS.md).',
  )
  process.exit(1)
}

const child = spawn(
  dotnet,
  ['run', '--project', join('host', 'WatchParty.Host', 'WatchParty.Host.csproj'), '-c', 'Debug', '--nologo'],
  {
    cwd: root,
    stdio: 'inherit',
    env: cdpPort === null ? process.env : { ...process.env, WATCHPARTY_CDP_PORT: String(cdpPort) },
  },
)

child.on('exit', (code) => process.exit(code ?? 0))
