// services/agent/lintVerification.ts
//
// Lint verification runs ESLint, TypeScript type-checking (tsc --noEmit),
// and framework-specific validation after an AI-generated edit is accepted.
//
// Design mirrors buildVerification.ts:
//   - Detects which linters are available in the project
//   - Runs them sequentially via Tauri `run_terminal_command`
//   - Aggregates results into a single LintVerificationResult
//   - On failure, agentContext is injected into the next agent prompt
//
// Linters run (in order, each skipped if not found):
//   1. ESLint    — eslint --max-warnings=0 on the changed file
//   2. TypeScript — npx tsc --noEmit (if tsconfig.json found)
//   3. Framework — next lint / vite lint / vue-tsc (if framework detected)

import { invoke } from '@tauri-apps/api/core'

// ── Types ─────────────────────────────────────────────────────────────────────

export type LintStatus = 'clean' | 'warnings' | 'errors' | 'skipped' | 'running'

export interface LintCheck {
  /** Short label, e.g. "ESLint", "TypeScript", "Next.js" */
  name: string
  command: string
  status: 'clean' | 'warnings' | 'errors' | 'skipped' | 'error'
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** Parsed issue counts */
  errorCount: number
  warningCount: number
}

export interface LintVerificationResult {
  editId: string
  /** Worst status across all checks */
  status: LintStatus
  checks: LintCheck[]
  durationMs: number
  /** One-line summary for UI display */
  summary: string
  /** Multi-line context to inject into agent on failure */
  agentContext: string
  /** Total errors across all checks */
  totalErrors: number
  /** Total warnings across all checks */
  totalWarnings: number
}

interface TauriCommandResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LINT_TIMEOUT_SECONDS = 60

// ── Framework detection ───────────────────────────────────────────────────────

interface FrameworkLinter {
  name: string
  command: string
}

async function detectFrameworkLinter(
  root: string,
  pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null
): Promise<FrameworkLinter | null> {
  if (!pkg) return null

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

  // Next.js — has its own lint command
  if (allDeps?.next) {
    return { name: 'Next.js', command: 'npx next lint --max-warnings=0' }
  }

  // vue-tsc for Vue 3 + TypeScript projects
  if (allDeps?.vue && allDeps?.['vue-tsc']) {
    return { name: 'vue-tsc', command: 'npx vue-tsc --noEmit' }
  }

  // Svelte check
  if (allDeps?.svelte && allDeps?.['svelte-check']) {
    return { name: 'svelte-check', command: 'npx svelte-check --threshold warning' }
  }

  return null
}

// ── Helper: run a command and build a LintCheck ───────────────────────────────

