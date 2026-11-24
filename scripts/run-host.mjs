// Starts the .NET host, which owns the window and the sidecar process.
// The SDK is installed per user and is not on PATH in a fresh shell
// (AGENTS.md), so it is resolved here rather than assumed.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const usage = `Usage: node scripts/run-host.mjs [--cdp-port <n>] [<invite link>]

  --cdp-port <n>   open the window's DevTools endpoint on 127.0.0.1:<n> (Debug
                   build only, loopback only); without the switch, no endpoint.
                   Two windows need two ports: 9222, then 9223.
  <invite link>    one watchparty://join?... link, in quotes (T131). The window
                   opens on that room's watching screen: the link is handed to
                   the host as a command-line argument, which is the route a
                   clicked link takes too (T2b, ADR-034). Without a link the
                   window opens on the first screen.
`

// `--cdp-port <n>` is what `npm run dev:debug` passes (T8c): the host then opens
// its DevTools endpoint on loopback, which is how a shell drives the window.
// Without the switch the host opens no endpoint at all — the normal build must
// not carry a listening port, and `npm run dev` passes nothing.
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(usage)
  process.exit(0)
}

const { cdpPort, invite } = parseArgs(argv)

function parseArgs(args) {
  const parsed = { cdpPort: null, invite: null }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--cdp-port' || arg.startsWith('--cdp-port=')) {
      const value = arg.includes('=') ? arg.slice('--cdp-port='.length) : args[(index += 1)]
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        refuse(`--cdp-port needs a port number, got ${value === undefined ? 'nothing' : `"${value}"`}.`)
      }

      parsed.cdpPort = port
      continue
    }

    // An option this launcher does not know is a typo in a check's own command
    // (a second window on 9222 instead of 9223), so it is refused rather than
    // passed on to the host, which ignores what it does not recognise.
    if (arg.startsWith('-')) refuse(`unknown option "${arg}".`)

    if (parsed.invite !== null) refuse(`one invite link at a time; got "${parsed.invite}" and "${arg}".`)

    // The host's own rule (LaunchLink.Find, ADR-034): only an absolute
    // watchparty: link is an invite, and anything else is "no invite" there
    // without a word. A launcher that silently opened the first screen would
    // read as a passing two-window check, so the launcher refuses here instead.
    if (!isInviteLink(arg)) {
      refuse(`"${arg}" is not a watchparty:// link, so the host would ignore it. Quote the whole link.`)
    }

    parsed.invite = arg
  }

  return parsed
}

function isInviteLink(text) {
  try {
    return new URL(text).protocol === 'watchparty:'
  } catch {
    return false
  }
}

function refuse(message) {
  console.error(`watch-party: ${message}`)
  console.error(usage)
  process.exit(2)
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

// T131: the launcher refuses to pass anything the host would ignore, so this
// line and what the window does cannot disagree.
console.log(
  `watch-party: starting the window; ${cdpPort === null ? 'no DevTools endpoint' : `DevTools on 127.0.0.1:${cdpPort}`}; `
    + `first address ${invite === null ? 'the first screen' : `the invite link "${invite}"`}`,
)

const child = spawn(
  dotnet,
  // T131: everything after `--` is the host's own argv, which is how a clicked
  // watchparty:// link arrives (Program.cs, T2b) - the same argument in both
  // routes, so the two-window gate now opens the way a guest really does.
  [
    'run',
    '--project',
    join('host', 'WatchParty.Host', 'WatchParty.Host.csproj'),
    '-c',
    'Debug',
    '--nologo',
    ...(invite === null ? [] : ['--', invite]),
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: cdpPort === null ? process.env : { ...process.env, WATCHPARTY_CDP_PORT: String(cdpPort) },
  },
)

child.on('exit', (code) => process.exit(code ?? 0))
