import { create } from 'zustand'

export interface UnsavedProjectFile {
  path: string
  name: string
  content: string
}

interface UnsavedProjectState {
  projectName: string | null
  files: Record<string, UnsavedProjectFile>

  createProject: (name: string) => void
  renameProject: (name: string) => void
  setFile: (path: string, content: string) => void
  updateFile: (path: string, content: string) => void
  clearProject: () => void
}

export const useUnsavedProjectStore = create<UnsavedProjectState>((set) => ({
  projectName: null,
  files: {},

  createProject: (name) =>
    set({
      projectName: name,
      files: {},
    }),

  // Unlike createProject, this only updates the display name (e.g. when the
  // user renames it in the Save dialog) — it does NOT touch `files`.
  renameProject: (name) =>
    set({
      projectName: name,
    }),

  setFile: (path, content) =>
    set((state) => {
      const normalized = path
        .replace(/^unsaved:\/\//, '')
        .replace(/\\/g, '/')

      const virtualPath = `unsaved://${normalized}`
      const name = normalized.split('/').pop() ?? normalized

      return {
        files: {
          ...state.files,
          [virtualPath]: {
            path: virtualPath,
            name,
            content,
          },
        },
      }
    }),

  updateFile: (path, content) =>
    set((state) => {
      const file = state.files[path]
      if (!file) return state

      return {
        files: {
          ...state.files,
          [path]: {
            ...file,
            content,
          },
        },
      }
    }),

  clearProject: () =>
    set({
      projectName: null,
      files: {},
    }),
}))

export function isUnsavedProjectPath(path: string): boolean {
  return path.startsWith('unsaved://')
}