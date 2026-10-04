import { nextRun, type AutomationJob } from '../lib/automationScheduler'
import { executorRegistry, runAutomation, ExecutorNotReadyError } from '../lib/automationRunner'
import { useAutomationStore } from '../store/useAutomationStore'
import { notify } from './notify'
import { terminalTool } from './agent/tools/terminalTool'
import type { ToolContext } from './agent/types'

type ChatExecutor = (request: string, job: AutomationJob) => Promise<void>
let chatExecutor: ChatExecutor | undefined
let timer: ReturnType<typeof setInterval> | undefined

/** Registered by useChat.ts -- routes a whole job's request through the normal AI chat/agent pipeline. */
export function registerAutomationExecutor(value: ChatExecutor): () => void {
  chatExecutor = value
  return () => { if (chatExecutor === value) chatExecutor = undefined }
}

// ── 'terminal' executor ──────────────────────────────────────────────────
// Runs a single shell command straight through run_terminal_command. No
// `requestTerminalPermission` is set, so terminalTool executes directly
// (see terminalTool.ts's "no callback => trusted caller" fallback) --
// appropriate for a job the user already explicitly scheduled. Registered
// purely by the step name 'terminal' -- AutomationRunner has no idea this
// has anything to do with "no_ai" jobs; it just sees a step whose
// `executor` is "terminal".
executorRegistry.register('terminal', async (step) => {
  const ctx: ToolContext = { projectRoot: null }
  const result = await terminalTool.execute({ label: 'Run scheduled terminal command', command: step.command }, ctx)
  if (!result.ok) {
    throw new Error(`Command failed: "${step.command}" -- ${result.error}`)
  }
  if (result.data && (result.data as { success?: boolean }).success === false) {
    const stderr = (result.data as { stderr?: string }).stderr
    throw new Error(`Command failed: "${step.command}"${stderr ? ` -- ${stderr}` : ''}`)
  }
})

// ── 'ai' executor ────────────────────────────────────────────────────────
// Routes the whole job through the AI chat/agent pipeline exactly as
// before this refactor -- the registered chatExecutor (see useChat.ts)
// loads the job's precompiled executionPlan and submits it to the normal
// approve/auto-approve -> TaskExecutor pipeline. That covers every `ai`
// step in the job in one pass, so this is registered `runOncePerJob`: a
// job with several ai steps still triggers exactly one chat run, same as
// before. If the chat pipeline hasn't registered yet (e.g. still starting
// up), this throws ExecutorNotReadyError so the run is treated as "not
// yet", not a failure -- see execute() below.
executorRegistry.register('ai', async (_step, ctx) => {
  if (!chatExecutor) throw new ExecutorNotReadyError('AI chat pipeline is not ready yet.')
  await chatExecutor(ctx.job.request, ctx.job)
}, { runOncePerJob: true })

async function execute(job: AutomationJob): Promise<void> {
  if (job.status === 'running') return
  const startedAt = new Date().toISOString()
  const entry = { id: crypto.randomUUID(), startedAt, status: 'running' as const }
  useAutomationStore.getState().replace({ ...job, status: 'running', lastRunAt: startedAt, history: [entry, ...job.history].slice(0, 100) })
  try {
    // The scheduler/service layer has no idea what a step's executor
    // does -- runAutomation just iterates job.steps and dispatches each
    // to whatever's registered above by name. No AI-specific branching,
    // no reference to job.kind.
    await runAutomation(job)
    const latest = useAutomationStore.getState().jobs.find(item => item.id === job.id) || job
    const finishedAt = new Date().toISOString()
    const enabled = latest.schedule.type !== 'once' && latest.enabled
    useAutomationStore.getState().replace({ ...latest, enabled, status: enabled ? 'success' : 'paused', nextRunAt: enabled ? nextRun(latest.schedule, new Date())?.toISOString() : undefined, history: latest.history.map(h => h.id === entry.id ? { ...h, status: 'success', finishedAt } : h) })
    await notify(`Automation complete: ${job.name}`, job.request, job.soundEnabled)
  } catch (error) {
    if (error instanceof ExecutorNotReadyError) {
      // Not a failure -- an executor just isn't wired up yet (startup
      // race). Roll the "running" flag back and try again next tick,
      // without recording a failed history entry or notifying.
      useAutomationStore.getState().replace({ ...job, status: job.enabled ? 'idle' : 'paused', history: job.history.filter(h => h.id !== entry.id) })
      return
    }
    const latest = useAutomationStore.getState().jobs.find(item => item.id === job.id) || job
    const finishedAt = new Date().toISOString(); const message = error instanceof Error ? error.message : String(error)
    useAutomationStore.getState().replace({ ...latest, status: 'failed', nextRunAt: nextRun(latest.schedule, new Date())?.toISOString(), history: latest.history.map(h => h.id === entry.id ? { ...h, status: 'failed', finishedAt, message } : h) })
    await notify(`Automation failed: ${job.name}`, message, job.soundEnabled)
  }
}

export function runAutomationNow(id: string): Promise<void> {
  const job = useAutomationStore.getState().jobs.find(item => item.id === id)
  return job ? execute(job) : Promise.resolve()
}

// The scheduler itself: finds due automations and hands them to execute()
// (which just calls runAutomation -- see above). No AI-specific logic, no
// `kind` check, lives here.
export function startAutomationScheduler(): () => void {
  if (timer) return () => undefined
  const tick = () => {
    const now = Date.now()
    for (const job of useAutomationStore.getState().jobs) {
      if (job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now) void execute(job)
    }
  }
  tick(); timer = setInterval(tick, 1_000)
  return () => { if (timer) clearInterval(timer); timer = undefined }
}
