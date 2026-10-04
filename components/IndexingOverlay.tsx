// components/IndexingOverlay.tsx
//
// Non-blocking indexing indicator: a small pill anchored to the bottom of
// the window. Hovering (or focusing, for keyboard/AT users) it expands a
// popover with the animated phase list, progress bar, and live file
// counter — the same information the old full-screen overlay showed.
//
// This never blocks interaction with the rest of the IDE: the file
// explorer, editor, and terminal all stay fully usable while a project is
// being indexed in the background. Only the pill itself (and its popover)
// render anything on screen.
//
// Live progress: subscribes to `scan-progress` Tauri events emitted by
// the Rust scan_repo command. When real file counts arrive the bar and
// counter switch from the animated-phase estimate to actual numbers.
// When the sidecar only emits heartbeat ticks (total === 0), the bar
// keeps advancing via the phase animation as before.
//
// Visibility rules:
//   • Pill is shown when status === 'indexing' or 'refreshing', or for a
//     short "done" hold right after indexing finishes.
//   • Popover only opens on hover/focus — it never opens itself.

import React, { useEffect, useState, useRef } from 'react'
import { listen }         from '@tauri-apps/api/event'
import { useRepoIndex }   from '../store/useRepoIndex'
import styles             from './IndexingOverlay.module.css'

// ── Animated phases ────────────────────────────────────────────────────────
const PHASES = [
  { label: 'Analyzing Architecture',     pct: 8  },
  { label: 'Discovering Dependencies',   pct: 18 },
  { label: 'Building Code Graph',        pct: 30 },
  { label: 'Mapping Components',         pct: 44 },
  { label: 'Indexing Symbols',           pct: 57 },
  { label: 'Learning Project Structure', pct: 68 },
  { label: 'Resolving Import Chains',    pct: 76 },
  { label: 'Building Semantic Index',    pct: 87 },
  { label: 'Preparing AI Workspace',     pct: 95 },
]

// How long to keep showing the "done" state on the pill before it fades
// back to the plain "indexed" resting state (ms).
const COMPLETION_HOLD_MS = 3500

// ── Event payload type (mirrors Rust ScanProgressPayload) ─────────────────
interface ScanProgressPayload {
  scanned: number
  total:   number
  file:    string
}