async function runCheck(
  name: string,
  command: string,
  cwd: string
): Promise<LintCheck> {
  let raw: TauriCommandResult
  try {
    raw = await invoke<TauriCommandResult>('run_terminal_command', {
      command,
      cwd,
      timeoutSeconds: LINT_TIMEOUT_SECONDS,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      name,
      command,
      status: 'error',
      exitCode: null,
      stdout: '',
      stderr: msg,
      durationMs: 0,
      errorCount: 0,
      warningCount: 0,
    }
  }

  const combined = `${raw.stdout}\n${raw.stderr}`
  const { errors, warnings } = parseIssueCounts(combined, name)

  const status: LintCheck['status'] =
    raw.exit_code !== 0
      ? errors > 0 ? 'errors' : 'warnings'
      : warnings > 0 ? 'warnings' : 'clean'

  return {
    name,
    command,
    status,
    exitCode: raw.exit_code,
    stdout: raw.stdout,
    stderr: raw.stderr,
    durationMs: raw.duration_ms,
    errorCount: errors,
    warningCount: warnings,
  }
}

// ── Issue count parsing ───────────────────────────────────────────────────────

function parseIssueCounts(
  output: string,
  linterName: string
): { errors: number; warnings: number } {
  // ESLint: "2 errors, 3 warnings" or "2 errors" or "3 warnings"
  if (linterName === 'ESLint' || linterName === 'Next.js') {
    const match = output.match(/(\d+)\s+error[s]?.*?(\d+)\s+warning[s]?/i)
    if (match) {
      return { errors: parseInt(match[1], 10), warnings: parseInt(match[2], 10) }
    }
    const errOnly = output.match(/(\d+)\s+error[s]?/i)
    const warnOnly = output.match(/(\d+)\s+warning[s]?/i)
    return {
      errors: errOnly   ? parseInt(errOnly[1],  10) : 0,
      warnings: warnOnly ? parseInt(warnOnly[1], 10) : 0,
    }
  }

  // TypeScript: counts lines with "error TS"
  if (linterName === 'TypeScript' || linterName === 'vue-tsc') {
    const errors = (output.match(/error TS\d+/gi) ?? []).length
    return { errors, warnings: 0 }
  }

  // Ruff: "Found 3 errors." (ruff has no separate warning tier by default)
  if (linterName === 'Ruff') {
    const match = output.match(/Found\s+(\d+)\s+error/i)
    return { errors: match ? parseInt(match[1], 10) : 0, warnings: 0 }
  }

  // svelte-check: "Warnings: 1  Errors: 2"
  if (linterName === 'svelte-check') {
    const match = output.match(/Warnings:\s*(\d+)\s+Errors:\s*(\d+)/i)
    if (match) {
      return { errors: parseInt(match[2], 10), warnings: parseInt(match[1], 10) }
    }
  }

  // Generic fallback
  const errLines = (output.match(/\berror\b/gi) ?? []).length
  return { errors: errLines, warnings: 0 }
}

// ── ESLint detection ──────────────────────────────────────────────────────────

async function hasEslint(root: string): Promise<boolean> {
  // Check for eslint config files
  const configFiles = [
    '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
    '.eslintrc.yaml', '.eslintrc.yml', 'eslint.config.js',
    'eslint.config.mjs', 'eslint.config.cjs',
  ]

  for (const file of configFiles) {
    try {
      const r = await invoke<TauriCommandResult>('run_terminal_command', {
        command: `cat ${file}`,
        cwd: root,
        timeoutSeconds: 3,
      })
      if (r.exit_code === 0) return true
    } catch {
      // not found
    }
  }

  return false
}

async function hasTsConfig(root: string): Promise<boolean> {
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat tsconfig.json',
      cwd: root,
      timeoutSeconds: 3,
    })
    return r.exit_code === 0
  } catch {
    return false
  }
}

// ── Python (ruff) detection ───────────────────────────────────────────────────
//
// Ruff is the closest thing to a universal, near-zero-config Python linter —
// if it's not installed `npx`-style ergonomics don't apply, so we only run
// it when a ruff config (or a pyproject.toml with a [tool.ruff] table)
// signals the project actually uses it.

async function hasRuffConfig(root: string): Promise<boolean> {
  const configFiles = ['ruff.toml', '.ruff.toml']
  for (const file of configFiles) {
    try {
      const r = await invoke<TauriCommandResult>('run_terminal_command', {
        command: `cat ${file}`,
        cwd: root,
        timeoutSeconds: 3,
      })
      if (r.exit_code === 0) return true
    } catch {
      // not found
    }
  }

  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat pyproject.toml',
      cwd: root,
      timeoutSeconds: 3,
    })
    if (r.exit_code === 0 && r.stdout.includes('[tool.ruff')) return true
  } catch {
    // no pyproject.toml
  }

  return false
}

async function readPackageJson(
  root: string
): Promise<{
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} | null> {
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat package.json',
      cwd: root,
      timeoutSeconds: 5,
    })
    if (r.exit_code === 0 && r.stdout) return JSON.parse(r.stdout)
  } catch {
    // ignore
  }
  return null
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Runs lint checks after an edit is accepted.
 * Never throws — always returns a LintVerificationResult.
 *
 * @param projectRoot  Absolute path to the project root
 * @param editId       The EditStore id of the accepted edit
 * @param changedFile  Absolute path of the file that was edited (used to scope ESLint)
 */
