import { randomInt } from 'node:crypto'

// §4.1: six characters from an unambiguous alphabet — no O, 0, I or 1.
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6

export function newRoomCode(pick: (max: number) => number = randomInt): string {
  let code = ''
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[pick(ROOM_CODE_ALPHABET.length)]
  }
  return code
}

export function isRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) return false
  for (const character of value) {
    if (!ROOM_CODE_ALPHABET.includes(character)) return false
  }
  return true
}
