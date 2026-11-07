// Shared frontend state. P4 owns the stub, P1 writes to it, P3 reads it.
import { create } from 'zustand'

export interface SessionState {
  sessionId: string | null
  lectureId: string | null
  currentSlideId: string | null
  pendingAnnotationId: string | null
  setSession: (sessionId: string | null, lectureId: string | null) => void
  setCurrentSlide: (id: string | null) => void
  setPendingAnnotation: (id: string | null) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  lectureId: null,
  currentSlideId: null,
  pendingAnnotationId: null,
  setSession: (sessionId, lectureId) => set({ sessionId, lectureId }),
  setCurrentSlide: (id) => set({ currentSlideId: id }),
  setPendingAnnotation: (id) => set({ pendingAnnotationId: id }),
}))
