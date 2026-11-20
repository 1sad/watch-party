// Starts the .NET host, which owns the window and the sidecar process.
// The SDK is installed per user and is not on PATH in a fresh shell
// (AGENTS.md), so it is resolved here rather than assumed.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  { cwd: root, stdio: 'inherit' },
)

child.on('exit', (code) => process.exit(code ?? 0))
