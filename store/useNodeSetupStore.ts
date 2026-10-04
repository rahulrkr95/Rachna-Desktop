// store/useNodeSetupStore.ts
//
// Tracks the "download/extract managed Node.js" step that runs once at app
// launch, before the IDE is shown. See App.tsx for the effect that calls
// `runNodeSetup()` on mount. It needs no Rachna account: the Rust side
// (`ensure_managed_node` in src-tauri/src/commands.rs) downloads the runtime
// straight from nodejs.org.
//
// Flow: launch → `runNodeSetup()` (awaits `ensure_node_runtime`, the thin
// wrapper around `ensure_managed_node`) → only once that resolves (success OR
// a user-acknowledged failure) does App.tsx let the person past this step.
// `doctor_check` still calls `ensure_managed_node` itself too — that's fine
// and cheap, since the Rust fn short-circuits instantly once the runtime is
// already installed.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export type NodeSetupStatus = 'idle' | 'installing' | 'ready' | 'error'

interface NodeSetupState {
  status: NodeSetupStatus
  message: string | null
  /** Guards against re-running the install once it's already succeeded
   *  this session, e.g. if the auth effect re-fires. */
  hasRun: boolean
  runNodeSetup: () => Promise<void>
}

export const useNodeSetupStore = create<NodeSetupState>((set, get) => ({
  status: 'idle',
  message: null,
  hasRun: false,

  runNodeSetup: async () => {
    if (get().status === 'installing' || get().status === 'ready') return
    set({ status: 'installing', message: 'Setting up Node.js runtime…' })
    try {
      const result = await invoke<string | null>('ensure_node_runtime')
      set({ status: 'ready', message: result ?? null, hasRun: true })
    } catch (e) {
      console.error('[node-setup] ensure_node_runtime failed:', e)
      set({ status: 'error', message: String(e), hasRun: true })
    }
  },
}))
