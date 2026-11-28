// The sources the portable payload carries, and the guard that keeps the payload
// equal to what the sidecar imports (T202).
//
// 0.5.0's build packed `src/server` and `src/shared` alone, while
// `src/server/app.ts` imports `src/ui/boot-sentence.ts` (T177/R56), so every
// packaged copy died with ERR_MODULE_NOT_FOUND before it logged a PORT and the
// window could only show its failure page. The build itself was green, so
// nothing before the launch saw it. Two rules replace that hand-written folder
// list:
//
// - the payload carries `src/` as a whole, so no import inside it can be left
//   out by a list that has fallen behind the code;
// - `assertPayloadCarriesSidecarImports` refuses a payload whose file list lacks
//   a file that anything under `src/server` or `src/shared` imports, so a
//   narrowed list fails the build instead of the launch.
//
// `scripts/build-portable.mjs` runs both. `tests/unit/portable-sources.test.ts`
// covers them without building an exe; nothing here writes, downloads or builds.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** The repository folders the payload carries as sources, relative to the repo root. */
export const SOURCE_DIRS = ['src'] as const

/** The folders whose imports the payload must satisfy: the sidecar the payload runs. */
const SIDECAR_DIRS = ['src/server', 'src/shared'] as const

/** A file the payload must carry, and the files that import it. */
export interface ImportedFile {
  file: string
  importedBy: string[]
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

function filesUnder(root: string, dir: string): string[] {
  const found: string[] = []
  const start = join(root, dir)
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), name)
      else if (entry.isFile()) found.push(name)
    }
  }
  walk(start, '')
  return found.sort()
}

/** Every file the payload gets from `SOURCE_DIRS`, as repo-relative posix paths. */
export function payloadSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const dir of SOURCE_DIRS) {
    for (const file of filesUnder(root, dir)) files.push(`${dir}/${file}`)
  }
  return files.sort()
}

// Static `import ... from`, `export ... from`, a bare `import 'x'` and a dynamic
// `import('x')`: the four ways one module names another. Type-only imports count
// too - Node still resolves them when it loads the file - and every specifier in
// this repository carries its `.ts` extension.
const STATIC_FROM = /\bfrom\s*['"](\.[^'"]+)['"]/g
const DYNAMIC = /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g
const BARE = /\bimport\s+['"](\.[^'"]+)['"]/g

/** The repo-relative file a relative specifier names, or null when nothing is there. */
function resolveSpecifier(root: string, importer: string, specifier: string): string | null {
  const base = resolve(root, dirname(importer), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    let found = false
    try {
      found = statSync(candidate).isFile()
    } catch {
      found = false
    }
    if (!found) continue
    const path = toPosix(relative(root, candidate))
    // The payload carries `src/`, not the repository: a specifier that leaves the
    // tree (`../../scripts/x.ts`) is not a payload question.
    if (path.startsWith('..') || isAbsolute(path)) return null
    return path
  }
  return null
}

function specifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of [STATIC_FROM, DYNAMIC, BARE]) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) found.push(match[1])
  }
  return found
}

/**
 * Every repository file imported by anything under `src/server` or `src/shared`,
 * following the relative imports wherever they lead (which is how
 * `src/server/app.ts` pulls in `src/ui/boot-sentence.ts`), with the files that
 * import each one. Specifiers outside the repository are ignored.
 */
export function sidecarImports(root: string): ImportedFile[] {
  const importers = new Map<string, Set<string>>()
  const startPoints: string[] = []
  for (const dir of SIDECAR_DIRS) {
    for (const file of filesUnder(root, dir)) {
      if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mjs')) {
        startPoints.push(`${dir}/${file}`)
      }
    }
  }

  const queue = [...startPoints]
  const seen = new Set(startPoints)
  while (queue.length > 0) {
    const importer = queue.shift() as string
    const source = readFileSync(join(root, importer), 'utf8')
    for (const specifier of specifiers(source)) {
      const target = resolveSpecifier(root, importer, specifier)
      if (target === null) continue
      const who = importers.get(target) ?? new Set<string>()
      who.add(importer)
      importers.set(target, who)
      if (!seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }

  return [...importers.keys()]
    .sort()
    .map((file) => ({ file, importedBy: [...(importers.get(file) as Set<string>)].sort() }))
}

/** The sidecar's imports the payload's file list lacks - empty when it carries them all. */
export function missingSidecarImports(root: string, payloadFiles: readonly string[]): ImportedFile[] {
  const packed = new Set(payloadFiles.map(toPosix))
  return sidecarImports(root).filter((needed) => !packed.has(needed.file))
}

/**
 * Refuse a payload that lacks a file the sidecar imports: the exe would build,
 * launch, log the import error and never print a PORT (T202, 0.5.0).
 */
export function assertPayloadCarriesSidecarImports(
  root: string,
  payloadFiles: readonly string[],
): void {
  const missing = missingSidecarImports(root, payloadFiles)
  if (missing.length === 0) return
  const lines = missing.map((needed) => `${needed.file} (imported by ${needed.importedBy.join(', ')})`)
  throw new Error(
    `the payload is missing ${missing.length} file(s) the sidecar imports: ${lines.join('; ')}`,
  )
}
