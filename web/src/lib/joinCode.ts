// 6-character join code without the ambiguous characters 0, O, 1, I.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function makeJoinCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}
