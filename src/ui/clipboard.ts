/**
 * T177 / R51, T185 / ADR-056: the two clipboard calls, guarded.
 *
 * `navigator.clipboard` is **undefined** on a plain `http://` page - which is
 * exactly what a browser guest at the LAN address is served - and a browser may
 * refuse a read or a write even when it is there. Neither call may claim
 * something happened that did not: this module returns the outcome as data, so
 * the page's one Invite button only says "Copied" for a write that resolved, and
 * the Paste button says why it could not read instead of blaming the window.
 *
 * ADR-056 leaves one invitation and one button, so a copy is a yes or a no
 * (`copied: boolean`); ticket 177's per-form state went with its two forms.
 *
 * The presence check is the pattern `identity.ts` uses for `crypto.randomUUID`:
 * look the API up, then use it, rather than calling into it and catching a
 * `TypeError` that says nothing to the person reading the page.
 */

/** What a Copy that could not copy says: it points at the address on screen. */
export const COPY_REFUSED =
  'This browser will not let the page copy. Select the address shown and copy it by hand.'

/** What a Paste that could not read says. Never "this window": a browser guest has no window host. */
export const PASTE_REFUSED =
  'This browser will not let the page read the clipboard. Press Ctrl+V in the field instead.'

/** The part of `navigator.clipboard` this page uses, as it may be absent or throw. */
export interface ClipboardApi {
  writeText?: (text: string) => Promise<void>
  readText?: () => Promise<string>
}

/** The real clipboard, or `null` on a page where the browser does not define one. */
export function browserClipboard(): ClipboardApi | null {
  const navigatorLike = (globalThis as { navigator?: { clipboard?: unknown } }).navigator
  const clipboard = navigatorLike?.clipboard
  return typeof clipboard === 'object' && clipboard !== null ? (clipboard as ClipboardApi) : null
}

export interface CopyResult {
  /** Whether the text was written; only true may put "Copied" on the button. */
  copied: boolean
  /** The sentence to show when the copy did not happen; `null` when it did. */
  notice: string | null
}

/**
 * Copies the invitation, and says whether it did. A missing API and a rejected
 * write are the same outcome for the page: a refusal, and no copied state.
 */
export async function copyTextToClipboard(
  text: string,
  api: ClipboardApi | null = browserClipboard(),
): Promise<CopyResult> {
  const write = api?.writeText
  if (typeof write !== 'function') return { copied: false, notice: COPY_REFUSED }
  try {
    await write.call(api, text)
    return { copied: true, notice: null }
  } catch {
    return { copied: false, notice: COPY_REFUSED }
  }
}

export type PasteResult =
  | { text: string; notice: null }
  | { text: null; notice: string }

/**
 * Reads the clipboard, and says whether it did. An empty clipboard is a
 * successful read of empty text; the page decides what to say about that.
 */
export async function readTextFromClipboard(
  api: ClipboardApi | null = browserClipboard(),
): Promise<PasteResult> {
  const read = api?.readText
  if (typeof read !== 'function') return { text: null, notice: PASTE_REFUSED }
  try {
    return { text: await read.call(api), notice: null }
  } catch {
    return { text: null, notice: PASTE_REFUSED }
  }
}
