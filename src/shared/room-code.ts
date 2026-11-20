/**
 * The shape of a room code (`spec.md` §4.1), apart from the generator so the
 * page can check a pasted link without pulling `node:crypto` into the browser.
 */

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6

export function isRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) return false
  for (const character of value) {
    if (!ROOM_CODE_ALPHABET.includes(character)) return false
  }
  return true
}
