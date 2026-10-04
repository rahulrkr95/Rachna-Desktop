// store/useSpecialistStore.ts
//
// Drives the "specialist chip" shown in the chat input footer (see
// components/AiChat/SpecialistChipBar.tsx). Selecting a specialist is a
// standing, persisted preference — not a per-turn override like the folder
// chips — that tells useChat.ts::executeSend exactly which TopIntent
// (lib/intentClassifier.ts) to force this and every subsequent turn into,
// routing the selected task specialist directly to the Task Planner
// entirely. See lib/specialistMapping.ts for the SpecialistOption →
// TopIntent table and human-readable labels.
//
// Defaults to 'DESKTOP' — every fresh install starts scoped to desktop
// control (files/apps/local research/input control) rather than paying for
// a classification call on the very first message.
//
// Persisted to localStorage (hand-rolled, matching
// useRepoContextModeStore.ts's pattern) so the choice survives app restarts.

import { create } from 'zustand'

export type SpecialistOption =
  | 'CODING'
  | 'DESIGN'
  | 'DESKTOP'
  | 'MCP'
  | 'AUTOMATION'
  | 'BROWSER'
  | 'CHAT'

export const SPECIALIST_OPTIONS: readonly SpecialistOption[] = [
  'CODING', 'DESIGN', 'DESKTOP', 'MCP', 'AUTOMATION', 'BROWSER', 'CHAT',
]

const STORAGE_KEY = 'rachna-specialist-chip'
const DEFAULT_SPECIALIST: SpecialistOption = 'DESKTOP'

function isSpecialistOption(value: unknown): value is SpecialistOption {
  return typeof value === 'string' && (SPECIALIST_OPTIONS as readonly string[]).includes(value)
}

function load(): SpecialistOption {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isSpecialistOption(raw) ? raw : DEFAULT_SPECIALIST
  } catch {
    return DEFAULT_SPECIALIST
  }
}

function persist(value: SpecialistOption): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // best-effort only — an unpersisted choice just falls back to the
    // default on next launch, never a hard failure.
  }
}

interface SpecialistState {
  specialist: SpecialistOption
  setSpecialist: (specialist: SpecialistOption) => void
}

export const useSpecialistStore = create<SpecialistState>((set) => ({
  specialist: load(),
  setSpecialist(specialist) {
    persist(specialist)
    set({ specialist })
  },
}))
