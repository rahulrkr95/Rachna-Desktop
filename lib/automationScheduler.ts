import type { ExecutionStep } from '../types'

export type AutomationSchedule =
  | { type: 'once'; runAt: string }
  | { type: 'interval'; everyMs: number; startAt?: string }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; weekday: number; time: string }
  | { type: 'monthly'; day: number; time: string }
  | { type: 'cron'; expression: string }
  | { type: 'condition'; condition: string; checkEveryMs: number }

/**
 * Mirrors the AGENTIC/CHAT split, but for AUTOMATION jobs:
 *   'no_ai'    -- the job can be carried out PURELY DETERMINISTICALLY, with
 *                 plain shell commands and no AI API call at all. At
 *                 trigger time it runs directly against `run_terminal`.
 *   'needs_ai' -- the job requires an AI API call at run time
 *                 (writing/reasoning/coding/browser work) and is routed
 *                 through the normal chat/agent pipeline.
 */
export type AutomationKind = 'no_ai' | 'needs_ai'

/**
 * One unit of work inside `AutomationJob.steps` -- the single canonical
 * execution shape every automation is stored, persisted, and run as,
 * regardless of `kind`. A `no_ai` job is a list of `terminal` steps; a
 * `needs_ai` job is a list of `ai` steps (prompts). Mirrors the
 * { executor: 'terminal' | 'ai' } shape already sketched in
 * src-tauri/src/automation/types.rs, kept here as the source of truth the
 * actual (TS-side) runner reads.
 */
export type AutomationStep =
  | { executor: 'terminal'; command: string }
  | { executor: 'ai'; prompt: string }

/**
 * Splits a normalized request/prompt into individual step strings on
 * common separators ("&&", " then ", newlines, ";") -- deliberately
 * simple; if nothing splits cleanly the whole text becomes one step.
 */
