// components/AiChat/TerminateRunConfirmModal.tsx
//
// Shown whenever handleSend/handleRetry/handleEditMessage (see useChat.ts's
// requestOrRun) fires while a turn is already streaming. Those three used
// to just silently no-op mid-run; now they queue the action and pop this
// modal instead — confirming stops the in-flight run (handleStop, which
// also settles any still-'running' agent-activity/plan-step animations)
// and then fires the queued send/retry/edit; cancelling leaves the current
// run untouched and drops the queued action.
//
// Purely presentational + control flow, same pattern as
// CloseProjectConfirmModal.tsx — AiChat.tsx wires it to useChat's
// pendingTerminateConfirm/confirmTerminateRun/cancelTerminateConfirm.

import React, { useEffect, useRef } from 'react'
import styles from './TerminateRunConfirmModal.module.css'

interface Props {
  /** Which action triggered this — only changes the wording shown. */
  kind: 'send' | 'retry' | 'edit'
  onConfirm: () => void
  onCancel:  () => void
}

const KIND_COPY: Record<Props['kind'], { verb: string; detail: string }> = {
  send:  { verb: 'send this message', detail: 'A response is still being generated for your last message.' },
  retry: { verb: 'retry this message', detail: 'A response is still being generated.' },
  edit:  { verb: 'send your edit',     detail: 'A response is still being generated.' },
}

export function TerminateRunConfirmModal({ kind, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const { verb, detail } = KIND_COPY[kind]

  useEffect(() => {
    setTimeout(() => confirmRef.current?.focus(), 50)
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      className={styles.backdrop}
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm stop current response"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className={styles.dialog}>
        <div className={styles.header}>
          <span className={styles.icon}>⚠</span>
          <span className={styles.title}>Stop the current response?</span>
        </div>

        <p className={styles.body}>
          {detail} To {verb}, the response in progress needs to be stopped first —
          any output it's produced so far will stay in the chat, but it won't finish.
        </p>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel}>
            Keep going
          </button>
          <button ref={confirmRef} className={styles.confirmBtn} onClick={onConfirm}>
            Stop &amp; continue
          </button>
        </div>
      </div>
    </div>
  )
}
