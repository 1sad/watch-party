/**
 * T177 / R51, T185 / ADR-056: a copy that cannot copy says so, and never shows
 * a copied state.
 *
 * `navigator.clipboard` is undefined on a plain `http://` page (a browser guest
 * at the LAN address), and a browser may reject a write it does define. Both
 * outcomes are the same to the page: `copied` stays false and the refusal
 * sentence is returned. `App.svelte` writes its state from this result and puts
 * "Copied" on the button only when `copied` is true.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COPY_REFUSED,
  PASTE_REFUSED,
  copyTextToClipboard,
  readTextFromClipboard,
} from '../../src/ui/clipboard.ts'

test('a copy with no clipboard API reports a refusal and never sets the copied state', async () => {
  const result = await copyTextToClipboard('http://192.168.10.44:52341/join?c=ABC234', null)
  assert.equal(result.copied, false, 'nothing was copied, so no button may show "Copied"')
  assert.equal(result.notice, COPY_REFUSED)
})

test('a clipboard that rejects is the same refusal, and never sets the copied state', async () => {
  const refused = {
    writeText: async (): Promise<void> => {
      throw new Error('NotAllowedError')
    },
  }
  const result = await copyTextToClipboard('http://192.168.10.44:52341/join?c=ABC234', refused)
  assert.equal(result.copied, false)
  assert.equal(result.notice, COPY_REFUSED)
})

test('a copy the browser accepts says it copied and carries the text verbatim', async () => {
  let written: string | null = null
  const clipboard = {
    writeText: async (text: string): Promise<void> => {
      written = text
    },
  }
  const result = await copyTextToClipboard('http://192.168.10.44:52341/join?c=ABC234', clipboard)
  assert.deepEqual(result, { copied: true, notice: null })
  assert.equal(written, 'http://192.168.10.44:52341/join?c=ABC234')
})

test('a paste with no clipboard API says the browser refused, not "this window"', async () => {
  const result = await readTextFromClipboard(null)
  assert.equal(result.text, null)
  assert.equal(result.notice, PASTE_REFUSED)
  assert.ok(!PASTE_REFUSED.includes('this window'), 'a browser guest has no window to blame')
})

test('a clipboard read that rejects is the same sentence', async () => {
  const refused = {
    readText: async (): Promise<string> => {
      throw new Error('NotAllowedError')
    },
  }
  const result = await readTextFromClipboard(refused)
  assert.equal(result.text, null)
  assert.equal(result.notice, PASTE_REFUSED)
})

test('an empty clipboard is a successful read of empty text, not a refusal', async () => {
  const empty = { readText: async (): Promise<string> => '' }
  assert.deepEqual(await readTextFromClipboard(empty), { text: '', notice: null })
})