export function splitIntoStepStrings(text: string): string[] {
  const parts = text
    .split(/\r?\n|\s*&&\s*|\s*;\s*|\s+then\s+/gi)
    .map(part => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : [text.trim()]
}

/** Builds `AutomationJob.steps` from a normalized execution prompt + kind. */
export function buildSteps(kind: AutomationKind, executionPrompt: string): AutomationStep[] {
  return splitIntoStepStrings(executionPrompt).map(part =>
    kind === 'no_ai' ? { executor: 'terminal', command: part } : { executor: 'ai', prompt: part }
  )
}

/**
 * The single canonical JSON shape an automation is persisted/loaded as --
 * exactly what the background runner reads, and what round-trips through
 * export/import. Both `no_ai` and `needs_ai` jobs serialize to this same
 * shape; `steps` is the full execution step list (terminal commands or AI
 * prompts) -- there is no separate flattened `tasks: string[]` form.
 */
export interface AutomationJsonSpec {
  name: string
  schedule: AutomationSchedule
  enabled: boolean
  kind: AutomationKind
  steps: AutomationStep[]
}

/** Serializes a job to the canonical JSON shape (for export / inspection / the background script). */
export function toAutomationJson(job: AutomationJob): AutomationJsonSpec {
  return {
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled,
    kind: job.kind,
    steps: job.steps,
  }
}

/** Parses the canonical JSON shape back into the pieces useAutomationStore.add() needs. */
export function fromAutomationJson(spec: AutomationJsonSpec): { name: string; schedule: AutomationSchedule; kind: AutomationKind; steps: AutomationStep[]; enabled: boolean } {
  return {
    name: spec.name,
    schedule: spec.schedule,
    kind: spec.kind,
    steps: spec.steps,
    enabled: spec.enabled,
  }
}

export interface AutomationHistoryEntry {
  id: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'success' | 'failed'
  message?: string
}

/**
 * Bookkeeping about how/when `AutomationJob.executionPlan` was precompiled
 * — purely informational (surfaced in the Automation Manager / activity
 * chips), never read by the scheduler itself.
 */
export interface AutomationExecutionMetadata {
  /** ISO timestamp of when the execution plan was precompiled. */
  generatedAt: string
  /** Provider id active at precompile time (see store/useApiKeyStore.ts). */
  providerId: string
  /** Model id active at precompile time, if any. */
  model?: string
}

export interface AutomationJob {
  id: string
  name: string
  request: string
  schedule: AutomationSchedule
  enabled: boolean
  soundEnabled: boolean
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  lastRunAt?: string
  status: 'idle' | 'running' | 'success' | 'failed' | 'paused'
  history: AutomationHistoryEntry[]
  /**
   * 'no_ai'    -- run directly via run_terminal, no model call at trigger time.
   * 'needs_ai' -- routed through the AI chat/agent pipeline (existing behavior).
   * Defaults to 'needs_ai' for jobs created before this field existed.
   */
  kind: AutomationKind
  /**
   * The single canonical execution step list (see AutomationStep) this
   * job runs at trigger time -- for 'no_ai' these are shell commands run
   * one after another via run_terminal_command; for 'needs_ai' these are
   * AI prompts. This is what's persisted (see toAutomationJson) and what
   * the background scheduler actually reads -- there is no separate
   * flattened string list.
   */
  steps: AutomationStep[]
  /**
   * Self-contained, schedule-stripped rewrite of `request` (see
   * buildExecutionPrompt below) that was actually handed to the Task
   * Planner when this job was created/last precompiled. Reused verbatim
   * as the executed task's text on every future triggered run instead of
   * re-deriving it from `request` each time.
   */
  executionPrompt?: string
  /**
   * The Task Planner's ExecutionStep[] output, generated ONCE — at
   * creation time (see the AUTOMATION branch of executeSend in
   * components/AiChat/useChat.ts) — and reused unchanged on every future
   * triggered run (see services/automationService.ts). When present, a
   * scheduled run never re-runs Classification or Task Planning; it is
   * submitted straight to the execution engine as if it had just come
   * back from the planner.
   */
  executionPlan?: ExecutionStep[]
  /** Bookkeeping about how/when `executionPlan` was generated. */
  metadata?: AutomationExecutionMetadata
}

const atTime = (date: Date, time: string) => {
  const [h, m] = time.split(':').map(Number)
  date.setHours(h || 0, m || 0, 0, 0)
  return date
}

/** Computes the next occurrence. Cron supports the standard five fields, including *, values and step syntax. */
export function nextRun(schedule: AutomationSchedule, after = new Date()): Date | undefined {
  if (schedule.type === 'once') {
    const date = new Date(schedule.runAt)
    return date > after ? date : undefined
  }
  if (schedule.type === 'interval') {
    const start = schedule.startAt ? new Date(schedule.startAt).getTime() : after.getTime()
    if (start > after.getTime()) return new Date(start)
    return new Date(after.getTime() + Math.max(1_000, schedule.everyMs))
  }
  if (schedule.type === 'daily') {
    const date = atTime(new Date(after), schedule.time)
    if (date <= after) date.setDate(date.getDate() + 1)
    return date
  }
  if (schedule.type === 'weekly') {
    const date = atTime(new Date(after), schedule.time)
    let delta = (schedule.weekday - date.getDay() + 7) % 7
    if (delta === 0 && date <= after) delta = 7
    date.setDate(date.getDate() + delta)
    return date
  }
  if (schedule.type === 'monthly') {
    const date = atTime(new Date(after), schedule.time)
    date.setDate(Math.max(1, Math.min(28, schedule.day)))
    if (date <= after) date.setMonth(date.getMonth() + 1)
    return date
  }
  if (schedule.type === 'condition') return new Date(after.getTime() + schedule.checkEveryMs)
  const fields = schedule.expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const matches = (field: string, value: number) => field.split(',').some(part => {
    if (part === '*') return true
    if (part.startsWith('*/')) return value % Number(part.slice(2)) === 0
    return Number(part) === value
  })
  const cursor = new Date(after.getTime() + 60_000)
  cursor.setSeconds(0, 0)
  for (let i = 0; i < 525_600; i++, cursor.setMinutes(cursor.getMinutes() + 1)) {
    if (matches(fields[0], cursor.getMinutes()) && matches(fields[1], cursor.getHours()) &&
        matches(fields[2], cursor.getDate()) && matches(fields[3], cursor.getMonth() + 1) &&
        matches(fields[4], cursor.getDay())) return new Date(cursor)
  }
  return undefined
}

const timeFromText = (text: string) => {
  const match = text.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (!match) return '09:00'
  let hour = Number(match[1]); const minute = Number(match[2] || 0)
  if (match[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12
  if (match[3]?.toLowerCase() === 'am' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Deterministic schedule extraction keeps the automation router limited to choosing the mode. */
export function parseSchedule(request: string, now = new Date()): AutomationSchedule {
  const text = request.toLowerCase()
  const cron = request.match(/cron(?:\s+expression)?\s*[:=]?\s*["']?([^"'\n]+)["']?/i)
  if (cron) return { type: 'cron', expression: cron[1].trim() }
  const delayed = text.match(/\bin\s+(\d+)\s*(second|minute|hour|day)s?\b/)
  if (delayed) {
    const unit = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[delayed[2]]!
    return { type: 'once', runAt: new Date(now.getTime() + Number(delayed[1]) * unit).toISOString() }
  }
  if (/\bwhen\b|\bif\b.*\bbecomes?\b|monitor|watch for/.test(text)) return { type: 'condition', condition: request, checkEveryMs: 60_000 }
  const interval = text.match(/\bevery\s+(\d+)\s*(second|minute|hour|day|week)s?\b/)
  if (interval) {
    const unit = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[interval[2]]!
    return { type: 'interval', everyMs: Number(interval[1]) * unit }
  }
  if (/\bdaily\b|every day/.test(text)) return { type: 'daily', time: timeFromText(text) }
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
  const weekday = days.findIndex(day => text.includes(day))
  if (/\bweekly\b|every week/.test(text) || weekday >= 0) return { type: 'weekly', weekday: weekday >= 0 ? weekday : now.getDay(), time: timeFromText(text) }
  if (/\bmonthly\b|every month/.test(text)) return { type: 'monthly', day: Number(text.match(/\b(?:on the )?(\d{1,2})(?:st|nd|rd|th)?\b/)?.[1] || 1), time: timeFromText(text) }
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  if (text.includes('tomorrow')) return { type: 'once', runAt: atTime(tomorrow, timeFromText(text)).toISOString() }
  return { type: 'once', runAt: new Date(now.getTime() + 60_000).toISOString() }
}

/**
 * Deterministic, schedule-stripping rewrite of a raw automation request
 * into a normalized, self-contained execution prompt — i.e. just the WORK
 * to do, with the scheduling phrase (cron expression, "every ...",
 * "daily"/"weekly"/"monthly", "in N minutes", explicit weekday/time,
 * "tomorrow", etc.) removed. This is what actually gets sent to the Task
 * Planner once, at creation time (see the AUTOMATION branch of executeSend
 * in components/AiChat/useChat.ts), and is stored + reused verbatim as the
 * executed task's text on every future triggered run — the schedule itself
 * is tracked separately (see parseSchedule above / AutomationJob.schedule),
 * so it never needs to leak back into the text being executed.
 * Mirrors the same phrasing parseSchedule already recognizes, so anything
 * consumed there as scheduling metadata doesn't also linger in the prompt
 * handed to the planner. Falls back to the original (trimmed) request if
 * stripping would leave nothing behind.
 */
export function buildExecutionPrompt(request: string): string {
  const stripped = request
    .replace(/\bcron(?:\s+expression)?\s*[:=]?\s*["']?[^"'\n]+["']?/gi, ' ')
    .replace(/\b(?:in\s+)?\d+\s*(?:second|minute|hour|day|week)s?\b/gi, ' ')
    .replace(/\bevery\s+(?:day|week|month|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi, ' ')
    .replace(/\b(?:daily|weekly|monthly)\b/gi, ' ')
    .replace(/\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi, ' ')
    .replace(/\b(?:on\s+the\s+)?\d{1,2}(?:st|nd|rd|th)\b/gi, ' ')
    .replace(/\bat\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ')
    .replace(/\btomorrow\b/gi, ' ')
    .replace(/\bwhen\b.*?\bbecomes?\b/gi, ' ')
    .replace(/\b(?:monitor|watch for)\b/gi, ' ')
    .replace(/\s*:\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '')
    .trim()
  return stripped || request.trim()
}

export function describeSchedule(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case 'once': return `Once at ${new Date(schedule.runAt).toLocaleString()}`
    case 'interval': return `Every ${Math.round(schedule.everyMs / 60_000)} minute(s)`
    case 'daily': return `Daily at ${schedule.time}`
    case 'weekly': return `Weekly on ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][schedule.weekday]} at ${schedule.time}`
    case 'monthly': return `Monthly on day ${schedule.day} at ${schedule.time}`
    case 'cron': return `Cron: ${schedule.expression}`
    case 'condition': return `Monitor: ${schedule.condition}`
  }
}

/**
 * Wraps a (schedule-stripped) `needs_ai` execution prompt with an explicit
 * one-shot instruction before it's handed to the AI pipeline at trigger
 * time. `executionPrompt` already had the scheduling phrase (cron
 * expression, "every ...", "daily", "in N minutes", etc.) stripped by
 * buildExecutionPrompt at creation time -- but without this wrapper the
 * text is otherwise indistinguishable from a live chat turn, so a
 * sufficiently agentic model could reasonably try to set up its own
 * recurrence/reminder for it. This wrapper makes explicit that scheduling
 * is already handled outside the model and this single trigger should just
 * perform the work now, once, with no further scheduling of its own.
 * Applied fresh on every triggered run (not baked into the stored
 * `executionPrompt`), so it always reflects the current wording here.
 */
export function buildTriggeredPrompt(executionPrompt: string): string {
  return `This is a single scheduled run of a recurring automation. The scheduling itself is already handled by the system -- do NOT create, set up, or suggest any reminder, cron job, or repeat/recurrence for this. Just perform the following action once, right now, as a one-time task:\n\n${executionPrompt}`
}
