// Builds the portable executable (M7, ADR-041/ADR-042): one file carrying the
// .NET runtime, a pinned Node build, the sidecar's sources with their production
// dependencies, the built page and the ad list, plus one embedded zip payload.
//
// Nothing here changes what the app does: the sidecar still runs its TypeScript
// through Node's type stripping from `src/server/main.ts`, and computes `dist/`,
// the bridge script and `package.json` from its own module URL (ADR-042), so the
// payload is laid out exactly like the repository those paths expect.
//
// Usage: `npm run portable`  (output: release/WatchParty-<version>-portable.exe)
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The pinned Node build: Windows x64, Node 24 (the runtime the repository itself
// runs on). Its `win-x64/node.exe` entry in that release's SHASUMS256.txt is what
// the download is checked against, so a build cannot silently pack something else.
const NODE_VERSION = '24.20.0'
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}`
const NODE_ASSET = 'win-x64/node.exe'

const releaseDir = join(root, 'release')
const cacheDir = join(releaseDir, 'cache')
const buildDir = join(releaseDir, 'build')
const payloadDir = join(buildDir, 'payload')
const publishDir = join(buildDir, 'publish')
const payloadZip = join(buildDir, 'payload.zip')

// The .NET SDK is installed per user and is not on PATH in a fresh shell
// (AGENTS.md), so it is resolved the same way `scripts/run-host.mjs` resolves it.
function findDotnet() {
  const candidates = [
    process.env.WATCHPARTY_DOTNET,
    process.env.DOTNET_ROOT && join(process.env.DOTNET_ROOT, 'dotnet.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'dotnet', 'dotnet.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'dotnet', 'dotnet.exe'),
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    throw new Error('the .NET SDK was not found (AGENTS.md: %LOCALAPPDATA%\\Microsoft\\dotnet\\dotnet.exe)')
  }
  return found
}

function say(line) {
  process.stdout.write(`portable: ${line}\n`)
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) return resolveRun()
      reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}`))
    })
  })
}

// npm is spawned through its own cli script so a `npm.cmd` shell hop (and its
// quoting) is not needed: `npm run portable` exports `npm_execpath`.
function npmRun(args, cwd) {
  const cli = process.env.npm_execpath
  if (cli !== undefined && cli.endsWith('.js')) {
    return run(process.execPath, [cli, ...args], { cwd })
  }
  return run('npm', args, { cwd, shell: process.platform === 'win32' })
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`downloading ${url} failed: HTTP ${response.status}`)
  }
  const partial = `${destination}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  await rename(partial, destination)
}

// `win-x64/node.exe` is published with its own line in SHASUMS256.txt, so the
// binary itself is checked rather than an archive holding it.
async function expectedNodeChecksum() {
  const url = `${NODE_DIST}/SHASUMS256.txt`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${response.status}`)
  const text = await response.text()
  for (const line of text.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/)
    if (name === NODE_ASSET && /^[0-9a-f]{64}$/.test(hash)) return { hash, url }
  }
  throw new Error(`${url} has no line for ${NODE_ASSET}`)
}

async function resolveNode() {
  const override = process.env.WATCHPARTY_NODE_BIN
  if (override !== undefined && override.length > 0) {
    const path = resolve(override)
    if (!existsSync(path)) throw new Error(`WATCHPARTY_NODE_BIN points at ${path}, which does not exist`)
    const hash = await sha256File(path)
    const version = await nodeVersionOf(path)
    return {
      path,
      hash,
      summary: `Node ${version} from WATCHPARTY_NODE_BIN=${path} (sha256 ${hash}; offline build, not checked against SHASUMS256.txt)`,
    }
  }

  const cached = join(cacheDir, `node-v${NODE_VERSION}-win-x64`, 'node.exe')
  const expected = await expectedNodeChecksum()
  if (existsSync(cached)) {
    const cachedHash = await sha256File(cached)
    if (cachedHash === expected.hash) {
      return {
        path: cached,
        hash: cachedHash,
        summary: `Node v${NODE_VERSION} win-x64, sha256 ${cachedHash} (cache hit, matched ${expected.url})`,
      }
    }
    say(`cached node.exe did not match ${expected.url}; downloading it again`)
    await rm(cached, { force: true })
  }

  say(`downloading Node v${NODE_VERSION} win-x64 from ${NODE_DIST}/${NODE_ASSET}`)
  await mkdir(dirname(cached), { recursive: true })
  await download(`${NODE_DIST}/${NODE_ASSET}`, cached)
  const hash = await sha256File(cached)
  if (hash !== expected.hash) {
    await rm(cached, { force: true })
    throw new Error(`node.exe sha256 ${hash} did not match ${expected.hash} from ${expected.url}`)
  }
  return {
    path: cached,
    hash,
    summary: `Node v${NODE_VERSION} win-x64, sha256 ${hash} (verified against ${expected.url})`,
  }
}