export default function IndexingOverlay() {
  const status        = useRepoIndex(s => s.status)
  const scanResult    = useRepoIndex(s => s.scanResult)
  const graphSnapshot = useRepoIndex(s => s.graphSnapshot)

  // ── Phase animation state ──────────────────────────────────────────────
  const [phaseIdx,  setPhaseIdx]  = useState(0)
  const [progress,  setProgress]  = useState(0)
  const [done,      setDone]      = useState(false)
  const [showPill,  setShowPill]  = useState(false)
  const [hovered,   setHovered]   = useState(false)
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const doneTimerRef = useRef<ReturnType<typeof setTimeout>  | null>(null)

  // ── Real progress from Rust scan-progress events ───────────────────────
  const [realScanned, setRealScanned] = useState(0)
  const [realTotal,   setRealTotal]   = useState(0)
  const [realFile,    setRealFile]    = useState('')

  const isActive = status === 'indexing' || status === 'refreshing'

  // Show pill when indexing/refreshing starts; reset counters.
  useEffect(() => {
    if (isActive) {
      setShowPill(true)
      setDone(false)
      setPhaseIdx(0)
      setProgress(0)
      setRealScanned(0)
      setRealTotal(0)
      setRealFile('')

      // Phase advancer — bump one phase every ~1.4 s
      intervalRef.current = setInterval(() => {
        setPhaseIdx(prev => {
          const next = prev + 1
          if (next >= PHASES.length) {
            clearInterval(intervalRef.current!)
            return PHASES.length - 1
          }
          return next
        })
      }, 1400)

      return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
    }
  }, [isActive])

  // ── Subscribe to scan-progress events ──────────────────────────────────
  useEffect(() => {
    if (!isActive) return

    const unlistenProgress = listen<ScanProgressPayload>('scan-progress', ({ payload }) => {
      setRealScanned(payload.scanned)
      if (payload.total > 0) setRealTotal(payload.total)
      if (payload.file)      setRealFile(payload.file)
    })

    const unlistenComplete = listen('scan-complete', () => {
      setProgress(100)
    })

    return () => {
      unlistenProgress.then(u => u())
      unlistenComplete.then(u => u())
    }
  }, [isActive])

  // Smoothly animate progress toward the current phase target
  // (only used when real total is unknown)
  useEffect(() => {
    if (realTotal > 0) return          // real data drives the bar instead
    const target = PHASES[phaseIdx]?.pct ?? 0
    if (progress >= target) return
    const step = setInterval(() => {
      setProgress(prev => {
        const next = prev + 1
        if (next >= target) { clearInterval(step); return target }
        return next
      })
    }, 18)
    return () => clearInterval(step)
  }, [phaseIdx, realTotal]) // eslint-disable-line react-hooks/exhaustive-deps

  // Detect completion — briefly show a "done" pill, then hide it entirely
  // (StatusBar's own "✦ indexed" segment takes over from there).
  useEffect(() => {
    if (status === 'ready' && showPill && !done) {
      setProgress(100)
      if (intervalRef.current) clearInterval(intervalRef.current)
      setPhaseIdx(PHASES.length - 1)
      setDone(true)
      doneTimerRef.current = setTimeout(() => setShowPill(false), COMPLETION_HOLD_MS)
    }
    if (status === 'error') setShowPill(false)
    return () => { if (doneTimerRef.current) clearTimeout(doneTimerRef.current) }
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!showPill) return null

  // ── Derive display values ─────────────────────────────────────────────
  const filesIndexed = scanResult?.totalFiles ?? 0
  const symbolsFound = graphSnapshot?.stats?.nodeCount ?? 0
  const depsMappped  = graphSnapshot?.stats?.edgeCount ?? 0

  const currentPhase = PHASES[phaseIdx]?.label ?? 'Processing...'

  // When we have real totals, override the animated bar with actual ratio.
  const displayProgress = realTotal > 0
    ? Math.min(99, Math.round((realScanned / realTotal) * 100))
    : progress

  const fileTicker = realFile ? realFile.split('/').pop() ?? realFile : null

  return (
    <div
      className={styles.pillWrap}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {/* ── Popover — only rendered while hovered/focused ─────────────── */}
      {hovered && (
        <div className={styles.popover}>
          {!done ? (
            <>
              <div className={styles.popoverHeading}>Understanding Project…</div>

              <ul className={styles.phaseList}>
                {PHASES.map((p, i) => {
                  const state =
                    i < phaseIdx  ? 'done'    :
                    i === phaseIdx ? 'active'  :
                                     'pending'
                  return (
                    <li key={p.label} className={`${styles.phaseItem} ${styles[`phase_${state}`]}`}>
                      <span className={styles.phaseIcon}>
                        {state === 'done'   ? '✓' :
                         state === 'active' ? <span className={styles.spinner}/> :
                                              '○'}
                      </span>
                      {p.label}
                    </li>
                  )
                })}
              </ul>

              <div className={styles.progressWrap}>
                <div className={styles.progressBar} style={{ width: `${displayProgress}%` }} />
              </div>

              <div className={styles.progressLabel}>
                {realTotal > 0
                  ? `${realScanned.toLocaleString()} / ${realTotal.toLocaleString()} files — ${displayProgress}%`
                  : realScanned > 0
                    ? `${realScanned.toLocaleString()} files scanned…`
                    : `${displayProgress}%`}
              </div>

              {fileTicker && <div className={styles.ticker}>Scanning: {fileTicker}</div>}

              <div className={styles.popoverHint}>
                You can keep browsing files and editing — indexing runs in the background.
              </div>
            </>
          ) : (
            <>
              <div className={styles.popoverHeading}>✓ Project Understanding Complete</div>
              <div className={styles.completionStats}>
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>Files Indexed</span>
                  <span className={styles.statValue}>{filesIndexed.toLocaleString()}</span>
                </div>
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>Symbols Found</span>
                  <span className={styles.statValue}>{symbolsFound.toLocaleString()}</span>
                </div>
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>Dependencies Mapped</span>
                  <span className={styles.statValue}>{depsMappped.toLocaleString()}</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Pill ─────────────────────────────────────────────────────── */}
      <div className={`${styles.pill} ${done ? styles.pillDone : ''}`} tabIndex={0}>
        {!done ? (
          <>
            <span className={styles.pillSpinner} />
            <span className={styles.pillLabel}>{currentPhase}</span>
            <span className={styles.pillPct}>{displayProgress}%</span>
          </>
        ) : (
          <>
            <span className={styles.pillCheck}>✓</span>
            <span className={styles.pillLabel}>Indexed {filesIndexed.toLocaleString()} files</span>
          </>
        )}
      </div>
    </div>
  )
}
