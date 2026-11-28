// T202: the portable payload carries every file the sidecar imports.
//
// The 0.5.0 build packed `src/server` and `src/shared` alone, while
// `src/server/app.ts` imports `src/ui/boot-sentence.ts` (T177/R56), so every
// packaged copy died with ERR_MODULE_NOT_FOUND before it logged a PORT - and the
// build stayed green, because nothing before the launch read the payload's file
// list against the import graph. This covers that guard over the real repository,
// with no exe built: the payload's source list (what `npm run portable` copies),
// the import graph of `src/server` and `src/shared`, and the refusal a narrowed
// list earns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  assertPayloadCarriesSidecarImports,
  missingSidecarImports,
  payloadSourceFiles,
  sidecarImports,
} from '../../scripts/portable-sources.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

test('the payload carries every file the sidecar imports (T202)', () => {
  const missing = missingSidecarImports(ROOT, payloadSourceFiles(ROOT))

  assert.deepEqual(missing, [], 'no file imported under src/server or src/shared is left out')
  assert.doesNotThrow(() => assertPayloadCarriesSidecarImports(ROOT, payloadSourceFiles(ROOT)))
})

test('the graph names the file the 0.5.0 payload left out (T202)', () => {
  const needed = sidecarImports(ROOT).find((entry) => entry.file === 'src/ui/boot-sentence.ts')

  assert.ok(needed, 'src/ui/boot-sentence.ts is an import of the sidecar')
  assert.deepEqual(needed.importedBy, ['src/server/app.ts'], 'imported by src/server/app.ts')
})

test('the guard refuses the 0.5.0 folder list: src/server and src/shared alone (T202)', () => {
  const packed = payloadSourceFiles(ROOT).filter(
    (file) => file.startsWith('src/server/') || file.startsWith('src/shared/'),
  )

  assert.throws(
    () => assertPayloadCarriesSidecarImports(ROOT, packed),
    /missing \d+ file\(s\) the sidecar imports: .*src\/ui\/boot-sentence\.ts \(imported by src\/server\/app\.ts\)/,
  )
})

test('the guard refuses a payload with one needed file removed (T202)', () => {
  const packed = payloadSourceFiles(ROOT).filter((file) => file !== 'src/ui/boot-sentence.ts')
  const missing = missingSidecarImports(ROOT, packed)

  assert.deepEqual(missing.map((entry) => entry.file), ['src/ui/boot-sentence.ts'])
  assert.throws(
    () => assertPayloadCarriesSidecarImports(ROOT, packed),
    /src\/ui\/boot-sentence\.ts \(imported by src\/server\/app\.ts\)/,
  )
})
