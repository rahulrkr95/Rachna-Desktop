// lib/pendingChatSend.ts
//
// Why this exists: IDELayout renders welcome-mode and IDE-mode as two
// SEPARATE <AiChat> instances (different JSX branches), each with its own
// useChat() call. The moment a folder opens (a new project is scaffolded,
// or an existing one is picked), IDELayout's own projectRoot effect flips
// appMode to 'ide' — which unmounts the welcome AiChat/useChat instance and
// mounts a brand new one for the IDE sidebar. Any plain React state/ref
// holding in-flight execution-step progress would be destroyed in that
// unmount before it ever finishes.
//
// Multi-intent execution refactor: intent is no longer known before a
// Intent Plan is generated (see lib/planGenerator.ts) — it's decided
// per ExecutionStep during planning. So the one
// thing that can still need a folder to appear mid-task (a WORK_WITH_REPO
// or BUILD_NEW_PROJECT/DESIGN step reached with no project open yet) is a
// hand-off *in the middle of* an approved plan's step list, not a
// whole-request classification outcome anymore. This module holds exactly
// that: the remaining (not-yet-run) ExecutionStep[] plus the shared
// TaskState built up so far, queued across the unmount/remount boundary so
// the *new* (IDE-mode) useChat instance can resume the SAME task the moment
// it mounts with a real project root, rather than losing the rest of the
// plan.
//
// Hand-offs that DON'T cross an unmount boundary (waiting for an MCP
// connector, waiting for repo indexing to finish) are handled with a plain in-place `await`
// inside the step executor itself (see components/AiChat/useChat.ts) — no
// queue needed there, since the same component instance stays mounted the
// whole time.

import type { PendingChatImage } from '../components/AiChat/ChatInput'
import type { ExecutionStep, TaskState } from '../types'

export interface PendingStepResume {
  /** The original user request this task's Master Plan was approved for — shown again if a fresh top-of-task message is needed. */
  text: string
  images: PendingChatImage[]
  /** Remaining ExecutionSteps still to run, starting with (and including) the one that triggered this hand-off. */
  steps: ExecutionStep[]
  /** Shared TaskState carried forward from whatever ran before the hand-off. */
  taskState: TaskState
}

let pending: PendingStepResume | null = null

/** Queue the remainder of an in-progress decomposed task to resume once a project root exists. */
export function setPendingStepResume(value: PendingStepResume | null): void {
  pending = value
}

/** Reads and clears the queued task resumption (consume-once). */
export function takePendingStepResume(): PendingStepResume | null {
  const value = pending
  pending = null
  return value
}
