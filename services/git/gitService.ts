// services/git/gitService.ts
//
// Thin wrapper around the Rust `git_*` Tauri commands (src-tauri/src/commands.rs).
// All git operations run through the system `git` CLI on the Rust side — this
// module just mirrors the Rust structs as TS types and exposes typed
// `invoke()` calls, following the same pattern as lib/tauriFs.ts.

import { invoke } from '@tauri-apps/api/core'

// ── Shared types (mirror the Rust structs) ─────────────────────────────────

export interface GitFileStatus {
  /** Path relative to the workspace root. */
  path: string
  /** "M" | "A" | "D" | "R" | "C" | "U" | "T" | "??" */
  status: string
  /** True if this entry is a staged (index) change; false for unstaged/untracked. */
  staged: boolean
  /** For renames/copies: the original path, if known. */
  original_path: string | null
}

export interface BranchInfo {
  name: string
  is_current: boolean
  is_remote: boolean
}

export interface CommitInfo {
  hash: string
  message: string
  author: string
  date: string
}

// ── git_status ──────────────────────────────────────────────────────────────

/** Returns staged + unstaged + untracked file status for the workspace. */
export async function getStatus(root: string): Promise<GitFileStatus[]> {
  return invoke<GitFileStatus[]>('git_status', { root })
}

// ── git_diff ────────────────────────────────────────────────────────────────

/**
 * Returns the unified diff text for a single file, or the whole working
 * tree when `filePath` is omitted. `staged` selects between the
 * index-vs-HEAD diff (staged changes) and the worktree-vs-index diff
 * (unstaged changes, the default).
 */
export async function getDiff(
  root: string,
  filePath?: string,
  staged = false,
): Promise<string> {
  return invoke<string>('git_diff', {
    root,
    filePath: filePath ?? null,
    staged,
  })
}

// ── git_stage / git_unstage ─────────────────────────────────────────────────

export async function stageFiles(root: string, paths: string[]): Promise<void> {
  return invoke<void>('git_stage', { root, paths })
}

export async function unstageFiles(root: string, paths: string[]): Promise<void> {
  return invoke<void>('git_unstage', { root, paths })
}

// ── git_commit ───────────────────────────────────────────────────────────────

export async function commit(root: string, message: string): Promise<void> {
  return invoke<void>('git_commit', { root, message })
}

// ── git_push / git_pull ───────────────────────────────────────────────────────

/** Resolves with combined stdout/stderr output on success, rejects with a message on failure. */
export async function push(root: string): Promise<string> {
  return invoke<string>('git_push', { root })
}

export async function pull(root: string): Promise<string> {
  return invoke<string>('git_pull', { root })
}

// ── git_branches ───────────────────────────────────────────────────────────────

export async function getBranches(root: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>('git_branches', { root })
}

// ── git_switch_branch / git_create_branch ───────────────────────────────────────

export async function switchBranch(root: string, branch: string): Promise<void> {
  return invoke<void>('git_switch_branch', { root, branch })
}

export async function createBranch(root: string, name: string): Promise<void> {
  return invoke<void>('git_create_branch', { root, name })
}

// ── git_log ──────────────────────────────────────────────────────────────────

export async function getLog(root: string, limit = 50): Promise<CommitInfo[]> {
  return invoke<CommitInfo[]>('git_log', { root, limit })
}
