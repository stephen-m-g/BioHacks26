// Student join codes: the teacher's projected screen shows one while a session is live;
// students type it at /join to follow the board on their phones.
import type { SessionStatus } from '../types'
import { ensureJoinCodeWith, JOIN_CODE_LENGTH, normalizeJoinCode, type JoinCodeStore } from './joinCodeModel'
import { supabase } from './supabase'

export {
  formatJoinCode,
  generateJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  normalizeJoinCode,
} from './joinCodeModel'

const store: JoinCodeStore = {
  claim: (sessionId, code) =>
    supabase
      .from('sessions')
      .update({ join_code: code })
      .eq('id', sessionId)
      .is('join_code', null)
      .select('join_code')
      .maybeSingle(),
  read: (sessionId) => supabase.from('sessions').select('join_code').eq('id', sessionId).maybeSingle(),
}

/**
 * Give a session a join code if it has none yet and return it. Retries on a taken code (up to 5 tries).
 * Never throws: on any other error it warns and returns null, so starting class never breaks over this.
 */
export function ensureJoinCode(sessionId: string): Promise<string | null> {
  return ensureJoinCodeWith(store, sessionId)
}

export interface JoinTarget {
  sessionId: string
  status: SessionStatus
}

/** Postgres "undefined column": the join_codes migration hasn't been run, so no session has a code. */
const NO_JOIN_CODE_COLUMN = '42703'

/** The session a student's code points to, or null if there is none. Throws if the lookup itself failed. */
export async function findSessionByCode(code: string): Promise<JoinTarget | null> {
  const key = normalizeJoinCode(code)
  if (key.length !== JOIN_CODE_LENGTH) return null
  const { data, error } = await supabase.from('sessions').select('id, status').eq('join_code', key).maybeSingle()
  if (error?.code === NO_JOIN_CODE_COLUMN) return null
  if (error) throw new Error(error.message)
  return data ? { sessionId: data.id as string, status: data.status as SessionStatus } : null
}
