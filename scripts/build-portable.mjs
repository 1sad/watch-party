// Builds the portable executable (M7, ADR-041/ADR-042): one file carrying the
// .NET runtime, a pinned Node build, the sidecar's sources with their production
// dependencies, the built page and the ad list, plus one embedded zip payload.
//
// Nothing here changes what the app does: the sidecar still runs its TypeScript
// through Node's type stripping from `src/server/main.ts`, and computes `dist/`,
// the bridge script and `package.json` from its own module URL (ADR-042), so the
// payload is laid out exactly like the repository those paths expect.
//
// Usage: `npm run portable`       (output: release/WatchParty-<version>-portable.exe)
//        `npm run portable:full`  (the same plus a pinned fixed WebView2 runtime, ADR-041)
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

// The fixed WebView2 runtime `portable-full` carries (ADR-041: two builds, so the
// engine assumption is measured rather than assumed). The version is PINNED, the
// x64 cab URL is the one Microsoft's download page publishes for it (fetched
// 2026-11-22), and the cab's size and sha256 are pinned too: a substituted,
// truncated or re-served file fails the build here, before it can travel to a
// friend. Microsoft's own page says the fixed package is 250 MB or more.
const WEBVIEW2_VERSION = '158.0.4370.33'
const WEBVIEW2_CAB = {
  url: 'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/'
    + 'ecc2761e-1380-46ee-9552-995b039e4e47/Microsoft.WebView2.FixedVersionRuntime.158.0.4370.33.x64.cab',
  bytes: 437849994,
  sha256: '835da387df67797f710881f553bb6934d98f24d08e370456f48d38ed4e072b62',
}

const releaseDir = join(root, 'release')
const cacheDir = join(releaseDir, 'cache')
const buildDir = join(releaseDir, 'build')
const payloadDir = join(buildDir, 'payload')
const publishDir = join(buildDir, 'publish')
const payloadZip = join(buildDir, 'payload.zip')
const webviewDir = join(cacheDir, 'webview2', WEBVIEW2_VERSION)
const webviewCab = join(webviewDir, `Microsoft.WebView2.FixedVersionRuntime.${WEBVIEW2_VERSION}.x64.cab`)
const webviewExtractDir = join(buildDir, 'webview2')

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

