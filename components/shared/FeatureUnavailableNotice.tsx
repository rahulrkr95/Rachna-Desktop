import React from 'react'
import styles from './FeatureUnavailableNotice.module.css'

interface LockedBadgeProps {
  reason: string
  className?: string
  style?: React.CSSProperties
}

export function LockedBadge({ reason, className, style }: LockedBadgeProps) {
  return <span className={`${styles.badge} ${className ?? ''}`} style={style} title={reason}>🔒 Unavailable</span>
}

interface LockedFeaturePanelProps {
  reason: string
  className?: string
}

export function LockedFeaturePanel({ reason, className }: LockedFeaturePanelProps) {
  return (
    <div className={`${styles.panel} ${className ?? ''}`}>
      <span className={styles.panelIcon} aria-hidden>🔒</span>
      <span className={styles.panelText}>{reason}</span>
    </div>
  )
}
