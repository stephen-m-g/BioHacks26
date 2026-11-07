// Per-device teacher settings, remembered in localStorage.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Settings {
  sidebarSide: 'left' | 'right'
  setSidebarSide: (side: 'left' | 'right') => void
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      sidebarSide: 'left',
      setSidebarSide: (sidebarSide) => set({ sidebarSide }),
    }),
    { name: 'board-settings' },
  ),
)
