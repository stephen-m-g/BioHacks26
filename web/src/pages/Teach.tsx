// P1 owns this page. The live session: sidebar + scrolling board.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Board from '../components/Board'
import ConfirmDialog from '../components/ConfirmDialog'
import Sidebar from '../components/Sidebar'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { useSessionData } from '../hooks/useSessionData'
import { useTeacherActions } from '../hooks/useTeacherActions'
import { MIC_OFF, isMicOn, shouldRecord, turnMicOn, type MicState } from '../hooks/micModel'
import { useScribeTranscription } from '../hooks/useScribeTranscription'
import { api, apiErrorMessage } from '../lib/api'
import { ensureJoinCode, formatJoinCode } from '../lib/joinCode'
import { pagesOf, pdfFirstBlockOnBoard, pdfPagesReady } from '../lib/pdfPages'
import type { SidebarDocument } from '../components/Sidebar'
import { useSessionStore } from '../store/session'
import { useSettings } from '../store/settings'
import '../styles/student.css'

/** How often unrefined speech is batch-cleaned into a paragraph. */
const REFINE_EVERY_MS = 15_000

/** After the teacher touches the board, don't follow new text for this long. */
const HOLD_SCROLL_AFTER_TOUCH_MS = 20_000

export default function Teach() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const data = useSessionData(sessionId)
  const actions = useTeacherActions(data)
  const store = useSessionStore()
  const settings = useSettings()
  // The mic starts off in every session; Start/Pause recording lives in the title menu.
  const [mic, setMic] = useState<MicState>(MIC_OFF)
  const micOn = isMicOn(mic, sessionId)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [ending, setEnding] = useState(false)
  const aspects = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastBoardTouch = useRef(0)

  const speech = useScribeTranscription({
    enabled: shouldRecord(mic, sessionId, data.session?.status),
    sessionId,
    onFinal: actions.addSegment,
    scopeKey: sessionId,
    captureContext: () => ({
      sessionId,
      annotationId: useSessionStore.getState().pendingAnnotationId,
    }),
    captureAnnotationIntervals: actions.getAnnotationIntervals,
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

  // Follow new text, but never scroll away from a diagram he's working on: hold while a lasso is
  // open and for a while after he last touched the board (drawing, placing an image, scrolling).
  useAutoScroll(
    scrollRef,
    [data.blockList.length, data.segmentList.length, speech.interim],
    () =>
      useSessionStore.getState().pendingAnnotationId !== null ||
      Date.now() - lastBoardTouch.current < HOLD_SCROLL_AFTER_TOUCH_MS,
  )

  // Students join with this code (shown in the breadcrumb). If it can't be set, no code is shown; class goes on.
  const live = data.session?.status === 'live'
  const joinCode = data.session?.join_code ?? null
  const { loading, patchSession } = data
  useEffect(() => {
    if (loading || !live || joinCode) return
    let cancelled = false
    ensureJoinCode(sessionId).then((code) => {
      if (!cancelled && code) patchSession({ join_code: code })
    })
    return () => {
      cancelled = true
    }
  }, [loading, live, joinCode, sessionId, patchSession])

  // PDFs: each page is rendered once to an image asset (usually already done in prep). PDFs uploaded before
  // that existed, or whose rendering failed, are rendered here; the sidebar shows progress and errors.
  const [pdfStatus, setPdfStatus] = useState<Record<string, { state: 'preparing' | 'error'; error?: string }>>({})
  const { mergeAssets } = data
  const preparePdf = useCallback(
    (pdfId: string) => {
      setPdfStatus((s) => ({ ...s, [pdfId]: { state: 'preparing' } }))
      api
        .renderPdfPages(pdfId)
        .then((r) => {
          mergeAssets([...r.pages, { id: pdfId, page_count: r.page_count }])
          setPdfStatus(({ [pdfId]: _, ...rest }) => rest)
        })
        .catch((e) =>
          setPdfStatus((s) => ({ ...s, [pdfId]: { state: 'error', error: apiErrorMessage(e, 'Couldn’t prepare this PDF’s pages.') } })),
        )
    },
    [mergeAssets],
  )
  const requestedPdfs = useRef(new Set<string>())
  useEffect(() => {
    if (loading || !live) return
    for (const pdf of data.pdfAssets) {
      if (requestedPdfs.current.has(pdf.id) || pdfPagesReady(pdf, pagesOf(Object.values(data.assets), pdf.id))) continue
      requestedPdfs.current.add(pdf.id)
      preparePdf(pdf.id)
    }
  }, [loading, live, data.pdfAssets, data.assets, preparePdf])

  const documents: SidebarDocument[] = data.pdfAssets.map((pdf) => {
    const pages = pagesOf(Object.values(data.assets), pdf.id)
    const ready = pdfPagesReady(pdf, pages)
    const status = pdfStatus[pdf.id]
    return {
      asset: pdf,
      firstPage: pages[0] ?? null,
      pageCount: ready ? pages.length : null,
      status: ready ? 'ready' : status?.state === 'error' ? 'error' : 'preparing',
      error: status?.error,
      onBoard: pdfFirstBlockOnBoard(data.blockList, data.assets, pdf.id) !== null,
    }
  })

  /** Bring a placed PDF page to the top of the board (programmatic, so it doesn't count as the teacher scrolling). */
  const showBlock = useCallback((blockId: string) => {
    lastBoardTouch.current = Date.now()
    window.setTimeout(() => {
      scrollRef.current?.querySelector(`[data-pdf-page="${blockId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }, [])

  const showPdf = useCallback(
    (pdfId: string) => {
      const first = pdfFirstBlockOnBoard(data.blockList, data.assets, pdfId)
      if (first) showBlock(first)
    },
    [data.blockList, data.assets, showBlock],
  )

  /** Every page of the PDF, in order, in one slot; a PDF already on this board is shown instead of repeated. */
  const placePdf = useCallback(
    (pdfId: string, slot: number) => {
      store.setSelectedAsset(null)
      const pdf = data.assets[pdfId]
      const pages = pagesOf(Object.values(data.assets), pdfId)
      if (!pdf || !pdfPagesReady(pdf, pages)) return
      if (pdfFirstBlockOnBoard(data.blockList, data.assets, pdfId)) return showPdf(pdfId)
      const placed = actions.insertPdfPages(pages, slot)
      if (placed[0]) showBlock(placed[0].id)
    },
    [actions, data.assets, data.blockList, showBlock, showPdf, store],
  )

  const insertAt = useCallback(
    (assetId: string, slot: number, aspect?: number) => {
      if (data.assets[assetId]?.kind === 'pdf') return placePdf(assetId, slot)
      actions.insertImage(assetId, aspect ?? aspects.current.get(assetId) ?? 4 / 3, slot)
      store.setSelectedAsset(null)
    },
    [actions, store, data.assets, placePdf],
  )

  const endSession = async () => {
    setEnding(true)
    await speech.stop()
    setMic(MIC_OFF)
    await actions.endSession()
    navigate(`/notes/${sessionId}`)
  }

  const toggleMic = async () => {
    if (micOn) {
      await speech.stop()
      setMic(MIC_OFF)
    } else {
      setMic(turnMicOn(sessionId))
    }
  }

  if (data.loading) return <div className="page muted">Loading session…</div>
  if (data.error || !data.session) return <div className="page notice warn">{data.error ?? 'Session not found'}</div>

  const placing = store.pendingAnnotationId === null && (store.selectedAssetId !== null || store.draggingAssetId !== null)
  const placingId = store.draggingAssetId ?? store.selectedAssetId
  const placeLabel = placingId && data.assets[placingId]?.kind === 'pdf' ? 'Place every page of the PDF here' : undefined

  const title = data.session.title || data.lecture?.title || 'Lecture'

  return (
    <div className={`teach sidebar-${settings.sidebarSide}`}>
      <Sidebar
        title={title}
        onRename={actions.renameSession}
        images={data.imageAssets}
        documents={documents}
        onUndo={actions.undoStroke}
        onDrop={(assetId, aspect, slot) => insertAt(assetId, slot, aspect)}
        onDropDocument={placePdf}
        onShowDocument={showPdf}
        onRetryDocument={preparePdf}
        onEnd={() => setConfirmEnd(true)}
        onImageAspect={(id, aspect) => aspects.current.set(id, aspect)}
        recording={{
          on: micOn && data.session.status === 'live',
          live: data.session.status === 'live',
          listening: speech.listening,
          supported: speech.supported,
          error: speech.error,
          metrics: speech.metrics,
          confidenceSupported: speech.confidenceSupported,
          startedAt: data.session.started_at,
          toggle: toggleMic,
        }}
      />
      <div className="teach-main">
        <div className="breadcrumb">
          <strong>{title}</strong>
          <span aria-hidden="true">›</span>
          <span>{data.session.status === 'live' ? 'Live session' : 'Ended'}</span>
          {live && joinCode && (
            <div className="join-pill">
              <span className="join-pill-url">{window.location.host}/join</span>
              <span className="join-pill-code">{formatJoinCode(joinCode)}</span>
            </div>
          )}
        </div>
        <div className="canvas-card">
          <main
            className="board-scroll"
            ref={scrollRef}
            onPointerDownCapture={() => (lastBoardTouch.current = Date.now())}
            onWheel={() => (lastBoardTouch.current = Date.now())}
          >
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
            fingerDraws: !store.pencilSeen,
            onPen: store.setPencilSeen,
            pendingId: store.pendingAnnotationId,
            placing,
            placeLabel,
            onSlot: (slot) => store.selectedAssetId && insertAt(store.selectedAssetId, slot),
            onStroke: (blockId, points) => actions.addStroke(blockId, points, store.inkColor, store.inkWidth),
            onLasso: actions.addLasso,
            onConfirm: (id) => actions.confirmAnnotation(id, speech.flush),
            onReject: actions.rejectAnnotation,
          }}
        />
          </main>
        </div>
      </div>

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
