// services/agent/verificationGate.ts
//
// ── Deterministic Agent Verification Loop ───────────────────────────────────
//
// Problem this solves:
//   Before this module existed, the agent could call propose_edit /
//   create_file / batch_propose_edits and then immediately produce a final
//   text response claiming the task is "done". Verification (get_diagnostics,
//   build, lint, tests) existed as tools/functions the agent COULD call, and
//   postMergeVerification.ts injected a prompt asking it to — but nothing
//   stopped the model from ignoring that instruction and finalizing anyway.
//   That is prompt-driven enforcement, and prompt-driven enforcement is not
//   enforcement — a model that skips the instruction has no other obstacle.
//
// What this module does instead:
//   It plugs directly into AgentLoop.ts's control flow. Every tool call the
//   agent executes is inspected here. When the model tries to end its turn
//   (i.e. it returns zero function calls — the signal AgentLoop.ts uses to
//   stream the final answer) AND there are file changes since the last
//   verification round, AgentLoop.ts does NOT stream the final answer. It
//   calls runForcedVerificationRound() — which runs get_diagnostics plus the
//   project's build/lint/test commands ITSELF, without asking the model to —
//   and appends the results to the conversation as a new turn. The loop then
//   continues, forcing the model to produce another turn that has to reckon
//   with the results before it can finalize again.
//
//   This is pure control flow. It does not rely on the model reading a
//   system-prompt instruction, choosing to call a particular tool, or being
//   well-behaved in any way — even a model that ignores every instruction in
//   its system prompt is still physically prevented from finalizing a turn
//   that touched files without a verification round having run.
//
// Deterministic project-awareness:
//   Which steps are "applicable" is decided by inspecting the project
//   (package.json, Cargo.toml, go.mod, pyproject.toml, .csproj, pom.xml —
//   see buildVerification.ts / testVerification.ts / lintVerification.ts,
//   which this module reuses directly) — never by asking the model. A step
//   whose underlying detector finds nothing to run reports itself as
//   'not_applicable' and is treated as satisfied without spending a full
//   build/test cycle — this is the "minimize unnecessary rebuilds" behaviour
//   requested for the feature: doc-only edits skip every step, and a repo
//   with no test runner simply reports "no test runner found" once instead
//   of retrying it forever.
//
// Escape hatch:
//   Some changes genuinely don't warrant a build/test cycle (e.g. editing a
//   comment, or a change the user explicitly told the agent not to verify
//   right now). The agent can call the `skip_verification` tool
//   (services/agent/tools/verificationTools.ts) with a reason. The gate
//   still runs — it never silently does nothing — but every step is recorded
//   as 'skipped' with that reason attached, satisfying requirement (4b)
//   "explicitly skipped with a valid reason" while keeping the reason
//   visible in the transcript instead of just trusting the model's prose.

import { getTool } from './ToolRegistry'
import type { ToolContext } from './types'
import type { ExecutedTool } from './ToolExecutor'
import { verifyBuild, type BuildVerificationResult } from './buildVerification'
import { verifyLint, type LintVerificationResult } from './lintVerification'
import { verifyTests, type TestVerificationResult } from './testVerification'

// ── Edit detection (requirement 1) ──────────────────────────────────────────

/** Tool names whose successful execution constitutes "a file was modified". */
export const EDIT_TOOL_NAMES = new Set([
  'propose_edit',
  'batch_propose_edits',
  'create_file',
  'rename_file',
  'delete_file',
])

// ── Step model ───────────────────────────────────────────────────────────────

export type VerificationStepId = 'diagnostics' | 'build' | 'lint' | 'test'

const STEP_LABELS: Record<VerificationStepId, string> = {
  diagnostics: 'IDE Diagnostics',
  build: 'Build',
  lint: 'Lint / Typecheck',
  test: 'Tests',
}

const ALL_STEP_IDS: VerificationStepId[] = ['diagnostics', 'build', 'lint', 'test']

export interface VerificationStepOutcome {
  id: VerificationStepId
  label: string
  /**
   * passed          — step ran and found nothing blocking
   * failed          — step ran and found real problems (reported below)
   * skipped         — step was explicitly skipped (skip_verification), with a reason
   * not_applicable  — step's own detector found nothing to run (e.g. no test runner)
   */
  status: 'passed' | 'failed' | 'skipped' | 'not_applicable'
  detail: string
}

