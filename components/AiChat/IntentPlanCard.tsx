// components/AiChat/IntentPlanCard.tsx

import React, { useState } from 'react'
import type { IntentPlan, StepStatus } from '../../types'
import { describeIntentLabel, describeSubIntentLabel } from '../../lib/intentClassifier'
import styles from './IntentPlanCard.module.css'

interface Props {
  plan:        IntentPlan
  approved:    boolean
  /** PLAN-001: true when `approved` came from Plan Mode being OFF (auto-approve) rather than a manual click. */
  autoApproved?: boolean
  /** True once the user has clicked "Cancel Plan". Mutually exclusive with `approved` — a cancelled plan never executes. */
  cancelled?:  boolean
  /**
   * Live per-step state once `approved` is true — keyed by ExecutionStep id
   * (see StepStatus). Absent/undefined entries render as 'pending'. Not
   * used at all before approval — the plan is shown purely for review.
   */
  stepStatuses?: Record<string, StepStatus>
  /** Set when the whole execution was cancelled from a 'failed' step (see useChat's cancelExecution) — hides Retry/Mark Done/Cancel and shows a cancelled note instead. */
  executionCancelled?: boolean
  msgId:       string
  onApprove:   (msgId: string) => void
  onModify:    (msgId: string) => void
  onCancel:    (msgId: string) => void
  /** Failure Handling: re-run ONLY the 'failed' step. */
  onRetryStep?: (msgId: string) => void
  /** Failure Handling: override the 'failed' step as done (without re-running it) and continue to the next step. */
  onMarkStepDone?: (msgId: string) => void
  /** Failure Handling: cancel the whole execution from the 'failed' step onward. */
  onCancelExecution?: (msgId: string) => void
}

const STATUS_META: Record<StepStatus, { icon: string; label: string; className: keyof typeof styles }> = {
  pending:          { icon: '○', label: 'Pending',          className: 'stepStatusPending' },
  running:          { icon: '◐', label: 'Running',          className: 'stepStatusRunning' },
  completed:        { icon: '✓', label: 'Completed',        className: 'stepStatusCompleted' },
  failed:           { icon: '✕', label: 'Failed',           className: 'stepStatusFailed' },
  completed_manual: { icon: '✓', label: 'Completed (Manual)', className: 'stepStatusCompletedManual' },
  cancelled:        { icon: '⊘', label: 'Cancelled',        className: 'stepStatusCancelled' },
}

