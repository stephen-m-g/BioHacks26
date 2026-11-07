// Per-device teacher settings, remembered in localStorage.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Settings {
  sidebarSide: 'left' | 'right'
  /** When off, only the Apple Pencil draws and a finger scrolls the board. */
  fingerDraws: boolean
  setSidebarSide: (side: 'left' | 'right') => void
  setFingerDraws: (on: boolean) => void
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      sidebarSide: 'left',
      fingerDraws: true,
      setSidebarSide: (sidebarSide) => set({ sidebarSide }),
      setFingerDraws: (fingerDraws) => set({ fingerDraws }),
    }),
    { name: 'board-settings' },
  ),
)
