// Per-device teacher settings, remembered in localStorage.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TranscriptionProvider } from '../hooks/scribeModel'

export interface Settings {
  sidebarSide: 'left' | 'right'
  setSidebarSide: (side: 'left' | 'right') => void
  transcriptionProvider: TranscriptionProvider
  setTranscriptionProvider: (provider: TranscriptionProvider) => void
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      sidebarSide: 'left',
      setSidebarSide: (sidebarSide) => set({ sidebarSide }),
      transcriptionProvider: 'chrome',
      setTranscriptionProvider: (transcriptionProvider) => set({ transcriptionProvider }),
    }),
    { name: 'board-settings' },
  ),
)