export interface VerificationRoundReport {
  round: number
  changedFiles: string[]
  outcomes: VerificationStepOutcome[]
  /** False only if at least one step's status is 'failed'. */
  overallOk: boolean
  /** Ready-to-inject markdown describing this round, for the conversation. */
  markdown: string
}

// ── File classification (requirement: minimize unnecessary rebuilds) ───────

// Changes limited to these extensions never touch anything executable, so
// there is nothing for a build/lint/test/diagnostics cycle to catch. Kept
// deliberately narrow — anything not obviously inert still gets verified.
const NON_CODE_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'rst', 'log',
  'gitignore', 'gitattributes', 'editorconfig',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp',
  'lock', 'lockb',
])

function ext(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? ''
}

export function isDocOrConfigOnly(files: string[]): boolean {
  if (files.length === 0) return true
  return files.every(f => NON_CODE_EXTENSIONS.has(ext(f)))
}

// ── Per-turn gate state ──────────────────────────────────────────────────────
export interface GateState {
  /** Files changed since the last verification round ran (reset each round). */
  pendingFiles: Set<string>
  /** Every file changed at any point in this turn (for the activity log / UI). */
  allChangedFiles: Set<string>
  /** How many forced verification rounds have executed this turn. */
  roundsRun: number
  /** Set by the skip_verification tool; consumed by the very next round. */
  skipReason: string | null
  reports: VerificationRoundReport[]
}

export function createGateState(): GateState {
  return {
    pendingFiles: new Set(),
    allChangedFiles: new Set(),
    roundsRun: 0,
    skipReason: null,
    reports: [],
  }
}

/**
 * Hard ceiling on forced rounds per turn. Each round only fires when NEW
 * files changed since the previous round, so in practice this only matters
 * if the agent keeps editing after every single verification report forever
 * — a runaway-loop safety net, not a normal-path limit.
 */
export const MAX_FORCED_ROUNDS = 4

// ── Recording tool activity (requirement 1) ─────────────────────────────────

/**
 * Inspects the tool calls executed in the current loop iteration and updates
 * gate state: successful edit-tool calls register their file path(s) as
 * pending verification; a successful skip_verification call records its
 * reason for the next round to consume.
 */
export function recordExecutedTools(gate: GateState, executed: ExecutedTool[]): void {
  for (const e of executed) {
    if (e.name === 'skip_verification' && e.result.ok) {
      const data = e.result.data as { reason?: string }
      gate.skipReason = (data?.reason && data.reason.trim()) || 'Verification explicitly skipped by the agent.'
      continue
    }

    if (!EDIT_TOOL_NAMES.has(e.name) || !e.result.ok) continue

    for (const p of extractChangedPaths(e)) {
      gate.pendingFiles.add(p)
      gate.allChangedFiles.add(p)
    }
  }
}

function extractChangedPaths(e: ExecutedTool): string[] {
  const data = e.result.ok ? (e.result.data as Record<string, unknown>) : undefined
  if (!data) return []

  const paths: string[] = []
  switch (e.name) {
    case 'propose_edit':
    case 'create_file':
    case 'delete_file':
      if (typeof data.filePath === 'string') paths.push(data.filePath)
      break
    case 'rename_file':
      if (typeof data.oldPath === 'string') paths.push(data.oldPath)
      if (typeof data.newPath === 'string') paths.push(data.newPath)
      break
    case 'batch_propose_edits':
      if (Array.isArray(data.results)) {
        for (const r of data.results as Array<{ filePath?: string }>) {
          if (typeof r.filePath === 'string') paths.push(r.filePath)
        }
      }
      break
  }
  return paths
}

// ── Deciding whether to force a round (requirement 4/5) ─────────────────────

/**
 * True when the model just tried to end its turn but there is verification
 * work outstanding: files changed since the last round ran, those files
 * aren't purely docs/config, and we haven't hit the safety cap.
 */
export function needsForcedRound(gate: GateState): boolean {
  if (gate.pendingFiles.size === 0) return false
  if (isDocOrConfigOnly([...gate.pendingFiles])) return false
  if (gate.roundsRun >= MAX_FORCED_ROUNDS) return false
  return true
}

