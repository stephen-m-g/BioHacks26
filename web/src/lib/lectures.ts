// Dashboard / prep data operations (P4).
import { newId, nowIso } from './assets'
import { copyLectureClassesToSession, setLectureClasses } from './classes'
import { supabase } from './supabase'

/** Creates a lecture, optionally already in some classes (e.g. the dashboard's current class filter). */
export async function createLecture(title = 'Untitled lecture', classIds: string[] = []): Promise<string> {
  const id = newId()
  const { error } = await supabase.from('lectures').insert({ id, title })
  if (error) throw error
  if (classIds.length) await setLectureClasses(id, classIds)
  return id
}

/** Launch a prepared lecture as a new live session. A lecture can be launched any number of times. */
export async function startSession(lectureId: string, title: string | null = null): Promise<string> {
  const id = newId()
  const { error } = await supabase.from('sessions').insert({ id, lecture_id: lectureId, title })
  if (error) throw error
  // The session starts in the lecture's classes. Never block starting class over this.
  await copyLectureClassesToSession(lectureId, id).catch((e) => console.warn('copy classes to session', e))
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
