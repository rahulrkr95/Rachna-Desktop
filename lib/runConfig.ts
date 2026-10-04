// lib/runConfig.ts
//
// Typed wrappers around the run-config Tauri commands.
// All persistence lives in src-tauri/src/db.rs (`run_configs` table) and
// src-tauri/src/commands.rs (`list_run_configs` / `save_run_config` /
// `delete_run_config` / `set_active_run_config`). This module is the single
// import point for any TypeScript code that needs to read or write run
// configurations.

import { invoke } from '@tauri-apps/api/core'

// ── Types (mirror the Rust `RunConfig` struct in db.rs) ────────────────────

export interface RunConfig {
  id: string
  project_root: string
  name: string
  build_command: string
  run_command: string
  /** JSON-encoded `{"KEY":"value"}` object — use envJsonToRecord/recordToEnvJson below. */
  env_json: string
  cwd: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Renderer-friendly env var shape used by the editor UI. */
export interface EnvVarEntry {
  key: string
  value: string
}

// ── env_json <-> EnvVarEntry[] helpers ──────────────────────────────────────

export function envJsonToEntries(envJson: string): EnvVarEntry[] {
  try {
    const parsed = JSON.parse(envJson || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed).map(([key, value]) => ({ key, value: String(value) }))
  } catch {
    return []
  }
}

export function entriesToEnvJson(entries: EnvVarEntry[]): string {
  const record: Record<string, string> = {}
  for (const { key, value } of entries) {
    const trimmedKey = key.trim()
    if (!trimmedKey) continue
    record[trimmedKey] = value
  }
  return JSON.stringify(record)
}

// ── list_run_configs ─────────────────────────────────────────────────────────

export async function listRunConfigs(projectRoot: string): Promise<RunConfig[]> {
  return invoke<RunConfig[]>('list_run_configs', { projectRoot })
}

// ── save_run_config ──────────────────────────────────────────────────────────
//
// Creates a new config when `id` is omitted, or updates the existing one
// otherwise. The very first config saved for a project is automatically
// marked active (see db.rs::save_run_config).

export async function saveRunConfig(params: {
  id?: string | null
  projectRoot: string
  name: string
  buildCommand: string
  runCommand: string
  envJson: string
  cwd?: string | null
}): Promise<RunConfig> {
  return invoke<RunConfig>('save_run_config', {
    id: params.id ?? null,
    projectRoot: params.projectRoot,
    name: params.name,
    buildCommand: params.buildCommand,
    runCommand: params.runCommand,
    envJson: params.envJson,
    cwd: params.cwd ?? null,
  })
}

// ── delete_run_config ────────────────────────────────────────────────────────

export async function deleteRunConfig(id: string): Promise<void> {
  return invoke<void>('delete_run_config', { id })
}

// ── set_active_run_config ────────────────────────────────────────────────────

export async function setActiveRunConfig(projectRoot: string, id: string): Promise<void> {
  return invoke<void>('set_active_run_config', { projectRoot, id })
}
