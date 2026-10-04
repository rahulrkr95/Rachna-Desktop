// components/AiChat/ClarificationCard.tsx
//
// Rendered inside an AI chat message BEFORE the intent-based Task Planner
// runs, when the Agentic Classifier (see lib/agenticClassifier.ts) flagged
// the raw message as needing confirmation first — see the `clarification`
// field it attaches to ChatMessage (types/index.ts) and
// useChat.ts::presentClarificationOrPlan / resolveClarification.
//
// Two things can show up here, independently or together in the same card:
//   - correctedText -- the raw message looked like a typo'd/garbled version
//     of an automatable task. Shown as "Did you mean...?" with Yes/No — Yes
//     proceeds with the corrected wording, No proceeds with the original.
//   - questions -- up to 3 short clarifying questions the classifier needs
//     answered before the task can be planned. Shown as plain text inputs;
//     answers are optional per-question (an empty answer is still sent —
//     the planner treats a blank as "not specified" rather than blocking
//     the user from proceeding).
//
// Submitting resolves the card (mirrors PendingToggleCard's
// "no free-text round trip through classification" pattern) and hands the
// final text straight to generateExecutionPlan — never back through the
// classifier again.

import React, { useState } from 'react'
import styles from './ClarificationCard.module.css'

interface Props {
  msgId:         string
  correctedText?: string
  questions?:     string[]
  answers?:       string[]
  resolved:       boolean
  useOriginal?:   boolean
  disabled:       boolean
  onResolve: (msgId: string, result: { useCorrection: boolean; answers?: string[] }) => void
}

export function ClarificationCard({
  msgId, correctedText, questions, answers, resolved, useOriginal, disabled, onResolve,
}: Props) {
  const [draftAnswers, setDraftAnswers] = useState<string[]>(() => (questions ?? []).map(() => ''))

  const hasQuestions  = !!questions && questions.length > 0
  const hasCorrection = !!correctedText

  const handleAnswerChange = (idx: number, value: string) => {
    setDraftAnswers(prev => {
      const next = [...prev]
      next[idx] = value
      return next
    })
  }

  const submit = (useCorrection: boolean) => {
    onResolve(msgId, { useCorrection, answers: hasQuestions ? draftAnswers : undefined })
  }

  if (resolved) {
    return (
      <div className={`${styles.card} ${styles.cardResolved}`}>
        <div className={styles.row}>
          <span className={styles.icon}>✓</span>
          <div className={styles.textCol}>
            <div className={styles.title}>
              {hasCorrection
                ? (useOriginal ? 'Continuing with your original wording' : 'Continuing with the corrected request')
                : 'Thanks — continuing with your answers'}
            </div>
            {hasQuestions && answers && answers.some(a => a.trim()) && (
              <div className={styles.subtitle}>
                {questions!.map((q, i) => (
                  answers[i]?.trim() ? <div key={i}><strong>{q}</strong> {answers[i]}</div> : null
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.card}>
      {hasCorrection && (
        <div className={styles.section}>
          <div className={styles.row}>
            <span className={styles.icon}>💡</span>
            <div className={styles.textCol}>
              <div className={styles.title}>Did you mean...?</div>
              <div className={styles.correctedText}>{correctedText}</div>
            </div>
          </div>
          {!hasQuestions && (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={disabled}
                onClick={() => submit(true)}
                title="Proceed with the corrected request"
              >
                Yes, use this
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={disabled}
                onClick={() => submit(false)}
                title="Proceed with what you originally typed"
              >
                No, use my original wording
              </button>
            </div>
          )}
        </div>
      )}

      {hasQuestions && (
        <div className={styles.section}>
          <div className={styles.row}>
            <span className={styles.icon}>❓</span>
            <div className={styles.title}>Just to make sure I get this right:</div>
          </div>
          <div className={styles.questionList}>
            {questions!.map((q, i) => (
              <label key={i} className={styles.questionItem}>
                <span className={styles.questionText}>{q}</span>
                <input
                  type="text"
                  className={styles.answerInput}
                  value={draftAnswers[i] ?? ''}
                  disabled={disabled}
                  onChange={e => handleAnswerChange(i, e.target.value)}
                  placeholder="Your answer (optional)"
                />
              </label>
            ))}
          </div>
          <div className={styles.actions}>
            {hasCorrection ? (
              <>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={disabled}
                  onClick={() => submit(true)}
                  title="Use the corrected request plus these answers"
                >
                  Use correction & continue
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={disabled}
                  onClick={() => submit(false)}
                  title="Use your original wording plus these answers"
                >
                  Use original wording & continue
                </button>
              </>
            ) : (
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={disabled}
                onClick={() => submit(false)}
                title="Continue planning with these answers"
              >
                Continue →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
