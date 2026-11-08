// Loads everything for one session and keeps it live through Supabase Realtime.
// Used by the teacher, raw and notes views.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Annotation, Asset, Block, Lecture, Session, Stroke, TranscriptSegment } from '../types'
import { compareTranscriptSegments } from './transcriptionModel'

export type RowTable = 'blocks' | 'strokes' | 'annotations' | 'transcript_segments'
export interface RowOf {
  blocks: Block
  strokes: Stroke
  annotations: Annotation
  transcript_segments: TranscriptSegment
}

const TABLES: RowTable[] = ['blocks', 'strokes', 'annotations', 'transcript_segments']

export interface SessionDataState {
  loading: boolean
  error: string | null
  session: Session | null
  lecture: Lecture | null
  assets: Record<string, Asset>
  blocks: Record<string, Block>
  strokes: Record<string, Stroke>
  annotations: Record<string, Annotation>
  transcript_segments: Record<string, TranscriptSegment>
}

const EMPTY: SessionDataState = {
  loading: true,
  error: null,
  session: null,
  lecture: null,
  assets: {},
  blocks: {},
  strokes: {},
  annotations: {},
  transcript_segments: {},
}

function byId<T extends { id: string }>(rows: T[] | null | undefined): Record<string, T> {
  return Object.fromEntries((rows ?? []).map((r) => [r.id, r]))
}

export function useSessionData(sessionId: string | undefined) {
  const [state, setState] = useState<SessionDataState>(EMPTY)

  /** Insert or merge a row locally (optimistic updates and realtime echoes both land here). */
  const upsert = useCallback(<T extends RowTable>(table: T, row: Partial<RowOf[T]> & { id: string }) => {
    setState((s) => {
      const current = s[table] as Record<string, RowOf[T]>
      return { ...s, [table]: { ...current, [row.id]: { ...current[row.id], ...row } } } as SessionDataState
    })
  }, [])

  const remove = useCallback((table: RowTable, id: string) => {
    setState((s) => {
      if (!s[table][id]) return s
      const next = { ...s[table] }
      delete next[id]
      return { ...s, [table]: next } as SessionDataState
    })
  }, [])

  const patchSession = useCallback((patch: Partial<Session>) => {
    setState((s) => (s.session ? { ...s, session: { ...s.session, ...patch } } : s))
  }, [])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    async function load() {
      const { data: session, error } = await supabase.from('sessions').select('*').eq('id', sessionId).maybeSingle()
      if (cancelled) return
      if (error || !session) {
        setState((s) => ({ ...s, loading: false, error: error?.message ?? 'Session not found' }))
        return
      }
      const [lecture, assets, blocks, strokes, annotations, segments] = await Promise.all([
        supabase.from('lectures').select('*').eq('id', session.lecture_id).maybeSingle(),
        supabase.from('assets').select('*').eq('lecture_id', session.lecture_id).order('created_at'),
        supabase.from('blocks').select('*').eq('session_id', sessionId),
        supabase.from('strokes').select('*').eq('session_id', sessionId),
        supabase.from('annotations').select('*').eq('session_id', sessionId),
        supabase.from('transcript_segments').select('*').eq('session_id', sessionId),
      ])
      if (cancelled) return
      // Rows that arrived over realtime while loading win over the snapshot.
      setState((s) => ({
        loading: false,
        error: null,
        session: s.session ?? (session as Session),
        lecture: lecture.data as Lecture | null,
        assets: byId(assets.data as Asset[]),
        blocks: { ...byId(blocks.data as Block[]), ...s.blocks },
        strokes: { ...byId(strokes.data as Stroke[]), ...s.strokes },
        annotations: { ...byId(annotations.data as Annotation[]), ...s.annotations },
        transcript_segments: { ...byId(segments.data as TranscriptSegment[]), ...s.transcript_segments },
      }))
    }

    const channel = supabase.channel(`session:${sessionId}`)
    for (const table of TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `session_id=eq.${sessionId}` }, (p) => {
        if (p.eventType === 'DELETE') remove(table, (p.old as { id: string }).id)
        else upsert(table, p.new as RowOf[typeof table])
      })
      // Realtime does not apply filters to DELETE events, so listen unfiltered; unknown ids are ignored.
      channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (p) =>
        remove(table, (p.old as { id: string }).id),
      )
    }
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, (p) =>
      patchSession(p.new as Session),
    )
    channel.subscribe()
    load()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [sessionId, upsert, remove, patchSession])

  const derived = useMemo(() => {
    const blocks = Object.values(state.blocks).sort((a, b) => a.position - b.position)
    const strokes = Object.values(state.strokes).sort((a, b) => a.created_at.localeCompare(b.created_at))
    const annotations = Object.values(state.annotations)
    const segments = Object.values(state.transcript_segments).sort(compareTranscriptSegments)
    const imageAssets = Object.values(state.assets).filter((a) => a.kind === 'image')
    return { blockList: blocks, strokeList: strokes, annotationList: annotations, segmentList: segments, imageAssets }
  }, [state])

  return { ...state, ...derived, upsert, remove, patchSession }
}

export type SessionData = ReturnType<typeof useSessionData>
