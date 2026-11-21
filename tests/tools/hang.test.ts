/**
 * T12's proof, and nothing else: a test that never finishes.
 *
 * It is deliberately **not** in a suite. `npm test` reads `tests/unit/*.test.ts`
 * and `npm run test:integration` reads `tests/integration/*.test.ts`, so neither
 * command picks this file up and the committed suites pay nothing for it.
 *
 * It reproduces the phase-1 shape rather than a tidy `await new Promise(() => {})`:
 * a test that never resolves *and* has already spawned a node process that would
 * outlive it on Windows. That pair is what makes `--test-timeout` alone not
 * enough — the runner waits forever for the leaked handle — and it is what
 * `--test-force-exit` (package.json) is there for.
 *
 * Run the proof by copying this file into the suite you are checking, so the
 * real bounded command sees it:
 *
 *   copy tests/tools/hang.test.ts tests/unit/zz-t12-hang.test.ts
 *   npm test                      # non-zero in ~10 s, naming this test
 *   del tests/unit/zz-t12-hang.test.ts
 *
 * The same recipe with `tests/integration` proves the integration bound (~45 s).
 * Delete the copy afterwards: it is a proof, not a test.
 */

import { spawn } from 'node:child_process'
import { test } from 'node:test'

test('T12: a test that never finishes, with a spawned child still running', async () => {
  // The sidecar the phase-1 incident leaked: an assertion threw before its
  // `finally`, so nothing ever killed this. On Windows it outlives its parent.
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
  // Nothing resolves this, and nothing but the runner's bound ends it.
  await new Promise<void>(() => {})
})
