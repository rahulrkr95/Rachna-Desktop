// components/DoctorPanel.tsx
//
// Environment Doctor panel. Checks required and optional runtime
// dependencies (Node.js, npm, npx, Ollama, Playwright, repo scanner, Git)
// by calling the Rust `doctor_check` command, then renders each result as
// a pass/warn/fail row with a one-click copy and "Run Fix" button.
// Language toolchains and LSP servers (Rust/Python/Go + their LSPs) are
// only checked by the backend when a project is open — see doctor_check
// in commands.rs — so with no project open this panel just shows Core +
// Optional checks.
//
// On every open it re-runs checks so fresh installs show immediately.
// "Run Fix" executes the fix_command via run_terminal_command and shows
// inline output, then refreshes checks on success. An optional "MCP
// Connections" button (via onOpenMcp) links out to the MCP settings screen.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import styles from './DoctorPanel.module.css'
import { useRepoIndex } from '../store/useRepoIndex'

// ── resolveFixCwd ────────────────────────────────────────────────────────────
//
// Fix commands (e.g. `npm run scanner:build`) are project-relative — they
// only make sense when run from the open project's root (that's where
// package.json / lib/repo-scanner live). Previously these always ran from
// the user's home directory (or `C:\Users` on Windows), which broke any
// fix that depends on being inside the project. Prefer the open project's
// root; only fall back to home when no project is open.
async function resolveFixCwd(projectRoot: string | null): Promise<string> {
  if (projectRoot) return projectRoot
  try {
    const platform = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label
      ? await invoke<string>('get_platform').catch(() => 'linux')
      : 'linux'
    if (platform === 'windows') {
      return await invoke<string>('get_home_dir').catch(() => 'C:\\')
    }
    return await invoke<string>('get_home_dir').catch(() => '/tmp')
  } catch {
    return '/tmp'
  }
}

interface DoctorCheckResult {
  id: string
  label: string
  group: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  version?: string | null
  fix_hint?: string | null
  fix_command?: string | null
}

interface CommandOutput {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
}

const STATUS_ICON: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✗' }
const STATUS_PILL: Record<string, string> = {
  ok:   styles.statusOk,
  warn: styles.statusWarn,
  fail: styles.statusFail,
}

// Known "Optional" checks, kept client-side so their checkbox row still
// renders even when unticked (the backend skips unticked optional checks
// entirely, so there's no result to derive a row from in that case).
const OPTIONAL_ITEMS_META: { id: string; label: string }[] = [
  { id: 'ollama',     label: 'Ollama (semantic search)' },
  { id: 'playwright', label: 'Playwright Chromium' },
  { id: 'git',        label: 'Git' },
]

// ── CopyButton ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }, [text])

  return (
    <button
      className={`${styles.copyBtn} ${copied ? styles.copied : ''}`}
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? '✓' : '⎘'}
    </button>
  )
}

// ── RunFixButton ────────────────────────────────────────────────────────────

interface RunFixButtonProps {
  command: string
  projectRoot: string | null
  onSuccess?: () => void
}