export function IntentPlanCard({
  plan, approved, autoApproved, cancelled, stepStatuses, executionCancelled, msgId,
  onApprove, onModify, onCancel, onRetryStep, onMarkStepDone, onCancelExecution,
}: Props) {
  const [modifyInput, setModifyInput] = useState('')
  const [showModify,  setShowModify]  = useState(false)

  // Once approved, the first step that isn't yet 'completed' or 'failed' is
  // the only one that should read as "active" — everything after it is
  // still strictly pending regardless of what stepStatuses happens to hold
  // (defensive: TaskExecutor runs steps strictly in order, so this should
  // already be true, but the card shouldn't rely on that to look right).
  const activeStepId = approved
    ? plan.steps.find(s => {
        const st = stepStatuses?.[s.id] ?? 'pending'
        return st === 'running' || st === 'pending'
      })?.id
    : undefined

  return (
    <div className={`${styles.card} ${approved ? styles.cardApproved : ''} ${cancelled ? styles.cardCancelled : ''}`}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.headerIcon}>📋</span>
          <span className={styles.headerTitle}>Execution Plan</span>
          <span className={styles.complexityBadge}>
            {plan.steps.length} {plan.steps.length === 1 ? 'Step' : 'Steps'}
          </span>
        </div>
        {approved && (
          <div className={styles.approvedBadge}>
            <span>{autoApproved ? '⚡' : '✓'}</span> {autoApproved ? 'Auto-approved' : 'Approved'}
          </div>
        )}
        {!approved && cancelled && (
          <div className={styles.cancelledBadge}>
            <span>✕</span> Cancelled
          </div>
        )}
        {approved && executionCancelled && (
          <div className={styles.cancelledBadge}>
            <span>⊘</span> Execution Cancelled
          </div>
        )}
      </div>

      {/* Ordered, intent-tagged steps — the planner's entire output, plus
          (once approved) each step's live pending/running/completed/failed
          state. */}
      <div className={styles.sections}>
        <div className={styles.section}>
          <ol className={styles.stepList}>
            {plan.steps.map((step, i) => {
              const status   = approved ? (stepStatuses?.[step.id] ?? 'pending') : undefined
              const isActive = approved && step.id === activeStepId
              const subLabel = describeSubIntentLabel(step.subIntent)
              const isFailed = status === 'failed'
              return (
                <li
                  key={step.id}
                  className={[
                    styles.stepItem,
                    isActive ? styles.stepItemActive : '',
                    (status === 'completed' || status === 'completed_manual') ? styles.stepItemCompleted : '',
                    isFailed ? styles.stepItemFailed : '',
                    status === 'cancelled' ? styles.stepItemCancelled : '',
                  ].filter(Boolean).join(' ')}
                >
                  <div className={styles.stepHeaderRow}>
                    <span className={styles.stepIndex}>{i + 1}</span>
                    <span className={styles.chipsRow}>
                      <span className={styles.intentChip}>{describeIntentLabel(step.intent)}</span>
                      {subLabel && <span className={styles.subIntentChip}>{subLabel}</span>}
                    </span>
                    {status && (
                      <span className={`${styles.stepStatusBadge} ${styles[STATUS_META[status].className]}`}>
                        <span className={status === 'running' ? styles.stepStatusSpinner : undefined}>
                          {STATUS_META[status].icon}
                        </span>
                        {STATUS_META[status].label}
                      </span>
                    )}
                  </div>
                  <p className={styles.stepTask}>{step.task}</p>
                  {!!step.dependsOn?.length && (
                    <p className={styles.stepDepends}>Depends on: {step.dependsOn.join(', ')}</p>
                  )}

                  {/* ── Failure Handling ─────────────────────────────────
                       Execution has already stopped at this step — none of
                       the steps after it have run or will run until one of
                       these three is used. Hidden once the whole execution
                       has been cancelled (executionCancelled). */}
                  {isFailed && !executionCancelled && (
                    <div className={styles.stepFailureActions}>
                      {onRetryStep && (
                        <button className={styles.btnRetryStep} onClick={() => onRetryStep(msgId)}>
                          ↻ Retry Step
                        </button>
                      )}
                      {onMarkStepDone && (
                        <button className={styles.btnMarkDone} onClick={() => onMarkStepDone(msgId)}>
                          ✓ Mark Done
                        </button>
                      )}
                      {onCancelExecution && (
                        <button className={styles.btnCancelExecution} onClick={() => onCancelExecution(msgId)}>
                          ✕ Cancel Execution
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      </div>

      {/* Action buttons — hidden once approved or cancelled */}
      {!approved && !cancelled && (
        <div className={styles.actions}>
          {!showModify ? (
            <>
              <button
                className={styles.btnApprove}
                onClick={() => onApprove(msgId)}
              >
                ✓ Approve Plan
              </button>
              <button
                className={styles.btnModify}
                onClick={() => setShowModify(true)}
              >
                ✎ Modify Plan
              </button>
              <button
                className={styles.btnCancelPlan}
                onClick={() => onCancel(msgId)}
              >
                ✕ Cancel
              </button>
            </>
          ) : (
            <div className={styles.modifyRow}>
              <textarea
                className={styles.modifyInput}
                placeholder="Describe what you'd like to change about this plan…"
                value={modifyInput}
                onChange={e => setModifyInput(e.target.value)}
                rows={2}
                autoFocus
              />
              <div className={styles.modifyBtns}>
                <button
                  className={styles.btnApprove}
                  onClick={() => {
                    // Inject the modification request into chat input via callback
                    onModify(msgId + '::' + modifyInput)
                    setShowModify(false)
                    setModifyInput('')
                  }}
                  disabled={!modifyInput.trim()}
                >
                  Send Feedback
                </button>
                <button
                  className={styles.btnCancel}
                  onClick={() => setShowModify(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