// Runs a command and hands back its stdout; a non-zero exit carries the command's
// own words, because `expand`'s failure is the useful part of a failed build.
function capture(command, args) {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) return resolveCapture(out)
      reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${(err.trim() || out.trim()).slice(0, 2000)}`))
    })
  })
}

// The engine folder Microsoft means is the one holding msedgewebview2.exe - one
// level inside what `expand` produces, because the cab carries a product folder.
async function findEngineFolder(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some((entry) => entry.isFile() && entry.name === 'msedgewebview2.exe')) return dir
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findEngineFolder(join(dir, entry.name))
    if (found !== null) return found
  }
  return null
}

// The pinned fixed WebView2 runtime, for `portable-full` only. Cached under
// release/cache/, checked by size AND sha256 (both pinned above), unpacked with
// Microsoft's `expand -F:*` (never Explorer, which can produce the wrong folder
// shape), and checked once more by reading the version out of the engine binary:
// a substituted version fails here rather than shipping.
async function resolveFixedEngine() {
  await mkdir(webviewDir, { recursive: true })

  const cached = existsSync(webviewCab) ? (await stat(webviewCab)).size : -1
  if (cached !== WEBVIEW2_CAB.bytes) {
    if (cached !== -1) {
      say(`cached fixed runtime cab is ${cached} bytes, not the pinned ${WEBVIEW2_CAB.bytes}; downloading it again`)
    }
    say(`downloading the fixed WebView2 runtime ${WEBVIEW2_VERSION} x64 from ${WEBVIEW2_CAB.url}`)
    try {
      await download(WEBVIEW2_CAB.url, webviewCab)
    } catch (error) {
      await rm(webviewCab, { force: true })
      throw new Error(
        `the fixed WebView2 runtime ${WEBVIEW2_VERSION} could not be downloaded from ${WEBVIEW2_CAB.url}: `
          + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  const bytes = (await stat(webviewCab)).size
  if (bytes !== WEBVIEW2_CAB.bytes) {
    await rm(webviewCab, { force: true })
    throw new Error(
      `the fixed WebView2 runtime cab is ${bytes} bytes, not the pinned ${WEBVIEW2_CAB.bytes}: ${WEBVIEW2_CAB.url}`,
    )
  }

  const hash = await sha256File(webviewCab)
  if (hash !== WEBVIEW2_CAB.sha256) {
    await rm(webviewCab, { force: true })
    throw new Error(
      `the fixed WebView2 runtime cab has sha256 ${hash}, not the pinned ${WEBVIEW2_CAB.sha256}: ${WEBVIEW2_CAB.url}`,
    )
  }
  say(`fixed WebView2 runtime cab: ${WEBVIEW2_CAB.bytes} bytes, sha256 ${hash} (matches the pin)`)

  await rm(webviewExtractDir, { recursive: true, force: true })
  await mkdir(webviewExtractDir, { recursive: true })
  await capture('expand', [webviewCab, '-F:*', webviewExtractDir])

  const folder = await findEngineFolder(webviewExtractDir)
  if (folder === null) throw new Error(`expanding ${webviewCab} produced no msedgewebview2.exe`)
  const version = (
    await capture('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Item -LiteralPath '${join(folder, 'msedgewebview2.exe')}').VersionInfo.FileVersion`,
    ])
  ).trim()
  if (version !== WEBVIEW2_VERSION) {
    throw new Error(`the unpacked engine reports version ${version}, not the pinned ${WEBVIEW2_VERSION}`)
  }

  return {
    folder,
    version,
    bytes,
    hash,
    files: (await listFiles(folder)).length,
    summary:
      `fixed WebView2 runtime ${version} x64, cab ${formatBytes(bytes)} (${bytes} bytes), sha256 ${hash}, `
      + `from ${WEBVIEW2_CAB.url}`,
  }
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
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--full')
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')} (only --full is understood)`)
  const full = process.argv.includes('--full')
  const flavour = full ? 'portable-full' : 'portable'

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = manifest.version
  if (typeof version !== 'string' || version.length === 0) throw new Error('package.json has no version')

  const dotnet = findDotnet()
  say(`flavour:        ${flavour}${full ? ` (carries fixed WebView2 ${WEBVIEW2_VERSION})` : ' (uses the machine\'s WebView2 runtime)'}`)
  say(`dotnet: ${dotnet}`)

  say('[1/5] building the page (npm run build)')
  await npmRun(['run', 'build'], root)
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('npm run build left no dist/index.html')

  say('[2/5] resolving the pinned build assets')
  const node = await resolveNode()
  say(node.summary)
  const engine = full ? await resolveFixedEngine() : null
  if (engine !== null) say(engine.summary)

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

  if (engine !== null) {
    // ADR-041/ADR-042: the unpacked fixed runtime travels inside the payload, laid out
    // as `webview2\msedgewebview2.exe` at the program root - the folder the host names
    // to the engine as BrowserExecutableFolder.
    say(`[3/5] adding the fixed WebView2 runtime ${engine.version} (${engine.files} file(s))`)
    await cp(engine.folder, join(payloadDir, 'webview2'), { recursive: true })
  }

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
  // T46d, measured 2026-11-22 (ADR-043): IncludeNativeLibrariesForSelfExtract is
  // what keeps this ONE file, and it is also the one thing a copy leaves outside
  // its folder. The .NET loader extracts the bundled native libraries to
  // %TEMP%\.net\<exe name>\<bundle id>\ BEFORE Main runs, so no host code can
  // redirect it; only a variable in the launching process can
  // (DOTNET_BUNDLE_EXTRACT_BASE_DIR, Microsoft's single-file page), and setting
  // that needs a second file to launch from. Measured for this host: exactly two
  // files, both WebView2Loader.dll, 194912 bytes each (389824 bytes per build),
  // written on a copy's first run and reused by every later run (five runs, 0 new
  // entries after the first), never pruned, and gone only when Windows clears
  // %TEMP%. The alternative - the native libraries beside the exe - was measured
  // at one extra file for this host (WebView2Loader.dll, 194912 bytes; publishing
  // with IncludeNativeLibrariesForSelfExtract=false puts nothing else beside the
  // exe but its .pdb and three .xml files). "One file" is the user's promise
  // (ADR-041), so the shape is not this build's to trade: ticket 46d records the
  // %TEMP% extraction as the one documented exception instead.
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
  const exePath = join(releaseDir, `WatchParty-${version}-${flavour}.exe`)
  await rm(exePath, { force: true })
  await cp(published, exePath)
  const exeSize = (await stat(exePath)).size

  process.stdout.write('\n')
  say(`flavour:        ${flavour}`)
  say(`exe:            ${exePath}`)
  say(`exe size:       ${formatBytes(exeSize)} (${exeSize} bytes)`)
  say(`payload files:  ${files.length}`)
  say(`payload sha256: ${payloadHash}`)
  say(`payload list:   ${manifestPath}`)
  say(`node:           ${node.summary}`)
  say(`webview2:       ${engine === null ? 'not carried (uses the machine\'s runtime)' : engine.summary}`)
  say('note:           run 1 of a copy writes %TEMP%\\.net\\<exe name>\\<bundle id>\\ - 2 x WebView2Loader.dll, 389824 bytes -')
  say('                the one documented exception to ADR-043 (T46d, measured 2026-11-22)')
  say('built with the exe still unproven: running from the payload is ticket 45b')
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

main().catch((error) => {
  process.stderr.write(`portable: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
