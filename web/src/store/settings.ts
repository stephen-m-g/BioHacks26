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
    {
      name: 'board-settings',
      // Version 0 also stored a speech provider choice; keep only the sidebar side.
      version: 1,
      partialize: ({ sidebarSide }) => ({ sidebarSide }),
      migrate: (persisted) => ({
        sidebarSide: (persisted as { sidebarSide?: unknown } | null)?.sidebarSide === 'right' ? 'right' : 'left',
      }),
    },
  ),
)
