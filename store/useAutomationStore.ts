import { create } from 'zustand'
import { nextRun, parseSchedule, buildSteps, type AutomationJob, type AutomationSchedule, type AutomationKind, type AutomationStep } from '../lib/automationScheduler'

const KEY = 'rachna_ide_automations_v1'
const GLOBAL_SOUND_KEY = 'rachna_ide_automation_sound'
const restore = (): AutomationJob[] => {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') as AutomationJob[] } catch { return [] }
}
const save = (jobs: AutomationJob[]) => localStorage.setItem(KEY, JSON.stringify(jobs))

interface AutomationState {
  jobs: AutomationJob[]
  panelOpen: boolean
  globalSoundEnabled: boolean
  openPanel(): void
  closePanel(): void
  add(request: string, schedule?: AutomationSchedule, kind?: AutomationKind, steps?: AutomationStep[]): AutomationJob
  update(id: string, patch: Partial<Pick<AutomationJob, 'name' | 'request' | 'schedule' | 'soundEnabled' | 'executionPrompt' | 'executionPlan' | 'metadata' | 'kind' | 'steps'>>): void
  remove(id: string): void
  toggle(id: string): void
  setGlobalSound(enabled: boolean): void
  replace(job: AutomationJob): void
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  // Legacy jobs (created before kind/steps existed, or that still have the
  // old flattened `tasks: string[]` field on disk) default to 'needs_ai'
  // with steps derived from `request` -- exactly today's behavior.
  jobs: restore().map(job => {
    const kind = job.kind || 'needs_ai'
    const legacyTasks = (job as unknown as { tasks?: unknown }).tasks
    const hasCanonicalSteps = Array.isArray(job.steps) && job.steps.length > 0
    return {
      ...job,
      kind,
      steps: hasCanonicalSteps
        ? job.steps
        : Array.isArray(legacyTasks) && legacyTasks.length > 0 && typeof legacyTasks[0] === 'string'
          // Old { tasks: string[] } shape -- rebuild canonical steps from it.
          ? (legacyTasks as string[]).map(part => kind === 'no_ai' ? { executor: 'terminal' as const, command: part } : { executor: 'ai' as const, prompt: part })
          : buildSteps(kind, job.executionPrompt || job.request),
      status: job.enabled ? 'idle' : 'paused',
      nextRunAt: job.enabled ? (job.nextRunAt || nextRun(job.schedule)?.toISOString()) : undefined,
    }
  }),
  panelOpen: false,
  globalSoundEnabled: localStorage.getItem(GLOBAL_SOUND_KEY) !== 'false',
  openPanel: () => set({ panelOpen: true }), closePanel: () => set({ panelOpen: false }),
  add: (request, supplied, kind = 'needs_ai', steps) => {
    const now = new Date(); const schedule = supplied || parseSchedule(request, now)
    const job: AutomationJob = { id: crypto.randomUUID(), name: request.slice(0, 64), request, schedule, enabled: true, soundEnabled: true, createdAt: now.toISOString(), updatedAt: now.toISOString(), nextRunAt: nextRun(schedule, now)?.toISOString(), status: 'idle', history: [], kind, steps: steps && steps.length > 0 ? steps : buildSteps(kind, request) }
    const jobs = [...get().jobs, job]; save(jobs); set({ jobs }); return job
  },
  update: (id, patch) => set(state => { const jobs = state.jobs.map(j => j.id === id ? { ...j, ...patch, updatedAt: new Date().toISOString(), nextRunAt: nextRun(patch.schedule || j.schedule)?.toISOString() } : j); save(jobs); return { jobs } }),
  remove: id => set(state => { const jobs = state.jobs.filter(j => j.id !== id); save(jobs); return { jobs } }),
  toggle: id => set(state => { const jobs = state.jobs.map(j => j.id === id ? { ...j, enabled: !j.enabled, status: !j.enabled ? 'idle' as const : 'paused' as const, nextRunAt: !j.enabled ? nextRun(j.schedule)?.toISOString() : undefined } : j); save(jobs); return { jobs } }),
  setGlobalSound: enabled => { localStorage.setItem(GLOBAL_SOUND_KEY, String(enabled)); set({ globalSoundEnabled: enabled }) },
  replace: job => set(state => { const jobs = state.jobs.map(j => j.id === job.id ? job : j); save(jobs); return { jobs } }),
}))
