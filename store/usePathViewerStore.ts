// store/usePathViewerStore.ts
//
// Tracks whether the Path Viewer bar is open. The Path Viewer lets the user
// type or paste any file path (absolute, or relative to the open project)
// and open it directly in the studio's editor/viewer — same resolution and
// rendering path as clicking a file-path link in an AI chat message (see
// components/AiChat/useFileLink.ts), just available on demand instead of
// only when the AI happens to mention a path. Docks/toggles the same way
// the in-app Terminal panel does (see IDELayout.tsx / StatusBar.tsx).

import { create } from 'zustand'

interface PathViewerStore {
  open: boolean
  toggle: () => void
  setOpen: (open: boolean) => void
}

export const usePathViewerStore = create<PathViewerStore>((set) => ({
  open: false,
  toggle: () => set(s => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
}))
