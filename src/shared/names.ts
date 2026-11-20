/**
 * Names, and the one rule that makes them unique on screen (§4.1, R26).
 *
 * A member stores what was typed (trimmed) or `null`. What the roster shows is
 * derived from the whole member list every time, so "sam (2)" becomes "sam"
 * again the moment the first sam clears their name — no stored suffix to undo.
 */

export const ANONYMOUS = 'anonymous'

/** Blank, absent or not a string is `null`, which renders as `anonymous` (R26). */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

export interface NamedMember {
  id: string
  name: string | null
  joinedAt: number
}

/**
 * One label per member: `null` → `anonymous`, and the nth member with the same
 * label gets " (n)". Order is join order, tie-broken by id, so every replica
 * computes the same labels from the same list.
 */
export function displayNames(members: readonly NamedMember[]): Map<string, string> {
  const ordered = [...members].sort(
    (left, right) =>
      left.joinedAt - right.joinedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  )

  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const member of ordered) {
    const base = normalizeName(member.name) ?? ANONYMOUS
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    labels.set(member.id, count === 1 ? base : `${base} (${count})`)
  }
  return labels
}