export async function verifyLint(
  projectRoot: string,
  editId: string,
  changedFile?: string
): Promise<LintVerificationResult> {
  const startMs = Date.now()

  const skipped = (reason: string): LintVerificationResult => ({
    editId,
    status: 'skipped',
    checks: [],
    durationMs: 0,
    summary: reason,
    agentContext: '',
    totalErrors: 0,
    totalWarnings: 0,
  })

  const pkg = await readPackageJson(projectRoot)
  const checks: LintCheck[] = []

  if (pkg) {
    // ── 1. ESLint ──────────────────────────────────────────────────────────
    const eslintAvailable = await hasEslint(projectRoot)
    if (eslintAvailable) {
      // Scope to the changed file if it's a JS/TS file, else run on all
      const target = changedFile && /\.[jt]sx?$/.test(changedFile)
        ? `"${changedFile}"`
        : '.'
      const eslintCmd = `npx eslint ${target} --max-warnings=0 --format=compact`
      const check = await runCheck('ESLint', eslintCmd, projectRoot)
      checks.push(check)
    }

    // ── 2. TypeScript ────────────────────────────────────────────────────────
    const tsAvailable = await hasTsConfig(projectRoot)
    if (tsAvailable) {
      const check = await runCheck('TypeScript', 'npx tsc --noEmit', projectRoot)
      checks.push(check)
    }

    // ── 3. Framework-specific ──────────────────────────────────────────────────
    const frameworkLinter = await detectFrameworkLinter(projectRoot, pkg)
    if (frameworkLinter) {
      // Skip if it's Next.js lint and we already ran ESLint (avoid double-reporting)
      const alreadyCoveredByEslint =
        frameworkLinter.name === 'Next.js' && eslintAvailable
      if (!alreadyCoveredByEslint) {
        const check = await runCheck(frameworkLinter.name, frameworkLinter.command, projectRoot)
        checks.push(check)
      }
    }
  }

  // ── 4. Ruff (Python) ────────────────────────────────────────────────────────
  // Independent of the package.json gate above — a project can be pure Python.
  if (await hasRuffConfig(projectRoot)) {
    const target = changedFile && /\.pyi?$/.test(changedFile) ? `"${changedFile}"` : '.'
    const check = await runCheck('Ruff', `ruff check ${target}`, projectRoot)
    checks.push(check)
  }

  if (checks.length === 0) {
    return skipped('No supported linter found (ESLint config, tsconfig.json, ruff config, or framework) — lint verification skipped.')
  }

  // ── Aggregate results ──────────────────────────────────────────────────────
  const totalErrors   = checks.reduce((n, c) => n + c.errorCount,   0)
  const totalWarnings = checks.reduce((n, c) => n + c.warningCount, 0)
  const durationMs = Date.now() - startMs

  const hasErrors   = checks.some(c => c.status === 'errors')
  const hasWarnings = checks.some(c => c.status === 'warnings')

  const status: LintStatus =
    hasErrors   ? 'errors'   :
    hasWarnings ? 'warnings' :
    'clean'

  const durationSec = (durationMs / 1000).toFixed(1)
  const summary =
    status === 'clean'
      ? `✅ Lint clean (${durationSec}s) — ${checks.map(c => c.name).join(', ')}`
      : status === 'warnings'
        ? `⚠️ Lint: ${totalWarnings} warning(s) (${durationSec}s)`
        : `❌ Lint: ${totalErrors} error(s), ${totalWarnings} warning(s) (${durationSec}s)`

  const agentContext =
    status === 'errors' || status === 'warnings'
      ? buildLintContext(projectRoot, editId, checks, totalErrors, totalWarnings)
      : ''

  return {
    editId,
    status,
    checks,
    durationMs,
    summary,
    agentContext,
    totalErrors,
    totalWarnings,
  }
}

// ── Agent context builder ─────────────────────────────────────────────────────

function buildLintContext(
  cwd: string,
  editId: string,
  checks: LintCheck[],
  totalErrors: number,
  totalWarnings: number
): string {
  const lines: string[] = [
    `### ⚠️ Lint Verification ${totalErrors > 0 ? 'FAILED' : 'WARNINGS'}`,
    '',
    `**Working directory:** ${cwd}`,
    `**Edit ID:** ${editId}`,
    `**Total:** ${totalErrors} error(s), ${totalWarnings} warning(s)`,
    '',
  ]

  const trimLines = (text: string, max: number) =>
    text.split('\n').slice(-max).join('\n')

  for (const check of checks) {
    if (check.status === 'clean' || check.status === 'skipped') continue

    lines.push(
      `#### ${check.name} (exit ${check.exitCode ?? '?'}: ${check.errorCount} errors, ${check.warningCount} warnings)`,
      `**Command:** \`${check.command}\``,
    )

    const output = [check.stderr, check.stdout].filter(Boolean).join('\n').trim()
    if (output) {
      lines.push('```', trimLines(output, 60), '```')
    }
    lines.push('')
  }

  if (totalErrors > 0) {
    lines.push(
      'Lint errors found after your last edit. You MUST fix these errors before proceeding.',
      'Use `run_terminal_command` with the lint commands above to re-check after fixing.',
      'Do NOT silently ignore lint errors.',
    )
  } else {
    lines.push(
      'Lint warnings found after your last edit. Consider fixing these for code quality.',
    )
  }

  return lines.join('\n')
}
