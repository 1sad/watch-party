import type { DiscoveryKind } from './discovery.ts'

export interface InviteInput {
  kind: DiscoveryKind
  externalIp?: string
  mappedPort: number | null
  lanIp: string | null
  localPort: number
  code: string
}

export interface InviteLinks {
  /** The `watchparty://` form the copy button copies (T2 item 5). */
  primary: string
  /** The raw HTTP form, shown as selectable text: the fallback, not the instruction. */
  raw: string
  /** The same-network form, always shown because that evening always works. */
  lanRaw: string | null
}

export function buildInviteLinks(input: InviteInput): InviteLinks | null {
  const lanRaw =
    input.lanIp === null ? null : `http://${input.lanIp}:${input.localPort}/join?c=${input.code}`

  // Only an `ok` verdict has an address a guest outside can dial. Every other
  // state falls back to the same network, which the listener always serves.
  if (input.kind === 'ok' && input.externalIp !== undefined && input.mappedPort !== null) {
    return {
      primary: `watchparty://join?h=${input.externalIp}&p=${input.mappedPort}&c=${input.code}`,
      raw: `http://${input.externalIp}:${input.mappedPort}/join?c=${input.code}`,
      lanRaw,
    }
  }

  if (input.lanIp === null) return null
  return {
    primary: `watchparty://join?h=${input.lanIp}&p=${input.localPort}&c=${input.code}`,
    raw: lanRaw as string,
    lanRaw,
  }
}