function RunFixButton({ command, projectRoot, onSuccess }: RunFixButtonProps) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [output, setOutput] = useState<string | null>(null)
  const outputRef = useRef<HTMLPreElement>(null)

  const handleRun = useCallback(async () => {
    // If it's a URL (open https://...), just open it
    if (command.startsWith('open ') || command.startsWith('https://') || command.startsWith('http://')) {
      const url = command.replace(/^open\s+/, '')
      window.open(url, '_blank')
      return
    }

    setState('running')
    setOutput(null)

    // Determine cwd: prefer the open project's root (fix commands like
    // `npm run scanner:build` are project-relative), falling back to the
    // home directory only when no project is open.
    const cwd = await resolveFixCwd(projectRoot)

    try {
      const result = await invoke<CommandOutput>('run_terminal_command', {
        command,
        cwd,
        timeoutSeconds: 120,
      })

      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      setOutput(combined || '(no output)')

      if (result.exit_code === 0 || result.exit_code === null) {
        setState('done')
        onSuccess?.()
      } else {
        setState('error')
      }
    } catch (err) {
      setOutput(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [command, projectRoot, onSuccess])

  // Auto-scroll output
  useEffect(() => {
    if (output && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output])

  const isUrl = command.startsWith('open ') || command.startsWith('https://') || command.startsWith('http://')

  return (
    <div className={styles.runFixWrap}>
      <button
        className={`${styles.runFixBtn} ${state === 'running' ? styles.runFixRunning : state === 'done' ? styles.runFixDone : state === 'error' ? styles.runFixError : ''}`}
        onClick={handleRun}
        disabled={state === 'running'}
        title={isUrl ? 'Open download page' : 'Run this command to install'}
      >
        {state === 'idle'   && (isUrl ? '↗ Open' : '▶ Install')}
        {state === 'running' && <><span className={styles.spinnerSm} /> Running…</>}
        {state === 'done'   && '✓ Done'}
        {state === 'error'  && '✗ Failed'}
      </button>

      {output && (
        <pre ref={outputRef} className={`${styles.fixOutput} ${state === 'error' ? styles.fixOutputError : ''}`}>
          {output}
        </pre>
      )}
    </div>
  )
}

// ── InstallAllButton ────────────────────────────────────────────────────────

interface InstallAllButtonProps {
  items: DoctorCheckResult[]
  projectRoot: string | null
  onDone?: () => void
}

function InstallAllButton({ items, projectRoot, onDone }: InstallAllButtonProps) {
  const fixable = items.filter(
    r => r.status !== 'ok' && r.fix_command &&
      !r.fix_command.startsWith('open ') &&
      !r.fix_command.startsWith('https://') &&
      !r.fix_command.startsWith('http://')
  )
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState<string[]>([])
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [progress])

  const handleInstallAll = useCallback(async () => {
    if (fixable.length === 0) return
    setState('running')
    setProgress([])

    // Prefer the open project's root — fix commands like
    // `npm run scanner:build` are project-relative.
    const cwd = await resolveFixCwd(projectRoot)

    let anyError = false
    for (const item of fixable) {
      const cmd = item.fix_command!
      setProgress(p => [...p, `▶ [${item.label}] ${cmd}`])
      try {
        const result = await invoke<CommandOutput>('run_terminal_command', {
          command: cmd,
          cwd,
          timeoutSeconds: 180,
        })
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
        if (result.exit_code === 0 || result.exit_code === null) {
          setProgress(p => [...p, `✓ [${item.label}] Done${combined ? '\n' + combined : ''}`])
        } else {
          anyError = true
          setProgress(p => [...p, `✗ [${item.label}] Failed (exit ${result.exit_code})${combined ? '\n' + combined : ''}`])
        }
      } catch (err) {
        anyError = true
        setProgress(p => [...p, `✗ [${item.label}] Error: ${err instanceof Error ? err.message : String(err)}`])
      }
    }

    setState(anyError ? 'error' : 'done')
    setTimeout(() => onDone?.(), 1500)
  }, [fixable, projectRoot, onDone])

  if (fixable.length === 0) return null

  return (
    <div className={styles.installAllWrap}>
      <button
        className={`${styles.installAllBtn} ${
          state === 'running' ? styles.runFixRunning :
          state === 'done'    ? styles.runFixDone    :
          state === 'error'   ? styles.runFixError   : ''
        }`}
        onClick={handleInstallAll}
        disabled={state === 'running'}
        title={`Install all ${fixable.length} fixable items`}
      >
        {state === 'idle'    && `⬇ Install All (${fixable.length})`}
        {state === 'running' && <><span className={styles.spinnerSm} /> Installing…</>}
        {state === 'done'    && '✓ All installed'}
        {state === 'error'   && '⚠ Some installs failed'}
      </button>
      {progress.length > 0 && (
        <pre
          ref={outputRef}
          className={`${styles.fixOutput} ${state === 'error' ? styles.fixOutputError : ''}`}
          style={{ marginTop: 8 }}
        >
          {progress.join('\n')}
        </pre>
      )}
    </div>
  )
}

// ── DoctorPanel ────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  onOpenMcp?: () => void
}

const OPTIONAL_PREF_KEY = 'rachna.doctor.disabledOptionalIds'
const ALL_OPTIONAL_IDS = OPTIONAL_ITEMS_META.map(m => m.id)

// Optional checks are unticked (unverified) by default — they only get run
// once the user explicitly ticks them (or hits "Install All" on one that's
// already ticked). Until a preference has ever been saved, treat every
// known optional id as disabled; once the user has interacted with a
// checkbox even once, respect exactly what's saved (which may legitimately
// be an empty list, meaning "verify everything").
function loadDisabledOptionalIds(): string[] {
  try {
    const raw = localStorage.getItem(OPTIONAL_PREF_KEY)
    if (!raw) return ALL_OPTIONAL_IDS
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : ALL_OPTIONAL_IDS
  } catch {
    return ALL_OPTIONAL_IDS
  }
}

function saveDisabledOptionalIds(ids: string[]) {
  try { localStorage.setItem(OPTIONAL_PREF_KEY, JSON.stringify(ids)) } catch {}
}

export default function DoctorPanel({ open, onClose, onOpenMcp }: Props) {
  const projectRoot = useRepoIndex(s => s.projectRoot)
  const [results,  setResults]  = useState<DoctorCheckResult[] | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [runCount, setRunCount] = useState(0)
  // IDs of "Optional" group checks the user has unticked — these are
  // skipped entirely by the backend so only required items (plus any
  // optional item still ticked) get verified. Unticked (unverified) by
  // default — the user has to explicitly tick an optional item before it's
  // ever run; persisted across sessions once the user interacts.
  const [disabledOptionalIds, setDisabledOptionalIds] = useState<string[]>(loadDisabledOptionalIds)

  // ── Live check progress ──────────────────────────────────────────────────
  // Commands the backend runs while checking (e.g. `node --version`) used
  // to be surfaced by forcing the app's Terminal panel open. Instead, the
  // backend's `doctor-log` events are now shown right here, in an overlay
  // merged with the loading spinner, so the panel never has to leave itself.
  const [logLines, setLogLines] = useState<string[]>([])
  const logScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let unlisten: (() => void) | undefined
    listen<{ line: string }>('doctor-log', ({ payload }) => {
      setLogLines(prev => [...prev, payload.line])
    }).then(fn => { unlisten = fn })
    return () => { unlisten?.() }
  }, [open])

  // Auto-scroll the log to the newest line as it streams in.
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight
    }
  }, [logLines])

  const runChecks = useCallback(async () => {
    setLoading(true)
    setLogLines([])
    try {
      // Pass the open project's root so Doctor only asks for the language
      // toolchains (Rust/Python/Go) and LSP servers that project actually
      // uses — no project open means no language-specific checks at all.
      const data = await invoke<DoctorCheckResult[]>('doctor_check', {
        projectRoot: projectRoot ?? null,
        disabledOptionalIds,
      })
      setResults(data)
    } catch (err) {
      console.error('Doctor check failed:', err)
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [projectRoot, disabledOptionalIds])

  const toggleOptional = useCallback((id: string, verify: boolean) => {
    setDisabledOptionalIds(prev => {
      const next = verify ? prev.filter(x => x !== id) : Array.from(new Set([...prev, id]))
      saveDisabledOptionalIds(next)
      return next
    })
    // Re-run so the toggled item is immediately included/excluded.
    setRunCount(c => c + 1)
  }, [])

  // Run whenever the panel opens (or when the user hits Refresh)
  useEffect(() => {
    if (open) { setRunCount(c => c + 1) }
  }, [open])

  useEffect(() => {
    if (runCount > 0) runChecks()
  }, [runCount, runChecks])

  if (!open) return null

  // ── Group results ──────────────────────────────────────────────────────
  const groups: Record<string, DoctorCheckResult[]> = {}
  if (results) {
    for (const r of results) {
      if (!groups[r.group]) groups[r.group] = []
      groups[r.group].push(r)
    }
    // Add placeholder rows for optional checks the user has unticked —
    // the backend skips these entirely, so there's no real result to show,
    // but the checkbox still needs a row to live on.
    for (const meta of OPTIONAL_ITEMS_META) {
      if (disabledOptionalIds.includes(meta.id) && !groups['Optional']?.some(r => r.id === meta.id)) {
        if (!groups['Optional']) groups['Optional'] = []
        groups['Optional'].push({
          id: meta.id,
          label: meta.label,
          group: 'Optional',
          status: 'warn',
          detail: 'Not verified — tick the checkbox to include this in the scan',
        })
      }
    }
  }

  const okCount   = results?.filter(r => r.status === 'ok').length   ?? 0
  const warnCount = results?.filter(r => r.status === 'warn').length  ?? 0
  const failCount = results?.filter(r => r.status === 'fail').length  ?? 0

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <span style={{ fontSize: 18 }}>🩺</span>
          <div style={{ flex: 1 }}>
            <div className={styles.title}>Environment Check</div>
            <div className={styles.subtitle}>
              Checks runtime dependencies required by Rachna AI Studio
            </div>
          </div>
          {onOpenMcp && (
            <button
              className={styles.refreshBtn}
              onClick={onOpenMcp}
              title="Go to MCP Connections"
            >
              🔌 MCP Connections
            </button>
          )}
          <button
            className={styles.refreshBtn}
            onClick={() => setRunCount(c => c + 1)}
            disabled={loading}
          >
            {loading ? 'Running…' : '↺ Refresh'}
          </button>
          <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {loading && (
            <div className={styles.checkOverlay}>
              <div className={styles.checkOverlayCard}>
                <div className={styles.checkOverlaySpinnerRow}>
                  <span className={styles.spinner} />
                  Running environment checks…
                </div>
                {logLines.length > 0 && (
                  <div ref={logScrollRef} className={styles.checkOverlayLog}>
                    {logLines.map((line, i) => (
                      <div key={i} className={styles.checkOverlayLogLine}>{line}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {results && !loading && (
            <>
              {/* Summary row */}
              <div className={styles.summary}>
                <div className={styles.summaryItem}>
                  <span style={{ color: 'var(--green)' }}>✓</span>
                  <span>{okCount} passed</span>
                </div>
                {warnCount > 0 && (
                  <div className={styles.summaryItem}>
                    <span style={{ color: 'var(--warning)' }}>⚠</span>
                    <span>{warnCount} warning{warnCount !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {failCount > 0 && (
                  <div className={styles.summaryItem}>
                    <span style={{ color: 'var(--error)' }}>✗</span>
                    <span>{failCount} failed — use Install buttons below to fix</span>
                  </div>
                )}
              </div>

              {/* Install All */}
              <InstallAllButton
                items={results}
                projectRoot={projectRoot}
                onDone={() => setTimeout(() => setRunCount(c => c + 1), 1500)}
              />

              {/* Grouped results */}
              {Object.entries(groups).map(([group, items]) => (
                <div key={group} className={styles.group}>
                  <div className={styles.groupLabel}>{group}</div>
                  {items.map(item => (
                    <div key={item.id} className={styles.row}>
                      {group === 'Optional' ? (
                        <input
                          type="checkbox"
                          className={styles.optionalCheckbox}
                          checked={!disabledOptionalIds.includes(item.id)}
                          onChange={(e) => toggleOptional(item.id, e.target.checked)}
                          title={
                            disabledOptionalIds.includes(item.id)
                              ? 'Not verified — tick to include in Doctor scan'
                              : 'Verified in Doctor scan — untick to skip'
                          }
                        />
                      ) : (
                        <span className={styles.rowSpacer} />
                      )}
                      <span
                        className={styles.icon}
                        style={{
                          color:
                            item.status === 'ok'   ? 'var(--green)' :
                            item.status === 'warn' ? 'var(--warning)'      : 'var(--error)',
                        }}
                      >
                        {STATUS_ICON[item.status]}
                      </span>

                      <div className={styles.info}>
                        <div className={styles.rowLabel}>{item.label}</div>
                        <div className={styles.rowDetail}>{item.detail}</div>
                        {item.fix_hint && item.status !== 'ok' && (
                          <div className={styles.fixHint}>{item.fix_hint}</div>
                        )}
                        {item.fix_command && item.status !== 'ok' && (
                          <div className={styles.fixRow}>
                            <span
                              className={styles.fixCmd}
                              title="Click to copy"
                              onClick={() => navigator.clipboard.writeText(item.fix_command!).catch(() => {})}
                            >
                              {item.fix_command}
                            </span>
                            <CopyButton text={item.fix_command} />
                            <RunFixButton
                              command={item.fix_command}
                              projectRoot={projectRoot}
                              onSuccess={() => setTimeout(() => setRunCount(c => c + 1), 1500)}
                            />
                          </div>
                        )}
                      </div>

                      <span className={`${styles.statusPill} ${STATUS_PILL[item.status]}`}>
                        {item.status.toUpperCase()}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