function nodeVersionOf(binary) {
  return new Promise((resolveVersion, reject) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    child.stdout.on('data', (chunk) => (text += chunk))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolveVersion(text.trim()) : reject(new Error(`${binary} --version exited ${code}`)),
    )
  })
}

async function listFiles(dir, prefix = '') {
  const found = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await listFiles(join(dir, entry.name), name)))
    else if (entry.isFile()) found.push(name)
  }
  return found.sort()
}

// bsdtar ships with Windows 10+ and zips far faster than Compress-Archive over a
// few thousand `node_modules` files; Compress-Archive is the fallback.
async function zipDirectory(dir, destination) {
  await rm(destination, { force: true })
  try {
    await run('tar', ['-a', '-c', '-f', destination, '-C', dir, '.'])
    return 'tar'
  } catch {
    say('tar could not write the zip; falling back to Compress-Archive')
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${join(dir, '*')}' -DestinationPath '${destination}' -Force`,
    ])
    return 'Compress-Archive'
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = manifest.version
  if (typeof version !== 'string' || version.length === 0) throw new Error('package.json has no version')

  const dotnet = findDotnet()
  say(`dotnet: ${dotnet}`)

  say('[1/5] building the page (npm run build)')
  await npmRun(['run', 'build'], root)
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('npm run build left no dist/index.html')

  say('[2/5] resolving the pinned Node build')
  const node = await resolveNode()
  say(node.summary)

  say('[3/5] packing the payload')
  await rm(payloadDir, { recursive: true, force: true })
  await rm(publishDir, { recursive: true, force: true })
  await mkdir(join(payloadDir, 'src'), { recursive: true })
  await mkdir(join(payloadDir, 'data'), { recursive: true })

  await cp(node.path, join(payloadDir, 'node.exe'))
  // The sidecar runs these sources as they are (Node's type stripping), so the
  // payload carries them unchanged; `player-bridge.js` is served from here too.
  await cp(join(root, 'src', 'server'), join(payloadDir, 'src', 'server'), { recursive: true })
  await cp(join(root, 'src', 'shared'), join(payloadDir, 'src', 'shared'), { recursive: true })
  await cp(join(root, 'dist'), join(payloadDir, 'dist'), { recursive: true })
  await cp(join(root, 'data', 'ad-hosts.txt'), join(payloadDir, 'data', 'ad-hosts.txt'))
  await cp(join(root, 'package.json'), join(payloadDir, 'package.json'))
  await cp(join(root, 'package-lock.json'), join(payloadDir, 'package-lock.json'))

  // Production dependencies only, resolved from the lock into this staging folder:
  // `--omit=dev` keeps the dev tree out of the payload, and `npm ci` never writes
  // to the repository's own `node_modules`.
  await npmRun(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], payloadDir)
  await rm(join(payloadDir, 'package-lock.json'), { force: true })

  const files = await listFiles(payloadDir)
  const lines = []
  for (const file of files) lines.push(`${file}\t${await sha256File(join(payloadDir, file))}`)
  // The payload hash covers the packed contents, not the zip's timestamps: an
  // identical source tree hashes the same, and any real change moves the hash.
  const payloadManifest = `${lines.join('\n')}\n`
  const payloadHash = createHash('sha256').update(payloadManifest).digest('hex')
  const manifestPath = join(buildDir, 'payload-manifest.tsv')
  await writeFile(manifestPath, payloadManifest, 'utf8')

  say(`[3/5] zipping ${files.length} file(s)`)
  const zipper = await zipDirectory(payloadDir, payloadZip)
  say(`[3/5] payload.zip written with ${zipper} (${formatBytes((await stat(payloadZip)).size)})`)

  say('[4/5] publishing the host (win-x64, Release, self-contained, single file)')
  await run(dotnet, [
    'publish',
    join('host', 'WatchParty.Host', 'WatchParty.Host.csproj'),
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true',
    '-p:PublishTrimmed=false',
    `-p:WatchPartyPayload=${payloadZip}`,
    '-o',
    publishDir,
    '--nologo',
  ], { cwd: root })

  say('[5/5] writing the exe')
  const published = join(publishDir, 'WatchParty.Host.exe')
  if (!existsSync(published)) throw new Error(`dotnet publish left no ${published}`)
  const exePath = join(releaseDir, `WatchParty-${version}-portable.exe`)
  await rm(exePath, { force: true })
  await cp(published, exePath)
  const exeSize = (await stat(exePath)).size

  process.stdout.write('\n')
  say(`exe:            ${exePath}`)
  say(`exe size:       ${formatBytes(exeSize)} (${exeSize} bytes)`)
  say(`payload files:  ${files.length}`)
  say(`payload sha256: ${payloadHash}`)
  say(`payload list:   ${manifestPath}`)
  say(`node:           ${node.summary}`)
  say('built with the exe still unproven: running from the payload is ticket 45b')
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

main().catch((error) => {
  process.stderr.write(`portable: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
