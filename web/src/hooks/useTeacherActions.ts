// Everything the teacher can do on the live board. Optimistic: local state updates first, the
// database write and API call follow without blocking drawing.
import { useCallback, useMemo, useRef } from 'react'
import { api } from '../lib/api'
import { newId, nowIso } from '../lib/assets'
import { bboxOf } from '../lib/ink'
import { supabase } from '../lib/supabase'
import { useSessionStore } from '../store/session'
import type { Annotation, Block, Point, Stroke, TranscriptSegment } from '../types'
import { RefineCoordinator, buildTranscriptSegment, flushSpeechAndWaitForPendingWrites } from './teacherActionsModel'
import type { AnnotationCaptureInterval } from './scribeModel'
import type { TranscriptionContext } from './transcriptionModel'
import type { SessionData } from './useSessionData'

function logError(what: string) {
  return ({ error }: { error: { message: string } | null }) => {
    if (error) console.error(`${what}: ${error.message}`)
  }
}

export function useTeacherActions(data: SessionData) {
  const ref = useRef(data)
  ref.current = data
  const refineCoordinator = useRef(new RefineCoordinator())
  const pendingSegmentWrites = useRef(new Set<Promise<void>>())
  const annotationIntervals = useRef(new Map<string, AnnotationCaptureInterval>())
  const { upsert, remove } = data
  const sessionId = data.session?.id ?? ''

  for (const annotation of data.annotationList) {
    if (annotation.status === 'rejected') {
      annotationIntervals.current.delete(annotation.id)
      continue
    }
    const current = annotationIntervals.current.get(annotation.id)
    annotationIntervals.current.set(annotation.id, {
      annotationId: annotation.id,
      drawnAt: annotation.drawn_at,
      closedAt: current?.closedAt ?? annotation.closed_at,
    })
  }

  const getAnnotationIntervals = useCallback(() => [...annotationIntervals.current.values()], [])

  const addStroke = useCallback(
    (blockId: string, points: Point[], color: string, width: number) => {
      const row: Stroke = { id: newId(), session_id: sessionId, block_id: blockId, points, color, width, created_at: nowIso() }
      upsert('strokes', row)
      supabase.from('strokes').insert(row).then(logError('insert stroke'))
    },
    [sessionId, upsert],
  )

  const undoStroke = useCallback(() => {
    const last = ref.current.strokeList.at(-1)
    if (!last) return
    remove('strokes', last.id)
    supabase.from('strokes').delete().eq('id', last.id).then(logError('undo stroke'))
  }, [remove])

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
      annotationIntervals.current.set(row.id, { annotationId: row.id, drawnAt, closedAt: null })
      store.setPendingAnnotation(row.id)
      supabase.from('annotations').insert(row).then(logError('insert annotation'))
    },
    [sessionId, upsert],
  )

  const confirmAnnotation = useCallback(
    async (id: string, flushSpeech?: () => Promise<void>) => {
      const closedAt = nowIso()
      upsert('annotations', { id, status: 'confirmed', closed_at: closedAt })
      const interval = annotationIntervals.current.get(id)
      if (interval) annotationIntervals.current.set(id, { ...interval, closedAt })
      useSessionStore.getState().setPendingAnnotation(null)
      try {
        const annotationWrite = supabase
          .from('annotations')
          .update({ status: 'confirmed', closed_at: closedAt })
          .eq('id', id)
        const result = await flushSpeechAndWaitForPendingWrites(pendingSegmentWrites.current, flushSpeech, async () => {
          const { error } = await annotationWrite
          if (error) console.error(`confirm annotation: ${error.message}`)
          return api.closeAnnotation(id)
        })
        upsert('annotations', { id, label: result.label, bubble_text: result.bubble_text })
      } catch (e) {
        console.error('close annotation', e)
      }
    },
    [upsert],
  )

  const rejectAnnotation = useCallback(
    (id: string) => {
      upsert('annotations', { id, status: 'rejected' })
      annotationIntervals.current.delete(id)
      useSessionStore.getState().setPendingAnnotation(null)
      for (const s of ref.current.segmentList) {
        if (s.annotation_id === id) upsert('transcript_segments', { id: s.id, annotation_id: null })
      }
      supabase.from('annotations').update({ status: 'rejected' }).eq('id', id).then(logError('reject annotation'))
      supabase
        .from('transcript_segments')
        .update({ annotation_id: null })
        .eq('annotation_id', id)
        .then(logError('unlink segments'))
    },
    [upsert],
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
      supabase.from('blocks').insert(row).then(logError('insert image block'))
    },
    [sessionId, upsert],
  )

  /** Called by the transcription hook for every final result. */
  const addSegment = useCallback(
    (
      rawText: string,
      confidence: number | null,
      tStart: string,
      tEnd: string,
      context: TranscriptionContext | null = null,
    ) => {
      const row: TranscriptSegment = buildTranscriptSegment({
        id: newId(),
        defaultSessionId: sessionId,
        defaultAnnotationId: useSessionStore.getState().pendingAnnotationId,
        context,
        rawText,
        confidence,
        tStart,
        tEnd,
        createdAt: nowIso(),
      })
      upsert('transcript_segments', row)
      const write = Promise.resolve(supabase.from('transcript_segments').insert(row)).then(logError('insert segment'))
      pendingSegmentWrites.current.add(write)
      void write.finally(() => pendingSegmentWrites.current.delete(write))
    },
    [sessionId, upsert],
  )

  /** Batch-clean unrefined speech into a new text block at the end of the board. */
  const performRefine = useCallback(async () => {
    if (!sessionId) return
    try {
      if (pendingSegmentWrites.current.size > 0) {
        await Promise.allSettled([...pendingSegmentWrites.current])
      }
      const pending = ref.current.segmentList.filter((s) => !s.text_block_id)
      if (pending.length === 0) return
      const res = await api.refineSession(sessionId)
      if (res.block) {
        upsert('blocks', res.block)
        for (const id of res.segment_ids) upsert('transcript_segments', { id, text_block_id: res.block.id })
      }
    } catch (e) {
      console.error('refine', e)
    }
  }, [sessionId, upsert])

  const refine = useCallback(
    () => refineCoordinator.current.run(performRefine),
    [performRefine],
  )

  /** Rename this session (each launch of a lecture has its own name). */
  const renameSession = useCallback(
    (title: string) => {
      data.patchSession({ title })
      supabase.from('sessions').update({ title }).eq('id', sessionId).then(logError('rename session'))
    },
    [sessionId, data.patchSession],
  )

  /** Confirm anything open, flush speech, end the session and kick off note compilation. */
  const endSession = useCallback(async () => {
    const pendingId = useSessionStore.getState().pendingAnnotationId
    if (pendingId) await confirmAnnotation(pendingId)
    await refineCoordinator.current.drain(performRefine)
    const endedAt = nowIso()
    data.patchSession({ status: 'ended', ended_at: endedAt })
    const { error } = await supabase.from('sessions').update({ status: 'ended', ended_at: endedAt }).eq('id', sessionId)
    if (error) console.error('end session', error.message)
    api.compileSession(sessionId).catch((e) => console.error('compile', e))
  }, [sessionId, confirmAnnotation, performRefine, data.patchSession])

  return useMemo(
    () => ({ addStroke, undoStroke, addLasso, confirmAnnotation, rejectAnnotation, insertImage, addSegment, refine, renameSession, endSession, getAnnotationIntervals }),
    [addStroke, undoStroke, addLasso, confirmAnnotation, rejectAnnotation, insertImage, addSegment, refine, renameSession, endSession, getAnnotationIntervals],
  )
}
