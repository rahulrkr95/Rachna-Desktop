// components/CompactView.tsx
//
// The "orb" — the smallest of the app's three views. Rendered when
// useViewModeStore's mode is 'orb' (see App.tsx). The only way out of
// this view is up to the chat dialog (never straight to full — see
// store/useViewModeStore.ts's ADJACENT table). The whole orb body is
// clickable, since it's a tiny always-on-top pill with room for
// exactly one action.

import React from 'react'
import logoIcon from '../src-tauri/icons/128x128.png'
import { useTerminalPermissionStore } from '../store/useTerminalPermissionStore'
import styles from './CompactView.module.css'

interface Props {
  onExpandToChat: () => void
}

export default function CompactView({ onExpandToChat }: Props) {
  const pendingPermission = useTerminalPermissionStore(
    s => s.pendingRequest
  )

  const hasNotification = !!pendingPermission

  return (
    <div className={styles.container}>
      <button
        className={styles.orb}
        onClick={onExpandToChat}
        title={
          hasNotification
            ? 'Rachna needs your attention'
            : 'Open Rachna AI chat'
        }
        aria-label="Open Rachna AI chat"
      >
        <img
          src={logoIcon}
          alt=""
          className={styles.logo}
        />

        {hasNotification && (
          <span className={styles.notification} />
        )}
      </button>
    </div>
  )
}
