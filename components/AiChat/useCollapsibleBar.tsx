// components/AiChat/useCollapsibleBar.ts
//
// Tiny shared bit of state for the retractable "ACTIONS" bar in
// AiChat.tsx. Each bar gets its own independent collapsed/expanded state,
// remembered per-browser via localStorage so it survives reloads and new
// chats.

import { useCallback, useState } from 'react'

function readInitial(storageKey: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(storageKey) === '1'
  } catch {
    return false
  }
}

export function useCollapsibleBar(storageKey: string) {
  const [collapsed, setCollapsed] = useState(() => readInitial(storageKey))

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0')
      } catch {
        // localStorage unavailable (private mode, etc.) — state still
        // works for the current session, it just won't persist.
      }
      return next
    })
  }, [storageKey])

  return { collapsed, toggle }
}

// Small chevron used as the collapse/expand affordance. Points down when
// expanded, rotates to point sideways (via CSS) when collapsed.
export function CollapseChevron() {
  return (
    <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2.5 4.5L6 8L9.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
