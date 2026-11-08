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
import { PAGE_SETTLE_MS, PageTimeline, READING_LINE, activePageAt, isUserScroll } from '../hooks/pageSpeechModel'
import { pageInfo, pagesOf, pdfFirstBlockOnBoard, pdfPagesReady } from '../lib/pdfPages'
import type { SidebarDocument } from '../components/Sidebar'
import { useSessionStore } from '../store/session'
import { supabase } from '../lib/supabase'
import { useSettings } from '../store/settings'
import '../styles/student.css'

/** How often unrefined speech is batch-cleaned into a paragraph. */
const REFINE_EVERY_MS = 15_000

/** After the teacher touches the board, don't follow new text for this long. */
const HOLD_SCROLL_AFTER_TOUCH_MS = 20_000

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** The page crossing the board's reading line (see activePageAt), from the rendered board items. */
function readActivePage(scroller: HTMLElement): string | null {
  const view = scroller.getBoundingClientRect()
  const items = [...scroller.querySelectorAll<HTMLElement>('[data-board-item]')].map((el) => {
    const box = el.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, owner: el.dataset.pageOwner ?? null }
  })
  return activePageAt(items, view.top + view.height * READING_LINE)
}

/** The default name a lecture gets on creation; a session or lecture still called this hasn't been named. */
const isUntitled = (t: string | null | undefined) => !t || !t.trim() || t.trim() === 'Untitled lecture'

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
  /** Name typed into the End session dialog when the session is still "Untitled lecture". */
  const [endName, setEndName] = useState('')
  const [ending, setEnding] = useState(false)
  const aspects = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastBoardTouch = useRef(0)
  /** Last time the teacher himself scrolled, touched or pressed a key, so programmatic scrolls can be told apart. */
  const lastUserInput = useRef(0)
  const pageTimeline = useRef(new PageTimeline())

  /** The PDF page new speech belongs to. Every change is timed, so delayed transcripts land on the right page. */
  const setActivePage = useCallback((blockId: string | null) => {
    pageTimeline.current.set(blockId, Date.now())
    if (useSessionStore.getState().activePageBlockId !== blockId) useSessionStore.getState().setActivePage(blockId)
  }, [])

  const speech = useScribeTranscription({
    enabled: shouldRecord(mic, sessionId, data.session?.status),
    sessionId,
    onFinal: actions.addSegment,
    scopeKey: sessionId,
    captureContext: () => ({
      sessionId,
      annotationId: useSessionStore.getState().pendingAnnotationId,
      pageBlockId: useSessionStore.getState().activePageBlockId,
    }),
    captureAnnotationIntervals: actions.getAnnotationIntervals,
    capturePageAt: (ms) => pageTimeline.current.at(ms),
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
  // open, while he's on a PDF page (his words appear under it, not at the end), and for a while after he
  // last touched the board (drawing, placing an image, scrolling).
  useAutoScroll(
    scrollRef,
    [data.blockList.length, data.segmentList.length, speech.interim],
    () =>
      useSessionStore.getState().pendingAnnotationId !== null ||
      useSessionStore.getState().activePageBlockId !== null ||
      Date.now() - lastBoardTouch.current < HOLD_SCROLL_AFTER_TOUCH_MS,
  )

  // Active page from scrolling: only his own scrolling counts (auto-scroll and "show this PDF" don't), and only
  // once it settles, so pages passing by on the way don't take his words.
  const boardReady = !data.loading && !!data.session
  useEffect(() => {
    const el = scrollRef.current
    if (!boardReady || !el) return
    let timer: number | undefined
    const onScroll = () => {
      if (!isUserScroll(lastUserInput.current, Date.now())) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setActivePage(readActivePage(el)), PAGE_SETTLE_MS)
    }
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) lastUserInput.current = Date.now()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [boardReady, setActivePage])

  // After a reload, start from the page on screen (pages keep their place in the board's layout before loading).
  const hasPages = data.blockList.some((b) => pageInfo(b, data.assets))
  useEffect(() => {
    const el = scrollRef.current
    if (!boardReady || !hasPages || !el || useSessionStore.getState().activePageBlockId) return
    const timer = window.setTimeout(() => setActivePage(readActivePage(el)), 150)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardReady, hasPages])

  /** Touching the board: the page (or ordinary content) under his finger or pen is what he's talking about. */
  const onBoardPointerDown = (e: React.PointerEvent) => {
    lastBoardTouch.current = lastUserInput.current = Date.now()
    const item = (e.target as Element).closest<HTMLElement>('[data-board-item]')
    if (item) setActivePage(item.dataset.pageOwner ?? null)
  }

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
      if (!first) return
      setActivePage(first)
      showBlock(first)
    },
    [data.blockList, data.assets, showBlock, setActivePage],
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
      if (!placed[0]) return
      setActivePage(placed[0].id) // he starts on page 1, wherever the drop left the scroll position
      showBlock(placed[0].id)
    },
    [actions, data.assets, data.blockList, showBlock, showPdf, store, setActivePage],
  )

  const insertAt = useCallback(
    (assetId: string, slot: number, aspect?: number) => {
      if (data.assets[assetId]?.kind === 'pdf') return placePdf(assetId, slot)
      actions.insertImage(assetId, aspect ?? aspects.current.get(assetId) ?? 4 / 3, slot)
      store.setSelectedAsset(null)
    },
    [actions, store, data.assets, placePdf],
  )

  const untitled = isUntitled(data.session?.title || data.lecture?.title)

  const endSession = async () => {
    setEnding(true)
    // Still untitled: save the name typed in the dialog (and give an untitled lecture the same name).
    const name = endName.trim()
    if (untitled && name && data.session) {
      actions.renameSession(name)
      if (isUntitled(data.lecture?.title)) {
        await supabase.from('lectures').update({ title: name }).eq('id', data.session.lecture_id)
      }
    }
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
            onPointerDownCapture={onBoardPointerDown}
            onWheel={() => (lastBoardTouch.current = lastUserInput.current = Date.now())}
            onTouchMove={() => (lastUserInput.current = Date.now())}
          >
            {data.session.status === 'ended' && <div className="notice">This session has ended.</div>}
            <Board
          blocks={data.blockList}
          assets={data.assets}
          strokes={data.strokeList}
          annotations={data.annotationList}
          segments={data.segmentList}
          interim={speech.interim}
          activePageBlockId={store.activePageBlockId}
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
        {untitled && (
          <label className="dialog-field">
            <span className="dialog-field-label">Name this session</span>
            <input
              value={endName}
              placeholder="Untitled lecture"
              autoFocus
              disabled={ending}
              onChange={(e) => setEndName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !ending) {
                  e.preventDefault()
                  endSession()
                }
              }}
            />
          </label>
        )}
      </ConfirmDialog>
    </div>
  )
}
