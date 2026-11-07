// Everything the teacher can do on the live board. Optimistic: local state updates first, the
// database write and API call follow without blocking drawing. In demo mode nothing leaves the browser.
import { useCallback, useMemo, useRef } from 'react'
import { api } from '../lib/api'
import { newId, nowIso } from '../lib/assets'
import { bboxOf } from '../lib/ink'
import { supabase } from '../lib/supabase'
import { useSessionStore } from '../store/session'
import type { Annotation, Block, Point, Stroke, TranscriptSegment } from '../types'
import type { SessionData } from './useSessionData'

function logError(what: string) {
  return ({ error }: { error: { message: string } | null }) => {
    if (error) console.error(`${what}: ${error.message}`)
  }
}

export function useTeacherActions(data: SessionData) {
  const ref = useRef(data)
  ref.current = data
  const refining = useRef(false)
  const { demo, upsert, remove } = data
  const sessionId = data.session?.id ?? ''

  const addStroke = useCallback(
    (blockId: string, points: Point[], color: string, width: number) => {
      const row: Stroke = { id: newId(), session_id: sessionId, block_id: blockId, points, color, width, created_at: nowIso() }
      upsert('strokes', row)
      if (!demo) supabase.from('strokes').insert(row).then(logError('insert stroke'))
    },
    [sessionId, demo, upsert],
  )

  const undoStroke = useCallback(() => {
    const last = ref.current.strokeList.at(-1)
    if (!last) return
    remove('strokes', last.id)
    if (!demo) supabase.from('strokes').delete().eq('id', last.id).then(logError('undo stroke'))
  }, [demo, remove])

  const addLasso = useCallback(
    (blockId: string, path: Point[], drawnAt: string) => {
      const store = useSessionStore.getState()
      if (store.pendingAnnotationId) return // one open lasso at a time
      const row: Annotation = {
        id: newId(),
        session_id: sessionId,
        block_id: blockId,
        path,
        bbox: bboxOf(path),
        status: 'pending',
        drawn_at: drawnAt,
        closed_at: null,
        label: null,
        bubble_text: null,
      }
      upsert('annotations', row)
      store.setPendingAnnotation(row.id)
      if (!demo) supabase.from('annotations').insert(row).then(logError('insert annotation'))
    },
    [sessionId, demo, upsert],
  )

  const confirmAnnotation = useCallback(
    (id: string) => {
      const closedAt = nowIso()
      upsert('annotations', { id, status: 'confirmed', closed_at: closedAt })
      useSessionStore.getState().setPendingAnnotation(null)
      if (demo) {
        const words = ref.current.segmentList.filter((s) => s.annotation_id === id).map((s) => s.raw_text)
        setTimeout(
          () => upsert('annotations', { id, label: 'Selected region', bubble_text: words.join(' ') || null }),
          800,
        )
        return
      }
      supabase
        .from('annotations')
        .update({ status: 'confirmed', closed_at: closedAt })
        .eq('id', id)
        .then(logError('confirm annotation'))
      api
        .closeAnnotation(id)
        .then((r) => upsert('annotations', { id, label: r.label, bubble_text: r.bubble_text }))
        .catch((e) => console.error('close annotation', e))
    },
    [demo, upsert],
  )

  const rejectAnnotation = useCallback(
    (id: string) => {
      upsert('annotations', { id, status: 'rejected' })
      useSessionStore.getState().setPendingAnnotation(null)
      for (const s of ref.current.segmentList) {
        if (s.annotation_id === id) upsert('transcript_segments', { id: s.id, annotation_id: null })
      }
      if (demo) return
      supabase.from('annotations').update({ status: 'rejected' }).eq('id', id).then(logError('reject annotation'))
      supabase
        .from('transcript_segments')
        .update({ annotation_id: null })
        .eq('annotation_id', id)
        .then(logError('unlink segments'))
    },
    [demo, upsert],
  )

  /** Insert an image block into drop slot `slot` (0 = top, blocks.length = bottom). */
  const insertImage = useCallback(
    (assetId: string, aspect: number, slot: number) => {
      if (useSessionStore.getState().pendingAnnotationId) return // finish the open lasso first
      const blocks = ref.current.blockList
      const prev = blocks[slot - 1]?.position
      const next = blocks[slot]?.position
      const position =
        prev === undefined && next === undefined ? 1 : prev === undefined ? next! - 1 : next === undefined ? prev + 1 : (prev + next) / 2
      const row: Block = {
        id: newId(),
        session_id: sessionId,
        kind: 'image',
        position,
        text: null,
        asset_id: assetId,
        aspect,
        created_at: nowIso(),
      }
      upsert('blocks', row)
      if (!demo) supabase.from('blocks').insert(row).then(logError('insert image block'))
    },
    [sessionId, demo, upsert],
  )

  /** Called by the transcription hook for every final result. */
  const addSegment = useCallback(
    (rawText: string, confidence: number | null, tStart: string, tEnd: string) => {
      const row: TranscriptSegment = {
        id: newId(),
        session_id: sessionId,
        t_start: tStart,
        t_end: tEnd,
        raw_text: rawText,
        confidence,
        annotation_id: useSessionStore.getState().pendingAnnotationId,
        text_block_id: null,
        created_at: nowIso(),
      }
      upsert('transcript_segments', row)
      if (!demo) supabase.from('transcript_segments').insert(row).then(logError('insert segment'))
    },
    [sessionId, demo, upsert],
  )

  /** Batch-clean unrefined speech into a new text block at the end of the board. */
  const refine = useCallback(async () => {
    if (refining.current || !sessionId) return
    const pending = ref.current.segmentList.filter((s) => !s.text_block_id)
    if (pending.length === 0) return
    refining.current = true
    try {
      if (demo) {
        const last = ref.current.blockList.at(-1)
        const block: Block = {
          id: newId(),
          session_id: sessionId,
          kind: 'text',
          position: (last?.position ?? 0) + 1,
          text: pending.map((s) => s.raw_text.trim()).join(' '),
          asset_id: null,
          aspect: null,
          created_at: nowIso(),
        }
        upsert('blocks', block)
        for (const s of pending) upsert('transcript_segments', { id: s.id, text_block_id: block.id })
        return
      }
      const res = await api.refineSession(sessionId)
      if (res.block) {
        upsert('blocks', res.block)
        for (const id of res.segment_ids) upsert('transcript_segments', { id, text_block_id: res.block.id })
      }
    } catch (e) {
      console.error('refine', e)
    } finally {
      refining.current = false
    }
  }, [sessionId, demo, upsert])

  /** Rename this session (each launch of a lecture has its own name). */
  const renameSession = useCallback(
    (title: string) => {
      data.patchSession({ title })
      if (!demo) supabase.from('sessions').update({ title }).eq('id', sessionId).then(logError('rename session'))
    },
    [sessionId, demo, data.patchSession],
  )

  /** Confirm anything open, flush speech, end the session and kick off note compilation. */
  const endSession = useCallback(async () => {
    const pendingId = useSessionStore.getState().pendingAnnotationId
    if (pendingId) confirmAnnotation(pendingId)
    await refine()
    const endedAt = nowIso()
    data.patchSession({ status: 'ended', ended_at: endedAt })
    if (demo) return
    const { error } = await supabase.from('sessions').update({ status: 'ended', ended_at: endedAt }).eq('id', sessionId)
    if (error) console.error('end session', error.message)
    api.compileSession(sessionId).catch((e) => console.error('compile', e))
  }, [sessionId, demo, confirmAnnotation, refine, data.patchSession])

  return useMemo(
    () => ({ addStroke, undoStroke, addLasso, confirmAnnotation, rejectAnnotation, insertImage, addSegment, refine, renameSession, endSession }),
    [addStroke, undoStroke, addLasso, confirmAnnotation, rejectAnnotation, insertImage, addSegment, refine, renameSession, endSession],
  )
}
