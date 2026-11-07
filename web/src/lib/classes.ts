// Classes: named, colored groupings for lectures and sessions (many-to-many).
import type { ClassGroup } from '../types'
import { newId } from './assets'
import { supabase } from './supabase'

/** Distinct, saturated colors that read on the light dashboard background (each ≥ 3:1 against it). */
export const CLASS_COLORS = [
  '#2563eb', // blue
  '#dc2626', // red
  '#16a34a', // green
  '#d97706', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#db2777', // pink
  '#4b5563', // slate
] as const

export const COLOR_NAMES: Record<string, string> = {
  '#2563eb': 'Blue',
  '#dc2626': 'Red',
  '#16a34a': 'Green',
  '#d97706': 'Amber',
  '#7c3aed': 'Violet',
  '#0891b2': 'Cyan',
  '#db2777': 'Pink',
  '#4b5563': 'Slate',
}

/** The first palette color no class uses yet (cycles once all are taken). */
export function nextClassColor(existing: ClassGroup[]): string {
  const used = new Set(existing.map((c) => c.color))
  return CLASS_COLORS.find((c) => !used.has(c)) ?? CLASS_COLORS[existing.length % CLASS_COLORS.length]
}

export async function listClasses(): Promise<ClassGroup[]> {
  const { data, error } = await supabase.from('classes').select('*').order('created_at')
  if (error) throw error
  return (data as ClassGroup[]) ?? []
}

export async function createClass(name: string, color: string): Promise<ClassGroup> {
  const { data, error } = await supabase.from('classes').insert({ id: newId(), name, color }).select().single()
  if (error) throw error
  return data as ClassGroup
}

export async function updateClass(id: string, patch: Partial<Pick<ClassGroup, 'name' | 'color'>>) {
  const { error } = await supabase.from('classes').update(patch).eq('id', id)
  if (error) throw error
}

/** Removes the class from every lecture and session (by cascade); the lectures and sessions stay. */
export async function deleteClass(id: string) {
  const { error } = await supabase.from('classes').delete().eq('id', id)
  if (error) throw error
}

type LinkTable = 'lecture_classes' | 'session_classes'
const ownerColumn = { lecture_classes: 'lecture_id', session_classes: 'session_id' } as const

/** Make `ownerId` belong to exactly `classIds` (adds and removes links as needed). */
async function setLinks(table: LinkTable, ownerId: string, classIds: string[]) {
  const col = ownerColumn[table]
  const { data, error } = await supabase.from(table).select('class_id').eq(col, ownerId)
  if (error) throw error
  const current = new Set((data ?? []).map((r) => r.class_id as string))
  const wanted = new Set(classIds)
  const toAdd = classIds.filter((id) => !current.has(id))
  const toRemove = [...current].filter((id) => !wanted.has(id))
  if (toAdd.length) {
    const res = await supabase.from(table).insert(toAdd.map((class_id) => ({ [col]: ownerId, class_id })))
    if (res.error) throw res.error
  }
  if (toRemove.length) {
    const res = await supabase.from(table).delete().eq(col, ownerId).in('class_id', toRemove)
    if (res.error) throw res.error
  }
}

export const setLectureClasses = (lectureId: string, classIds: string[]) => setLinks('lecture_classes', lectureId, classIds)
export const setSessionClasses = (sessionId: string, classIds: string[]) => setLinks('session_classes', sessionId, classIds)

/** A new session starts in the same classes as its lecture. */
export async function copyLectureClassesToSession(lectureId: string, sessionId: string) {
  const { data, error } = await supabase.from('lecture_classes').select('class_id').eq('lecture_id', lectureId)
  if (error) throw error
  const rows = (data ?? []).map((r) => ({ session_id: sessionId, class_id: r.class_id as string }))
  if (rows.length) {
    const res = await supabase.from('session_classes').insert(rows)
    if (res.error) throw res.error
  }
}
