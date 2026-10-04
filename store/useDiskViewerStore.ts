// store/useDiskViewerStore.ts
//
// Holds the open/closed state and target path for the in-app Disk Viewer.
// Opened programmatically by desktopTaskTool.ts's open_path action when the
// resolved target is a directory (see ToolContext.openDiskViewer), and
// mounted once in IDELayout.tsx as <DiskViewerModal />.

import { create } from 'zustand'

interface DiskViewerState {
  isOpen: boolean
  rootPath: string | null
  /** Opens (or re-navigates) the Disk Viewer to `path`. */
  open: (path: string) => void
  close: () => void
}

export const useDiskViewerStore = create<DiskViewerState>((set) => ({
  isOpen: false,
  rootPath: null,
  open: (path) => set({ isOpen: true, rootPath: path }),
  close: () => set({ isOpen: false, rootPath: null }),
}))
