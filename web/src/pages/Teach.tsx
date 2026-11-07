// P1 owns this page. The live session: sidebar + scrolling board. /teach/demo runs offline.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Board from '../components/Board'
import ConfirmDialog from '../components/ConfirmDialog'
import Sidebar from '../components/Sidebar'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { useSessionData } from '../hooks/useSessionData'
import { useTeacherActions } from '../hooks/useTeacherActions'
import { useTranscription } from '../hooks/useTranscription'
import { useSessionStore } from '../store/session'
import { useSettings } from '../store/settings'

/** How often unrefined speech is batch-cleaned into a paragraph. */
const REFINE_EVERY_MS = 15_000

export default function Teach() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const data = useSessionData(sessionId)
  const actions = useTeacherActions(data)
  const store = useSessionStore()
  const settings = useSettings()
  const [micOn, setMicOn] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [ending, setEnding] = useState(false)
  const aspects = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)

  const speech = useTranscription({
    enabled: micOn && data.session?.status === 'live',
    onFinal: actions.addSegment,
    scopeKey: sessionId,
    captureContext: () => ({
      sessionId,
      annotationId: useSessionStore.getState().pendingAnnotationId,
    }),
  })

  useEffect(() => {
    useSessionStore.getState().reset(sessionId)
  }, [sessionId])

  // After a reload, re-open an annotation that was still pending.
  useEffect(() => {
    const open = data.annotationList.find((a) => a.status === 'pending')
    if (open && !useSessionStore.getState().pendingAnnotationId) store.setPendingAnnotation(open.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.loading])

  useEffect(() => {
    const t = setInterval(actions.refine, REFINE_EVERY_MS)
    return () => clearInterval(t)
  }, [actions.refine])

  useAutoScroll(scrollRef, [data.blockList.length, data.segmentList.length, speech.interim])

  const insertAt = useCallback(
    (assetId: string, slot: number, aspect?: number) => {
      actions.insertImage(assetId, aspect ?? aspects.current.get(assetId) ?? 4 / 3, slot)
      store.setSelectedAsset(null)
    },
    [actions, store],
  )

  const endSession = async () => {
    setEnding(true)
    await speech.stop()
    setMicOn(false)
    await actions.endSession()
    navigate(data.demo ? '/' : `/notes/${sessionId}`)
  }

  const toggleMic = async () => {
    if (micOn) {
      await speech.stop()
      setMicOn(false)
    } else {
      setMicOn(true)
    }
  }

  if (data.loading) return <div className="page muted">Loading session…</div>
  if (data.error || !data.session) return <div className="page notice warn">{data.error ?? 'Session not found'}</div>

  const placing = store.pendingAnnotationId === null && (store.selectedAssetId !== null || store.draggingAssetId !== null)

  return (
    <div className={`teach sidebar-${settings.sidebarSide}`}>
      <Sidebar
        title={data.lecture?.title ?? 'Lecture'}
        images={data.imageAssets}
        mic={{
          on: micOn,
          listening: speech.listening,
          supported: speech.supported,
          error: speech.error,
          metrics: speech.metrics,
          toggle: toggleMic,
        }}
        onUndo={actions.undoStroke}
        onDrop={(assetId, aspect, slot) => insertAt(assetId, slot, aspect)}
        onEnd={() => setConfirmEnd(true)}
        onImageAspect={(id, aspect) => aspects.current.set(id, aspect)}
      />
      <main className="board-scroll" ref={scrollRef}>
        {data.session.status === 'ended' && <div className="notice">This session has ended.</div>}
        <Board
          blocks={data.blockList}
          assets={data.assets}
          strokes={data.strokeList}
          annotations={data.annotationList}
          segments={data.segmentList}
          interim={speech.interim}
          teacher={{
            mode: store.mode,
            inkColor: store.inkColor,
            inkWidth: store.inkWidth,
            fingerDraws: settings.fingerDraws,
            pendingId: store.pendingAnnotationId,
            placing,
            onSlot: (slot) => store.selectedAssetId && insertAt(store.selectedAssetId, slot),
            onStroke: (blockId, points) => actions.addStroke(blockId, points, store.inkColor, store.inkWidth),
            onLasso: actions.addLasso,
            onConfirm: actions.confirmAnnotation,
            onReject: actions.rejectAnnotation,
          }}
        />
      </main>

      <ConfirmDialog
        open={confirmEnd}
        title="End this session?"
        confirmLabel={ending ? 'Ending…' : 'End session'}
        danger
        onCancel={() => !ending && setConfirmEnd(false)}
        onConfirm={() => !ending && endSession()}
      >
        The mic turns off{store.pendingAnnotationId ? ', the open annotation is saved,' : ''} and the notes start compiling.
      </ConfirmDialog>
    </div>
  )
}
