// components/RunConfigPanel.tsx
//
// Run Configuration panel — lets the user define (or AI-detect) a build
// command, a run command, and env vars for the open project, then execute
// them. Follows the same modal shape as McpSettingsPanel.tsx / DoctorPanel.tsx.
//
// Execution:
//   • "Run Build"  → one-shot via `run_terminal_command` (blocking, capped
//     duration) — output shown inline in the panel. Right tool for
//     `npm run build` / `cargo build` / `pip install` style commands that
//     finish and exit.
//   • "Run"        → handed off to the embedded terminal (onRunCommand
//     prop, wired by IDELayout) since dev servers / long-running processes
//     need an interactive PTY, not a capped one-shot exec.

import React, { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import styles from './RunConfigPanel.module.css'
import {
  useRunConfigStore,
  selectActiveRunConfig,
} from '../store/useRunConfigStore'
import { envJsonToEntries, type EnvVarEntry, type RunConfig } from '../lib/runConfig'

// ── Env var editor row ───────────────────────────────────────────────────

function EnvRow({
  entry, onChange, onRemove,
}: {
  entry: EnvVarEntry
  onChange: (next: EnvVarEntry) => void
  onRemove: () => void
}) {
  return (
    <div className={styles.envRow}>
      <input
        className={styles.input}
        placeholder="KEY"
        value={entry.key}
        onChange={e => onChange({ ...entry, key: e.target.value })}
      />
      <input
        className={styles.input}
        placeholder="value"
        value={entry.value}
        onChange={e => onChange({ ...entry, value: e.target.value })}
      />
      <button className={styles.removeEnvBtn} onClick={onRemove} title="Remove">✕</button>
    </div>
  )
}

// ── Editable form state derived from a RunConfig (or blank for "new") ─────

interface FormState {
  id: string | null
  name: string
  buildCommand: string
  runCommand: string
  env: EnvVarEntry[]
  cwd: string
}

function blankForm(): FormState {
  return { id: null, name: 'Default', buildCommand: '', runCommand: '', env: [], cwd: '' }
}

function formFromConfig(c: RunConfig): FormState {
  return {
    id: c.id,
    name: c.name,
    buildCommand: c.build_command,
    runCommand: c.run_command,
    env: envJsonToEntries(c.env_json),
    cwd: c.cwd ?? '',
  }
}

// ── Props ───────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  projectRoot: string | null
  /** Sends `command` to a new/existing embedded terminal tab and reveals it. */
  onRunCommand: (command: string, cwd?: string) => void
}

