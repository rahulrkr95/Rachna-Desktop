// store/useAgentStatusStore.ts
//
// Tiny global mirror of "what is the agent doing right now", so components
// outside the AiChat tree — specifically the compact-mode widget
// (components/CompactView.tsx), which renders while the full chat UI is
// hidden — can still show a live one-line status without needing the full
// useChat() hook (which is tied to a single AiChat instance/context).
//
// components/AiChat.tsx syncs this from its own `streaming` state and the
// current streaming message's latest agent activity.

import { create } from 'zustand'

interface AgentStatusState {
  isActive: boolean
  statusText: string
  setStatus: (isActive: boolean, statusText: string) => void
}

export const useAgentStatusStore = create<AgentStatusState>(set => ({
  isActive: false,
  statusText: 'Idle',
  setStatus: (isActive, statusText) => set({ isActive, statusText }),
}))
