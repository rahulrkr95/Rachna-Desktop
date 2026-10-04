// components/NodeSetupScreen.tsx
//
// Shown at launch, before the IDE/Doctor ever mounts, while the managed
// Node.js runtime is downloaded from nodejs.org + extracted (see
// store/useNodeSetupStore.ts and App.tsx). No account is involved. Blocking by design: nothing in
// the IDE works without a Node runtime, so there's no point letting the
// person in only to have Doctor immediately tell them the same thing.

import React from 'react'
import { useNodeSetupStore } from '../store/useNodeSetupStore'

export default function NodeSetupScreen() {
  const { status, message, runNodeSetup } = useNodeSetupStore()

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.9rem',
      height: '100vh',
      background: '#0d0d0f',
      color: status === 'error' ? '#e05a5a' : '#8a8aa0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      textAlign: 'center',
      padding: '0 2rem',
    }}>
      <div style={{ fontSize: '0.85rem', letterSpacing: '0.04em' }}>
        {status === 'error' ? 'Node.js setup failed' : 'Preparing Node.js runtime…'}
      </div>
      {message && (
        <div style={{ fontSize: '0.75rem', color: '#5a5a70', maxWidth: 420 }}>
          {message}
        </div>
      )}
      {status === 'error' && (
        <button
          onClick={() => runNodeSetup()}
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem 1.1rem',
            fontSize: '0.8rem',
            borderRadius: 6,
            border: '1px solid #3a3a4a',
            background: '#1a1a20',
            color: '#e6e6f0',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      )}
    </div>
  )
}
