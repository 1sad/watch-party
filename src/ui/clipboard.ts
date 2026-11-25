/**
 * T177 / R51: the two clipboard calls, guarded.
 *
 * `navigator.clipboard` is **undefined** on a plain `http://` page - which is
 * exactly what a browser guest at the LAN address is served - and a browser may
 * refuse a read or a write even when it is there. Neither call may claim
 * something happened that did not: this module returns the outcome as data, so
 * the page's Copy button only shows "Copied" for a write that resolved, and the
 * Paste button says why it could not read instead of blaming the window.
 *
 * The presence check is the pattern `identity.ts` uses for `crypto.randomUUID`:
 * look the API up, then use it, rather than calling into it and catching a
 * `TypeError` that says nothing to the person reading the page.
 */

/** The two forms an invitation is offered in (R51, ADR-054). */
export type InviteForm = 'app' | 'browser'

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
  /** The form whose text was copied, or `null` when nothing was. */
  copied: InviteForm | null
  /** The sentence to show when the copy did not happen; `null` when it did. */
  notice: string | null
}

/**
 * Copies one invitation, and says whether it did. A missing API and a rejected
 * write are the same outcome for the page: a refusal, and no copied state.
 */
export async function copyTextToClipboard(
  form: InviteForm,
  text: string,
  api: ClipboardApi | null = browserClipboard(),
): Promise<CopyResult> {
  const write = api?.writeText
  if (typeof write !== 'function') return { copied: null, notice: COPY_REFUSED }
  try {
    await write.call(api, text)
    return { copied: form, notice: null }
  } catch {
    return { copied: null, notice: COPY_REFUSED }
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
