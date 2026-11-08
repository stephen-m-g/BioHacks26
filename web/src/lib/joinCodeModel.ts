// Pure join-code logic with no Supabase import, so node tests can load it. lib/joinCode.ts binds it to Supabase.

/** No 0/O/1/I/L, so a code read off a projector can't be mistyped. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const JOIN_CODE_LENGTH = 6
/** Fresh codes to try when one is already taken. */
export const JOIN_CODE_TRIES = 5

const UNIQUE_VIOLATION = '23505'

export function generateJoinCode(): string {
  const values = crypto.getRandomValues(new Uint32Array(JOIN_CODE_LENGTH))
  return Array.from(values, (v) => JOIN_CODE_ALPHABET[v % JOIN_CODE_ALPHABET.length]).join('')
}

/** What a student typed, as a lookup key: uppercase, letters and digits only, at most 6 characters. */
export function normalizeJoinCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, JOIN_CODE_LENGTH)
}

/** "ABC123" → "ABC 123", easier to read off a projector. */
export function formatJoinCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

export interface DbResult<T> {
  data: T | null
  error: { code?: string; message: string } | null
}

/** The two queries ensureJoinCode needs, so tests can fake them. */
export interface JoinCodeStore {
  /** Set the code only if the session has none yet. data is the changed row, or null if nothing changed. */
  claim(sessionId: string, code: string): PromiseLike<DbResult<{ join_code: string | null }>>
  /** Read the session's current code. */
  read(sessionId: string): PromiseLike<DbResult<{ join_code: string | null }>>
}

/**
 * Give the session a join code if it has none, and return its code.
 * Never throws: any failure (including a database without the join_code column) returns null.
 */
export async function ensureJoinCodeWith(
  store: JoinCodeStore,
  sessionId: string,
  generate: () => string = generateJoinCode,
): Promise<string | null> {
  try {
    for (let attempt = 0; attempt < JOIN_CODE_TRIES; attempt++) {
      const claimed = await store.claim(sessionId, generate())
      if (claimed.error?.code === UNIQUE_VIOLATION) continue // another session has this code
      if (claimed.error) {
        console.warn('Join code not set:', claimed.error.message)
        return null
      }
      if (claimed.data?.join_code) return claimed.data.join_code
      // Nothing changed: the session already has a code (e.g. another tab set it first).
      const existing = await store.read(sessionId)
      if (existing.error) {
        console.warn('Join code not read:', existing.error.message)
        return null
      }
      return existing.data?.join_code ?? null
    }
    console.warn(`Join code not set: ${JOIN_CODE_TRIES} codes in a row were already taken`)
    return null
  } catch (e) {
    console.warn('Join code not set:', e)
    return null
  }
}
