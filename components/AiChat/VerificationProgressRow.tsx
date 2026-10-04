// components/AiChat/VerificationProgressRow.tsx
//
// UX-001 — Agent Execution Timeline: "verification progress".
//
// EditStore already runs build/test/lint checks in the background after
// edits are merged and stores their final results (buildResults/testResults/
// lintResults, surfaced per-edit in DiffPanel) — but until now there was no
// live indication that a check was *in progress*, only the eventual
// Verified/Failed badge once it finished. This row reads EditStore's
// `verifying` map (set true right before each check starts, cleared right
// after) so the timeline can show "Verifying build + tests…" while the
// agent's merged changes are actually being checked.

import { useEditStore, selectAnyVerifying, selectVerifyingLabel } from '../../services/edits/EditStore'
import styles from '../AiChat.module.css'

export function VerificationProgressRow() {
  const anyVerifying = useEditStore(selectAnyVerifying)
  const label = useEditStore(selectVerifyingLabel)

  if (!anyVerifying || !label) return null

  return (
    <div className={styles.verifyRow}>
      <span className={styles.verifySpinner}>⟳</span>
      <span className={styles.verifyLabel}>{label}</span>
    </div>
  )
}