/** True once every changed file this turn was doc/config-only, or nothing changed. */
export function hasUnresolvedAfterCap(gate: GateState): boolean {
  return gate.pendingFiles.size > 0 && !isDocOrConfigOnly([...gate.pendingFiles]) && gate.roundsRun >= MAX_FORCED_ROUNDS
}

// ── Running a round (requirement 3) ──────────────────────────────────────────

async function safeRun<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

async function runDiagnosticsStep(changedFiles: string[], ctx: ToolContext): Promise<VerificationStepOutcome> {
  const tool = getTool('get_diagnostics')
  if (!tool) {
    return { id: 'diagnostics', label: STEP_LABELS.diagnostics, status: 'not_applicable', detail: 'get_diagnostics tool is not registered.' }
  }

  try {
    const result = await tool.execute({}, ctx)
    if (!result.ok) {
      return { id: 'diagnostics', label: STEP_LABELS.diagnostics, status: 'not_applicable', detail: `Diagnostics unavailable: ${result.error}` }
    }

    const data = result.data as {
      diagnostics: Array<{ file: string; line: number; column: number; severity: string; message: string }>
      available: boolean
    }

    if (!data.available) {
      return { id: 'diagnostics', label: STEP_LABELS.diagnostics, status: 'not_applicable', detail: 'Editor has not mounted yet — no live diagnostics to check.' }
    }

    const changedSet = new Set(changedFiles.map(normalizePath))
    const relevant = data.diagnostics.filter(d => changedSet.has(normalizePath(d.file)))
    const errors = relevant.filter(d => d.severity === 'error')

    if (errors.length > 0) {
      const lines = errors.slice(0, 20).map(e => `- ${e.file}:${e.line}:${e.column} — ${e.message}`)
      return {
        id: 'diagnostics',
        label: STEP_LABELS.diagnostics,
        status: 'failed',
        detail: `${errors.length} error(s) in changed files:\n${lines.join('\n')}` +
          (errors.length > 20 ? `\n…and ${errors.length - 20} more.` : ''),
      }
    }

    const warnings = relevant.filter(d => d.severity === 'warning')
    return {
      id: 'diagnostics',
      label: STEP_LABELS.diagnostics,
      status: 'passed',
      detail: warnings.length > 0
        ? `No errors in changed files. ${warnings.length} warning(s) present.`
        : 'No errors or warnings in changed files.',
    }
  } catch (err) {
    return {
      id: 'diagnostics',
      label: STEP_LABELS.diagnostics,
      status: 'not_applicable',
      detail: `Diagnostics check threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function buildOutcome(result: BuildVerificationResult | null): VerificationStepOutcome {
  if (!result) {
    return { id: 'build', label: STEP_LABELS.build, status: 'not_applicable', detail: 'Build step threw unexpectedly and was skipped.' }
  }
  if (result.status === 'skipped') {
    return { id: 'build', label: STEP_LABELS.build, status: 'not_applicable', detail: result.summary }
  }
  return {
    id: 'build',
    label: STEP_LABELS.build,
    status: result.status === 'verified' ? 'passed' : 'failed',
    detail: [result.summary, result.agentContext].filter(Boolean).join('\n'),
  }
}

function lintOutcome(result: LintVerificationResult | null): VerificationStepOutcome {
  if (!result) {
    return { id: 'lint', label: STEP_LABELS.lint, status: 'not_applicable', detail: 'Lint step threw unexpectedly and was skipped.' }
  }
  if (result.status === 'skipped') {
    return { id: 'lint', label: STEP_LABELS.lint, status: 'not_applicable', detail: result.summary }
  }
  return {
    id: 'lint',
    label: STEP_LABELS.lint,
    // Lint warnings alone don't block the loop — only real errors do.
    status: result.status === 'errors' ? 'failed' : 'passed',
    detail: [result.summary, result.agentContext].filter(Boolean).join('\n'),
  }
}

function testOutcome(result: TestVerificationResult | null): VerificationStepOutcome {
  if (!result) {
    return { id: 'test', label: STEP_LABELS.test, status: 'not_applicable', detail: 'Test step threw unexpectedly and was skipped.' }
  }
  if (result.status === 'skipped') {
    return { id: 'test', label: STEP_LABELS.test, status: 'not_applicable', detail: result.summary }
  }
  return {
    id: 'test',
    label: STEP_LABELS.test,
    status: result.status === 'passed' ? 'passed' : 'failed',
    detail: [result.summary, result.agentContext].filter(Boolean).join('\n'),
  }
}

function buildReport(round: number, changedFiles: string[], outcomes: VerificationStepOutcome[]): VerificationRoundReport {
  const overallOk = !outcomes.some(o => o.status === 'failed')

  const icon = (status: VerificationStepOutcome['status']): string => {
    switch (status) {
      case 'passed': return '✅'
      case 'failed': return '❌'
      case 'skipped': return '⏭️'
      case 'not_applicable': return '➖'
    }
  }

  const lines: string[] = [
    `## 🔒 Enforced Verification — Round ${round}`,
    '',
    '_This report was generated automatically by the IDE\'s verification gate, ' +
    'not requested by you. Your turn cannot end until it runs at least once ' +
    'after a file change._',
    '',
    `**Files changed since the last check:** ${changedFiles.join(', ') || '(none)'}`,
    '',
  ]

  for (const o of outcomes) {
    lines.push(`### ${icon(o.status)} ${o.label} — ${o.status.replace('_', ' ')}`)
    lines.push(o.detail || '(no detail)')
    lines.push('')
  }

  lines.push(
    overallOk
      ? 'No blocking failures above. If everything relevant is passed / not ' +
        'applicable / skipped, you may now summarize the result for the user. ' +
        'Do not re-claim verification you did not actually see pass here.'
      : 'One or more steps above **FAILED**. Do not report this task as working ' +
        'or complete. Either fix the reported issues with propose_edit / ' +
        'batch_propose_edits (verification will run again automatically), or, ' +
        'if you cannot fix it, tell the user plainly what failed and why.'
  )

  return { round, changedFiles, outcomes, overallOk, markdown: lines.join('\n') }
}

/**
 * Executes every applicable verification step for the files pending since
 * the last round — deterministically, called directly by AgentLoop.ts. The
 * model never chooses whether this runs.
 */
export async function runForcedVerificationRound(
  gate: GateState,
  projectRoot: string,
  ctx: ToolContext
): Promise<VerificationRoundReport> {
  const round = ++gate.roundsRun
  const changedFiles = [...gate.pendingFiles]
  gate.pendingFiles.clear()

  // ── Explicit skip via skip_verification tool ────────────────────────────
  if (gate.skipReason) {
    const reason = gate.skipReason
    gate.skipReason = null
    const outcomes = ALL_STEP_IDS.map((id): VerificationStepOutcome => ({
      id,
      label: STEP_LABELS[id],
      status: 'skipped',
      detail: reason,
    }))
    const report = buildReport(round, changedFiles, outcomes)
    gate.reports.push(report)
    return report
  }

  // ── 1. IDE diagnostics — cheap, always attempted first ──────────────────
  const diagnosticsOutcome = await runDiagnosticsStep(changedFiles, ctx)

  // ── 2/3/4. Build / Lint / Test ───────────────────────────────────────────
  // Reuses the exact functions EditStore uses for post-accept verification,
  // so detection + timeouts + output handling behave identically whichever
  // layer triggers them.
  const batchId = `agent-loop-round-${round}-${Date.now()}`
  const [buildResult, lintResult, testResult] = await Promise.all([
    safeRun(() => verifyBuild(projectRoot, batchId)),
    safeRun(() => verifyLint(projectRoot, batchId, changedFiles[0])),
    safeRun(() => verifyTests(projectRoot, batchId)),
  ])

  const outcomes: VerificationStepOutcome[] = [
    diagnosticsOutcome,
    buildOutcome(buildResult),
    lintOutcome(lintResult),
    testOutcome(testResult),
  ]

  const report = buildReport(round, changedFiles, outcomes)
  gate.reports.push(report)
  return report
}

/** Markdown appended when the forced-round cap is hit without resolution — keeps the cap from silently hiding unverified work. */
export function buildCapReachedNotice(gate: GateState): string {
  return [
    '## ⚠️ Verification Loop — round cap reached',
    '',
    `The agent verification loop ran ${gate.roundsRun} forced rounds this turn without the ` +
    'change set settling (new files kept changing after each report). To avoid looping ' +
    'forever, verification is being allowed to stop here.',
    '',
    'You MUST tell the user that automatic verification did not fully complete for every ' +
    'edit in this turn, and point them to the verification rounds above.',
  ].join('\n')
}
