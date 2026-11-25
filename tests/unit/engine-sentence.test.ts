// T184, the window that cannot open: the host is .NET and `npm test` does not build it, so
// the two sentences a window with no browser surface shows - and the branch that decides
// between them - are read from the host's own source, exactly as
// `tests/unit/player-bridge.test.ts` reads the bridge it cannot run here.
//
// What this proves, without uninstalling a runtime: a machine with no engine at all keeps
// the missing-runtime wording, an installed engine that will not start says which profile
// folder it could not use and what to do about it, and neither sentence can drift into the
// other's branch.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const sentenceSource = readFileSync(
  new URL('../../host/WatchParty.Host/EngineSentence.cs', import.meta.url),
  'utf8',
)
const formSource = readFileSync(
  new URL('../../host/WatchParty.Host/MainForm.cs', import.meta.url),
  'utf8',
)

/** The text one sentence method builds, from the string literals in its body. */
function wordingOf(method: string) {
  const start = sentenceSource.indexOf(`${method}(`)
  assert.ok(start > -1, `EngineSentence.${method} exists`)
  const next = sentenceSource.indexOf('public static string', start + method.length + 1)
  const body = sentenceSource.slice(start, next === -1 ? sentenceSource.length : next)
  return [...body.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join('')
}

/** The source of one catch block, from its `catch` to the next one. */
function catchBlock(exception: string, anchor = '') {
  const from = anchor === '' ? 0 : formSource.indexOf(anchor)
  assert.ok(from > -1, `MainForm has ${anchor}`)
  const start = formSource.indexOf(`catch (${exception})`, from)
  assert.ok(start > -1, `MainForm catches ${exception} after ${anchor}`)
  const next = formSource.indexOf('catch (', start + 1)
  return formSource.slice(start, Math.min(next === -1 ? formSource.length : next, start + 1400))
}

test('a machine with no engine at all keeps the missing-runtime wording (T184)', () => {
  const missing = wordingOf('MissingRuntime')

  assert.match(missing, /cannot open its browser window/)
  assert.match(missing, /engine is missing/)
  assert.match(missing, /install the WebView2 runtime/)
  assert.doesNotMatch(missing, /profile folder/)
  assert.doesNotMatch(missing, /engine is installed/)
})

test('an installed engine that will not start names the profile folder and what to do (T184)', () => {
  const failed = wordingOf('EngineFailed')

  assert.match(failed, /cannot open its browser window/)
  assert.match(failed, /WebView2 engine is installed/)
  assert.match(failed, /profile folder/)
  assert.match(failed, /Close any other Watch Party window/)
  assert.doesNotMatch(failed, /engine is missing/)
})

test('the missing-runtime sentence is shown only when WebView2 says no engine exists (T184)', () => {
  assert.match(catchBlock('WebView2RuntimeNotFoundException', 'await EnsureViewsAsync();'), /EngineSentence\.MissingRuntime\(\)/)

  const failed = catchBlock('Exception error', 'catch (WebView2RuntimeNotFoundException)')
  assert.match(failed, /EngineSentence\.EngineFailed\(_profileFolder\)/)
  assert.doesNotMatch(failed, /EngineSentence\.MissingRuntime\(\)/)
})

test('a failed start releases its views so the next launch is not refused (T184)', () => {
  const failed = catchBlock('Exception error', 'catch (WebView2RuntimeNotFoundException)')

  assert.match(failed, /ReleaseViews\(\)/)
  assert.ok(
    failed.indexOf('ReleaseViews()') < failed.indexOf('EngineSentence.EngineFailed'),
    'the views are released before the sentence is drawn',
  )
})

test('the developer profile sits beside the Debug binary, not in the temp folder (T184)', () => {
  const start = formSource.indexOf('private static string? ProfileFolder()')
  assert.ok(start > -1, 'MainForm has ProfileFolder')
  const next = formSource.indexOf('private async Task EnsureViewsAsync()', start)
  assert.ok(next > start, 'ProfileFolder ends before EnsureViewsAsync')
  const body = formSource.slice(start, next)

  assert.match(body, /AppContext\.BaseDirectory/)
  assert.match(body, /profile-dev-/)
  assert.doesNotMatch(body, /GetTempPath/)
})