export default function RunConfigPanel({ open, onClose, projectRoot, onRunCommand }: Props) {
  const configs      = useRunConfigStore(s => s.configs)
  const loading      = useRunConfigStore(s => s.loading)
  const saving       = useRunConfigStore(s => s.saving)
  const error        = useRunConfigStore(s => s.error)
  const detecting    = useRunConfigStore(s => s.detecting)
  const detectError  = useRunConfigStore(s => s.detectError)
  const lastDetected = useRunConfigStore(s => s.lastDetected)
  const save         = useRunConfigStore(s => s.save)
  const remove       = useRunConfigStore(s => s.remove)
  const setActive    = useRunConfigStore(s => s.setActive)
  const detectWithAI = useRunConfigStore(s => s.detectWithAI)
  const clearDetected = useRunConfigStore(s => s.clearDetected)
  const clearError    = useRunConfigStore(s => s.clearError)
  const activeConfig  = useRunConfigStore(selectActiveRunConfig)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(blankForm())
  const [buildOutput, setBuildOutput] = useState<string | null>(null)
  const [buildRunning, setBuildRunning] = useState(false)
  const [buildFailed, setBuildFailed] = useState(false)

  // Pick a sensible selection whenever the panel opens or configs change.
  useEffect(() => {
    if (!open) return
    if (selectedId && configs.some(c => c.id === selectedId)) return
    const initial = activeConfig ?? configs[0] ?? null
    if (initial) {
      setSelectedId(initial.id)
      setForm(formFromConfig(initial))
    } else {
      setSelectedId(null)
      setForm(blankForm())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, configs])

  const selectConfig = useCallback((c: RunConfig) => {
    setSelectedId(c.id)
    setForm(formFromConfig(c))
    setBuildOutput(null)
    clearDetected()
  }, [clearDetected])

  const startNew = useCallback(() => {
    setSelectedId(null)
    setForm(blankForm())
    setBuildOutput(null)
    clearDetected()
  }, [clearDetected])

  // Apply the most recent AI detection result into the editable form.
  const applyDetected = useCallback(() => {
    if (!lastDetected) return
    setForm(f => ({
      ...f,
      name: lastDetected.name || f.name,
      buildCommand: lastDetected.buildCommand,
      runCommand: lastDetected.runCommand,
      env: lastDetected.env.length > 0 ? lastDetected.env : f.env,
      cwd: lastDetected.cwd ?? f.cwd,
    }))
    clearDetected()
  }, [lastDetected, clearDetected])

  // Auto-apply an AI detection result into the form when it arrives and the
  // user hasn't started filling anything in yet (fresh project, no saved
  // configs). Saves an extra click for the common "detect → confirm → run"
  // path — including when the panel was opened externally via the chat's
  // RUN_PROJECT intent (see useChat.ts), which kicks off detection before
  // the user has ever seen this form.
  useEffect(() => {
    if (lastDetected && !form.id && !form.buildCommand.trim() && !form.runCommand.trim()) {
      applyDetected()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDetected])

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) return
    const result = await save({
      id: form.id,
      name: form.name.trim(),
      buildCommand: form.buildCommand.trim(),
      runCommand: form.runCommand.trim(),
      env: form.env,
      cwd: form.cwd.trim() || null,
    })
    if (result) {
      setSelectedId(result.id)
      setForm(formFromConfig(result))
    }
  }, [form, save])

  const handleDelete = useCallback(async () => {
    if (!form.id) return
    await remove(form.id)
    startNew()
  }, [form.id, remove, startNew])

  const handleRunBuild = useCallback(async () => {
    if (!projectRoot || !form.buildCommand.trim()) return
    setBuildRunning(true)
    setBuildFailed(false)
    setBuildOutput(null)
    try {
      const cwd = form.cwd.trim()
        ? `${projectRoot.replace(/[\\/]+$/, '')}/${form.cwd.trim().replace(/^[\\/]+/, '')}`
        : projectRoot
      const result = await invoke<{ stdout: string; stderr: string; exit_code: number | null }>(
        'run_terminal_command',
        { command: form.buildCommand, cwd, timeoutSeconds: 180 },
      )
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      setBuildOutput(combined || '(no output)')
      setBuildFailed((result.exit_code ?? 0) !== 0)
    } catch (err) {
      setBuildOutput(err instanceof Error ? err.message : String(err))
      setBuildFailed(true)
    } finally {
      setBuildRunning(false)
    }
  }, [projectRoot, form.buildCommand, form.cwd])

  const handleRun = useCallback(() => {
    if (!form.runCommand.trim()) return
    const envPrefix = form.env
      .filter(e => e.key.trim())
      .map(e => `export ${e.key.trim()}=${JSON.stringify(e.value)}`)
      .join(' && ')
    const fullCommand = envPrefix ? `${envPrefix} && ${form.runCommand}` : form.runCommand
    onRunCommand(fullCommand, form.cwd.trim() || undefined)
    onClose()
  }, [form, onRunCommand, onClose])

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span style={{ fontSize: 18 }}>▶</span>
          <div style={{ flex: 1 }}>
            <div className={styles.title}>Run Configuration</div>
            <div className={styles.subtitle}>Build command, run command, and env vars for this project</div>
          </div>
          <button className={styles.addBtn} onClick={startNew}>+ New</button>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          {!projectRoot ? (
            <div className={styles.empty}>Open a project folder first.</div>
          ) : (
            <div className={styles.layout}>
              {/* ── Sidebar: saved configs ─────────────────────────────── */}
              <div className={styles.sidebar}>
                {loading && <div className={styles.hint}>Loading…</div>}
                {!loading && configs.length === 0 && (
                  <div className={styles.hint}>No run configs yet.</div>
                )}
                {configs.map(c => (
                  <button
                    key={c.id}
                    className={`${styles.configItem} ${c.id === selectedId ? styles.configItemActive : ''}`}
                    onClick={() => selectConfig(c)}
                  >
                    <span className={styles.configName}>{c.name}</span>
                    {c.is_active && <span className={styles.activeBadge}>active</span>}
                  </button>
                ))}
              </div>

              {/* ── Main: editable form ────────────────────────────────── */}
              <div className={styles.main}>
                {error && <div className={styles.errorText}>{error} <button className={styles.linkBtn} onClick={clearError}>dismiss</button></div>}

                <div className={styles.field}>
                  <label className={styles.label}>Name</label>
                  <input
                    className={styles.input}
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Dev server"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Working directory (relative to project root, optional)</label>
                  <input
                    className={styles.input}
                    value={form.cwd}
                    onChange={e => setForm(f => ({ ...f, cwd: e.target.value }))}
                    placeholder="e.g. server or leave blank for project root"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Build command</label>
                  <input
                    className={styles.input}
                    value={form.buildCommand}
                    onChange={e => setForm(f => ({ ...f, buildCommand: e.target.value }))}
                    placeholder="e.g. npm run build"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Run command</label>
                  <input
                    className={styles.input}
                    value={form.runCommand}
                    onChange={e => setForm(f => ({ ...f, runCommand: e.target.value }))}
                    placeholder="e.g. npm run dev"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Environment variables</label>
                  {form.env.map((entry, i) => (
                    <EnvRow
                      key={i}
                      entry={entry}
                      onChange={next => setForm(f => ({ ...f, env: f.env.map((e, idx) => idx === i ? next : e) }))}
                      onRemove={() => setForm(f => ({ ...f, env: f.env.filter((_, idx) => idx !== i) }))}
                    />
                  ))}
                  <button
                    className={styles.btn}
                    onClick={() => setForm(f => ({ ...f, env: [...f.env, { key: '', value: '' }] }))}
                  >
                    + Add variable
                  </button>
                </div>

                {/* ── AI detection ──────────────────────────────────────── */}
                <div className={styles.divider} />
                <div className={styles.field}>
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => detectWithAI()}
                    disabled={detecting}
                  >
                    {detecting ? 'Detecting…' : '✨ Detect from repo using AI'}
                  </button>
                  {detectError && <div className={styles.errorText}>{detectError}</div>}
                  {lastDetected && (
                    <div className={styles.detectedBox}>
                      <div className={styles.detectedTitle}>AI suggestion: {lastDetected.name}</div>
                      <div className={styles.detectedRow}><span>Build:</span> <code>{lastDetected.buildCommand || '(none)'}</code></div>
                      <div className={styles.detectedRow}><span>Run:</span> <code>{lastDetected.runCommand || '(none)'}</code></div>
                      {lastDetected.env.length > 0 && (
                        <div className={styles.detectedRow}>
                          <span>Env:</span> <code>{lastDetected.env.map(e => e.key).join(', ')}</code>
                        </div>
                      )}
                      {lastDetected.notes && <div className={styles.detectedNotes}>{lastDetected.notes}</div>}
                      <div className={styles.formActions}>
                        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={applyDetected}>Apply to form</button>
                        <button className={styles.btn} onClick={clearDetected}>Discard</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Build output ──────────────────────────────────────── */}
                {buildOutput !== null && (
                  <div className={styles.field}>
                    <label className={styles.label}>Build output</label>
                    <pre className={`${styles.output} ${buildFailed ? styles.outputFailed : ''}`}>{buildOutput}</pre>
                  </div>
                )}

                {/* ── Actions ────────────────────────────────────────────── */}
                <div className={styles.formActions}>
                  <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSave} disabled={saving || !form.name.trim()}>
                    {saving ? 'Saving…' : form.id ? 'Save' : 'Create'}
                  </button>
                  {form.id && !form.buildCommand.trim() ? null : (
                    <button className={styles.btn} onClick={handleRunBuild} disabled={buildRunning || !form.buildCommand.trim()}>
                      {buildRunning ? 'Building…' : 'Run Build'}
                    </button>
                  )}
                  <button className={styles.btn} onClick={handleRun} disabled={!form.runCommand.trim()}>
                    ▶ Run
                  </button>
                  {form.id && (
                    <>
                      {!configs.find(c => c.id === form.id)?.is_active && (
                        <button className={styles.btn} onClick={() => setActive(form.id!)}>Set Active</button>
                      )}
                      <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDelete}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
