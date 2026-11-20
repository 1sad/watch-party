import { randomInt } from 'node:crypto'

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './room-code.ts'

// The shape lives in room-code.ts, which the page can import: generating a code
// needs `node:crypto`, and nothing in the browser does (the page only reads one).
export { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isRoomCode } from './room-code.ts'

export function newRoomCode(pick: (max: number) => number = randomInt): string {
  let code = ''
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[pick(ROOM_CODE_ALPHABET.length)]
  }
  return code
}
