// Shared live-session UI state. P1 writes most of it; P3 reads pendingAnnotationId when
// inserting transcript segments so speech gets tagged to the open lasso.
import { create } from 'zustand'

export type BoardMode = 'ink' | 'smart'

export const INK_COLORS = ['#111111', '#2563eb', '#dc2626', '#16a34a'] as const
/** Stroke widths as a fraction of image width. */
export const INK_WIDTHS = [
  { label: 'Thin', value: 0.004 },
  { label: 'Medium', value: 0.008 },
  { label: 'Thick', value: 0.016 },
] as const

export interface SessionState {
  sessionId: string | null
  pendingAnnotationId: string | null
  mode: BoardMode
  inkColor: string
  inkWidth: number
  /** Image tapped in the sidebar, waiting for a tap on a drop slot. */
  selectedAssetId: string | null
  /** Image currently being dragged from the sidebar. */
  draggingAssetId: string | null
  reset: (sessionId: string | null) => void
  setPendingAnnotation: (id: string | null) => void
  setMode: (mode: BoardMode) => void
  setInkColor: (color: string) => void
  setInkWidth: (width: number) => void
  setSelectedAsset: (id: string | null) => void
  setDraggingAsset: (id: string | null) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  pendingAnnotationId: null,
  mode: 'ink',
  inkColor: INK_COLORS[0],
  inkWidth: INK_WIDTHS[1].value,
  selectedAssetId: null,
  draggingAssetId: null,
  reset: (sessionId) =>
    set({ sessionId, pendingAnnotationId: null, selectedAssetId: null, draggingAssetId: null }),
  setPendingAnnotation: (id) => set({ pendingAnnotationId: id }),
  setMode: (mode) => set({ mode }),
  setInkColor: (inkColor) => set({ inkColor }),
  setInkWidth: (inkWidth) => set({ inkWidth }),
  setSelectedAsset: (selectedAssetId) => set({ selectedAssetId }),
  setDraggingAsset: (draggingAssetId) => set({ draggingAssetId }),
}))
