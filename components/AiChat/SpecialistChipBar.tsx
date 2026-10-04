// components/AiChat/SpecialistChipBar.tsx
//
// A row of pill buttons — one per SpecialistOption — that lets the user
// manually pick which specialist this and every subsequent turn should be
// forced into (see store/useSpecialistStore.ts + lib/specialistMapping.ts),
// routing task specialists directly to the Task Planner. Defaults to DESKTOP.
// Styling mirrors the existing .autoApproveGroup / .autoApprovePill pill
// group in AiChat.module.css.

import React from 'react'
import styles from '../AiChat.module.css'
import { useSpecialistStore, SPECIALIST_OPTIONS, type SpecialistOption } from '../../store/useSpecialistStore'
import { SPECIALIST_META } from '../../lib/specialistMapping'

interface Props {
  disabled?: boolean
}

export function SpecialistChipBar({ disabled = false }: Props) {
  const specialist    = useSpecialistStore(s => s.specialist)
  const setSpecialist = useSpecialistStore(s => s.setSpecialist)

  return (
    <div className={styles.specialistGroup} role="radiogroup" aria-label="Specialist">
      {SPECIALIST_OPTIONS.map((option: SpecialistOption) => {
        const meta = SPECIALIST_META[option]
        const active = specialist === option
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${styles.specialistPill} ${active ? styles.specialistPillActive : ''}`}
            title={meta.description}
            disabled={disabled}
            onClick={() => setSpecialist(option)}
          >
            <span className={styles.specialistPillIcon}>{meta.icon}</span>
            {meta.label}
          </button>
        )
      })}
    </div>
  )
}
