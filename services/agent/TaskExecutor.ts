// services/agent/TaskExecutor.ts


import type { ExecutionStep, TaskState } from '../../types'

export interface StepExecutionResult {
  /** Short (1-3 sentence) summary of this step's outcome, folded into TaskState.stepSummaries for later steps. */
  summary?: string
  /** Any new discoveries this step surfaced that a later step might need (kept short — a few words each). */
  discoveries?: string[]
  /** File paths this step created/edited/deleted. */
  changedFiles?: string[]
  /**
   * When true, the executor stops walking steps immediately AFTER this one
   * finishes — used when this step handed off to a UI flow that needs a
   * fresh user action (folder picker, MCP Settings, login) before subsequent
   * steps can run. Not an error.
   */
  stop?: boolean
}

export type StepExecutor = (step: ExecutionStep, taskState: TaskState) => Promise<StepExecutionResult | void>

export interface RunExecutionStepsResult {
  taskState: TaskState
  /** True if every step ran to completion without an early stop. */
  completed: boolean
  /** The step the executor stopped at (inclusive — it DID run, or attempted to and threw), if `completed` is false. */
  stoppedAtStepId?: string
  /**
   * True when `stoppedAtStepId` stopped because that step's executor threw
   * (a genuine failure), as opposed to a clean `{ stop: true }` hand-off
   * (folder picker, login, MCP connector, etc). Strict Step Execution: a
   * failed step always stops the pipeline here — the next step never
   * starts on its own. The caller (see useChat.ts's runDecomposedSteps) is
   * responsible for surfacing Retry / Mark Done / Cancel and, on Retry or
   * Mark Done, calling back in to resume from exactly this step.
   */
  failed?: boolean
}

/**
 * Topologically orders steps by `dependsOn` (stable — ties broken by the
 * original array order), so a step never runs before something it depends
 * on, even if the planner did not emit them in a valid order.
 * Falls back to the original order for any step whose dependency graph is
 * malformed (unknown id, cycle) rather than throwing — fail open, same
 * philosophy as the rest of the classification/planning pipeline.
 */
export function orderSteps(steps: ExecutionStep[]): ExecutionStep[] {
  const byId = new Map(steps.map(s => [s.id, s]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: ExecutionStep[] = []

  function visit(step: ExecutionStep) {
    if (visited.has(step.id) || visiting.has(step.id)) return
    visiting.add(step.id)
    for (const depId of step.dependsOn ?? []) {
      const dep = byId.get(depId)
      if (dep) visit(dep)
    }
    visiting.delete(step.id)
    visited.add(step.id)
    ordered.push(step)
  }

  try {
    for (const step of steps) visit(step)
    return ordered
  } catch {
    return steps
  }
}

/**
 * Runs an ExecutionStep[] sequentially (in dependency-respecting order),
 * calling `execute` for each and threading TaskState forward. Steps run one
 * at a time (never in parallel) — AgentLoop's own tool-level parallel-safe
 * batching still applies WITHIN a single step's turn, this is a coarser,
 * step-level sequencing on top of that.
 */
export async function runExecutionSteps(
  steps: ExecutionStep[],
  execute: StepExecutor,
  initialTaskState: TaskState,
  opts: { signal?: AbortSignal } = {},
): Promise<RunExecutionStepsResult> {
  const taskState = { ...initialTaskState }
  const ordered = orderSteps(steps)

  for (const step of ordered) {
    if (opts.signal?.aborted) return { taskState, completed: false, stoppedAtStepId: step.id }

    let result: StepExecutionResult | void
    try {
      result = await execute(step, taskState)
    } catch {
      // Strict Step Execution: a step failure stops the pipeline right
      // here — never advance to the next step, and never let this become
      // an unhandled rejection. `taskState` at this point already reflects
      // every step that completed BEFORE this one (this step's own
      // completedStepIds/summary/discoveries bookkeeping below never ran),
      // which is exactly the state a Retry or Mark Done needs to resume
      // from — see useChat.ts's retryStep/markStepDone.
      return { taskState, completed: false, stoppedAtStepId: step.id, failed: true }
    }

    taskState.completedStepIds = [...taskState.completedStepIds, step.id]
    if (result?.summary) taskState.stepSummaries = { ...taskState.stepSummaries, [step.id]: result.summary }
    if (result?.discoveries?.length) taskState.discoveries = [...taskState.discoveries, ...result.discoveries]
    if (result?.changedFiles?.length) {
      taskState.changedFiles = Array.from(new Set([...taskState.changedFiles, ...result.changedFiles]))
    }

    if (result?.stop) return { taskState, completed: false, stoppedAtStepId: step.id }
  }

  return { taskState, completed: true }
}

/**
 * Formats the shared TaskState into a short block of context text to prefix
 * onto a step's own task description before sending it as that turn's
 * question — this is how later steps "know" what earlier ones discovered/
 * changed without needing their own extra LLM call or the full transcript.
 * Returns '' when there's nothing yet to report (first step).
 */
export function formatTaskStateForPrompt(taskState: TaskState): string {
  const parts: string[] = []
  if (taskState.completedStepIds.length > 0) {
    const summaries = taskState.completedStepIds
      .map(id => taskState.stepSummaries[id])
      .filter(Boolean)
    if (summaries.length) parts.push(`Progress so far:\n- ${summaries.join('\n- ')}`)
  }
  if (taskState.discoveries.length > 0) {
    parts.push(`Relevant discoveries so far:\n- ${taskState.discoveries.join('\n- ')}`)
  }
  if (taskState.changedFiles.length > 0) {
    parts.push(`Files already touched this task:\n- ${taskState.changedFiles.join('\n- ')}`)
  }
  return parts.join('\n\n')
}
