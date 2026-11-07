// Dashboard / prep data operations (P4).
import { newId, nowIso } from './assets'
import { supabase } from './supabase'

export async function createLecture(title = 'Untitled lecture'): Promise<string> {
  const id = newId()
  const { error } = await supabase.from('lectures').insert({ id, title })
  if (error) throw error
  return id
}

/** Launch a prepared lecture as a new live session. A lecture can be launched any number of times. */
export async function startSession(lectureId: string): Promise<string> {
  const id = newId()
  const { error } = await supabase.from('sessions').insert({ id, lecture_id: lectureId })
  if (error) throw error
  return id
}

export async function setArchived(lectureId: string, archived: boolean) {
  const { error } = await supabase
    .from('lectures')
    .update({ archived_at: archived ? nowIso() : null })
    .eq('id', lectureId)
  if (error) throw error
}

/** Deletes the lecture, its uploads and (by cascade) all of its past sessions. */
export async function deleteLecture(lectureId: string) {
  const { data: assets } = await supabase.from('assets').select('storage_path').eq('lecture_id', lectureId)
  const paths = (assets ?? []).map((a) => a.storage_path as string | null).filter((p): p is string => !!p)
  if (paths.length) await supabase.storage.from('assets').remove(paths)
  const { error } = await supabase.from('lectures').delete().eq('id', lectureId)
  if (error) throw error
}

export async function deleteSession(sessionId: string) {
  const { error } = await supabase.from('sessions').delete().eq('id', sessionId)
  if (error) throw error
}

export function formatDate(iso: string | null | undefined) {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
