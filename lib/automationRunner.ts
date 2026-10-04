// lib/automationRunner.ts
//
// The single place that actually executes an automation's `steps`.
// Deliberately contains NO AI-specific logic and never reads
// `AutomationJob.kind` -- every step is dispatched purely by its own
// `step.executor` name (see AutomationStep in lib/automationScheduler.ts)
// via the ExecutorRegistry below. `kind` exists only for the
// classification/planning stage (see lib/agenticClassifier.ts /
// buildSteps in automationScheduler.ts) -- the runtime doesn't care what
// kind a job was classified as, only what each step's `executor` says.

import type { AutomationJob, AutomationStep } from './automationScheduler'

export interface AutomationRunContext {
  job: AutomationJob
}

export type StepExecutor<S extends AutomationStep = AutomationStep> =
  (step: S, ctx: AutomationRunContext) => Promise<void>

/**
 * Thrown by a registered executor to mean "I can't run this step right
 * now (e.g. my dependency isn't wired up yet)" -- distinct from a real
 * execution failure. AutomationRunner doesn't interpret this itself (it
 * stays generic and just lets it propagate); the caller running the
 * automation (services/automationService.ts) treats it as "retry next
 * tick" rather than a failed run. Not AI-specific -- any executor may use it.
 */
export class ExecutorNotReadyError extends Error {}

interface ExecutorRegistration {
  execute: StepExecutor
  /**
   * When true, this executor only actually runs ONCE per automation run
   * no matter how many steps route to it -- the first matching step
   * triggers it, later ones with the same executor name are skipped.
   * Used by the 'ai' executor (see services/automationService.ts): a
   * needs_ai automation executes its entire precompiled plan in a single
   * pass regardless of how many prompt steps make up the job, so a
   * repeat dispatch would just replay the same whole-job run. Generic
   * mechanism -- any executor can opt in, nothing AI-specific about it here.
   */
  runOncePerJob?: boolean
}

class ExecutorRegistryImpl {
  private executors = new Map<string, ExecutorRegistration>()

  /** Registers (or replaces) the executor for a given step name (e.g. 'terminal', 'ai'). */
  register<E extends AutomationStep['executor']>(
    name: E,
    execute: StepExecutor<Extract<AutomationStep, { executor: E }>>,
    options?: { runOncePerJob?: boolean },
  ): () => void {
    this.executors.set(name, { execute: execute as StepExecutor, runOncePerJob: options?.runOncePerJob })
    return () => { if (this.executors.get(name)?.execute === execute) this.executors.delete(name) }
  }

  resolve(name: string): ExecutorRegistration | undefined {
    return this.executors.get(name)
  }

  has(name: string): boolean {
    return this.executors.has(name)
  }
}

/** Global registry -- executors register themselves once (see automationService.ts), resolved here by name. */
export const executorRegistry = new ExecutorRegistryImpl()

/**
 * Runs every step in `job.steps` in order, dispatching each to whatever
 * executor is registered for its `executor` name. Throws if a step's
 * executor name has nothing registered, or if an executor itself throws
 * (including ExecutorNotReadyError, which the caller may treat specially).
 */
export async function runAutomation(job: AutomationJob): Promise<void> {
  const ranOnce = new Set<string>()
  const ctx: AutomationRunContext = { job }
  for (const step of job.steps) {
    const registration = executorRegistry.resolve(step.executor)
    if (!registration) {
      throw new Error(`No executor registered for step type "${step.executor}".`)
    }
    if (registration.runOncePerJob) {
      if (ranOnce.has(step.executor)) continue
      ranOnce.add(step.executor)
    }
    await registration.execute(step, ctx)
  }
}
