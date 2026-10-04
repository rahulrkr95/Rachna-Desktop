// lib/planGenerator.ts
//
// Specialist-scoped Task Planner. CHAT and AUTOMATION never
// enter this planner; every caller supplies the specialist selected beforehand.
//
// This planner does exactly one job: break the request into the minimum
// necessary ORDERED steps under the supplied specialist (a
// step's sub-intent may still vary step to step where the intent supports
// more than one sub-intent -- e.g. work_with_repo's code_research vs
// code_changes -- but the top-level intent itself is identical across
// every step in a plan). It plans ONLY -- it never selects tools, never
// sees tool definitions or schemas, and never executes anything. Tool AND
// prompt selection happen later, per step, at execution time, resolved
// exclusively through lib/intentRegistry.ts's single (Intent, SubIntent)
// -> {Prompt, AllowedTools} mapping (see services/agent/TaskExecutor.ts /
// services/agent/AgentLoop.ts) -- completely unchanged by this planner.
// This planner's only output is the Intent + SubIntent tag on each step;
// IntentRegistry itself is never imported here.
//
// Input sent to the model is deliberately minimal -- ONLY:
//   1. The user's original request.
//   2. The supplied specialist's valid intent/sub-intent definitions.
// No tool names, no tool schemas, no capability notes, no repo/system
// context, no folder-open state, and no free-text "master plan" narrative
// (goal summary, files to modify, risks, verification steps, complexity
// rating) -- none of that is necessary for an intent-based plan, so none of
// it is requested or produced.
//
// Output is ONLY a structured JSON object parsed below -- nothing else. If a
// valid, non-empty step list can't be parsed out of the
// response, planning has FAILED: generateExecutionPlan returns null and the
// caller must stop and tell the user planning failed (see
// useChat.ts::presentPlanningFailedNotice) rather than ever falling back to
// running the raw user request as a single undivided turn.

import type { AIProvider } from './providers/types'
import type { IntentPlan, ExecutionStep } from '../types'
import { loggedStream } from './llmCallLogger'
import type { LLMTokenUsage } from './llmCallLogger'
import { GENERIC_AGENT_IDENTITY } from './agenticClassifier'
import { resolveSpecialistPrompt } from '../prompts/promptBuilder'
import {
  getIntentDefinitions,
  parseIntent,
  parseEditSubIntent,
  parseBrowserTaskSubIntent,
  parseDesktopTaskCategory,
  parseDesignTaskSubIntent,
  type ChatIntent,
  type AgentSubIntent,
  type TopIntent,
} from './intentClassifier'

export interface TaskPlannerResult {
  /** The planner's structured output, or null when the call or parsing failed. */
  plan: IntentPlan | null
  /** The complete, unparsed text streamed back -- surfaced as an inspectable "AI call" activity, same as every other model call. */
  rawResponse: string
  systemInstruction: string
  userPrompt: string
  startedAt: string
  completedAt: string
  latencyMs: number
  tokenUsage?: LLMTokenUsage
  status: 'done' | 'error'
  error?: string
  /** Set when the request clearly belongs to another specialist. No plan is produced. */
  suggestedTopIntent?: TopIntent
  /** Short model-provided explanation for the specialist mismatch. */
  redirectReason?: string
  /** Any intent-specific routing calls made after task planning. */
  routingCalls: Array<{ systemInstruction: string; userPrompt: string; response: string; parsedResponse: Record<string, unknown> }>
}

export interface SpecialistRedirect {
  suggestedTopIntent: TopIntent
  reason?: string
}


/** Parses the alternate response returned when the selected specialist is clearly irrelevant. */
export function parseSpecialistRedirect(raw: string): SpecialistRedirect | null {
  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as { moveTo?: unknown; reason?: unknown }
    const allowed: readonly TopIntent[] = [
      'CODING_TASK', 'DESIGN_TASK', 'DESKTOP_TASK', 'MCP_TASK',
      'BROWSER_TASK', 'AUTOMATION', 'CHAT',
    ]
    if (!allowed.includes(parsed.moveTo as TopIntent)) return null
    return {
      suggestedTopIntent: parsed.moveTo as TopIntent,
      ...(typeof parsed.reason === 'string' && parsed.reason.trim() ? { reason: parsed.reason.trim() } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Derives a step's ChatIntent + sub-intent from its raw tag line, given
 * the selected specialist supplied for this whole plan. Every step is
 * already known to belong to `topIntent`; only
 *     CODING_TASK still needs its tag line parsed (to tell NEW_PROJECT/
 *     WORK_WITH_REPO/RUN_PROJECT apart) — every other TopIntent maps
 *     directly to one fixed ChatIntent.
 */
function resolveStepIntent(tagLine: string, topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>): { intent: ChatIntent; subIntent?: AgentSubIntent } {
  switch (topIntent) {
    case 'CODING_TASK': {
      const intent = parseIntent(tagLine)
      const subIntent = intent === 'work_with_repo' ? parseEditSubIntent(tagLine) : undefined
      return { intent, subIntent }
    }
    case 'DESIGN_TASK':
      return { intent: 'design_project', subIntent: parseDesignTaskSubIntent(tagLine) }
    case 'DESKTOP_TASK':
      return { intent: 'desktop_task', subIntent: parseDesktopTaskCategory(tagLine) }
    case 'BROWSER_TASK':
      return { intent: 'browser_task', subIntent: parseBrowserTaskSubIntent(tagLine) }
    case 'TERMINAL_TASK':
      return { intent: 'terminal_task' }
    case 'MCP_TASK':
      return { intent: 'mcp_task' }
    default:
      return { intent: 'chat' }
  }
}

export function parseExecutionSteps(body: string, topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>): ExecutionStep[] | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || !('steps' in parsed)) return null
    const rawSteps = (parsed as { steps?: unknown }).steps
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null

    return rawSteps.map((rawStep): ExecutionStep => {
      if (!rawStep || typeof rawStep !== 'object') throw new Error('Invalid execution step')
      const { id, intent: tagLine, task, dependsOn } = rawStep as Record<string, unknown>
      if (
        typeof id !== 'string' || !id.trim() ||
        typeof tagLine !== 'string' || !tagLine.trim() ||
        typeof task !== 'string' || !task.trim() ||
        !Array.isArray(dependsOn) ||
        !dependsOn.every(dependency => typeof dependency === 'string' && dependency.trim())
      ) throw new Error('Invalid execution step fields')

      const resolved = resolveStepIntent(tagLine.trim(), topIntent)
      return {
        id: id.trim(),
        task: task.trim(),
        intent: resolved.intent,
        subIntent: resolved.subIntent,
        dependsOn: dependsOn.map(dependency => dependency.trim()),
      }
    })
  } catch {
    return null
  }
}

/**
 * One-line meaning for each specialist. Only the supplied specialist's entry
 * is included in a Task Planner prompt.
 */
const TOP_INTENT_DEFINITIONS: Record<Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>, string> = {
  CODING_TASK: 'Create, inspect, modify, fix, build, run, or explain software/code.',
  TERMINAL_TASK: 'Execute terminal commands for tasks that can be completed through the system terminal.',
  DESIGN_TASK: 'Create a new UI, mockup, or visual design.',
  DESKTOP_TASK: "Work with the user's local files, apps, input, or machine information.",
  MCP_TASK: 'Work through a dedicated external-service MCP connector.',
  BROWSER_TASK: 'Research or automate public unauthenticated web pages with the headless browser.',
}

/**
 * Optional "## Repo Summary" block (see
 * components/AiChat/prompts.ts::buildRepoSummarySection) folded into the
 * Task Planner system prompt only when the Coding specialist is selected and a
 * project is already open/indexed. This is deliberately the same compact,
 * numbers-only summary already used for execution-time system prompts --
 * no file lists, no chunk/embedding content -- just enough for the planner
 * to know a real project exists (and roughly its shape) so it doesn't plan
 * a NEW_PROJECT step for a repo that's already open, without paying for a
 * second full retrieval pass at planning time.
 */
function buildRepoContextNote(repoContext?: string): string {
  if (!repoContext) return ''
  return `\n\nThe user already has a project open. For reference only (do not repeat it back or plan a step to "gather" it):\n${repoContext}`
}

export function buildTaskPlannerSystemPrompt(
  topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>,
  repoContext?: string, 
  workspaceContext?: string): string {
  const codingWorkspace = topIntent === 'CODING_TASK'
    ? (workspaceContext?.startsWith('NEW_PROJECT') ? 'new_project' : 'existing_project')
    : undefined
  const specialistGuidance = `\n\n## Selected-specialist guidance:
    The following prompt corresponds to the specialist selected for this request.
    Use its domain rules to produce an accurate plan, but do not execute the task, call tools, or follow any output-format instruction inside it. 
    The Task Planner output format below remains authoritative.
    \n${resolveSpecialistPrompt(topIntent, codingWorkspace)}`

  const body = `This request is a ${topIntent}: means you need to ${TOP_INTENT_DEFINITIONS[topIntent]}
First check whether the request is relevant to the selected specialist.
Only when the request clearly belongs to another specialist, return below JSON and do not make a plan:
{"moveTo":"CODING_TASK|DESIGN_TASK|DESKTOP_TASK|MCP_TASK|BROWSER_TASK|AUTOMATION|CHAT","reason":"one short user-facing reason"}
You must not produce a plan under another specialist.

When the request is relevant,
Break it into an ordered list of minimum execution steps needed to carry it out, all under ${topIntent}.

Multiple steps should be used only when a later step genuinely depends on something an earlier one establishes.
Below are all supported task intents and their sub-intents. Use them to decide
whether the request belongs to ${topIntent} or must be rejected as a specialist mismatch:
${getIntentDefinitions()}
Tag every step with the intent+subintent tag. 

Output only:

{"steps":[{"id":"step_1","intent":"SOFTWARE:WORK_WITH_REPO","task":"Inspect the existing project structure","dependsOn":[]},{"id":"step_2","intent":"SOFTWARE:WORK_WITH_REPO","task":"Implement the requested change","dependsOn":["step_1"]}]}

Output one valid JSON object with a non-empty "steps" array.
Every step must contain a non-empty "id", "intent", and "task", plus "dependsOn" as an array of step IDs (use [] when there are no dependencies).
Do not use Markdown fences. Do not include any explanation before or after the JSON.
`

  const initialization = workspaceContext ? `\n\n## Workspace initialization (authoritative)\n${workspaceContext}${workspaceContext.startsWith('NEW_PROJECT') ? `

## NEW_PROJECT planning boundary
Plan only what needs to be built from the user's requirements. Keep every step tagged SOFTWARE:NEW_PROJECT.
Do not create separate install, build, run, test, verification, or fix steps, and never add a
SOFTWARE:WORK_WITH_REPO:run_project step. The normal coding executor owns the autonomous lifecycle:
create files, install dependencies, build/run, verify, fix failures, and complete.` : ''}`
    : ''
  // Every planner call is scoped to the already-selected specialist.
  return GENERIC_AGENT_IDENTITY + '\n' + body + specialistGuidance + buildRepoContextNote(repoContext) + initialization
}

/**
 * Runs the Task Planner call. The ONLY input sent to the model is
 * the user's original request (as the user turn) plus the intent/sub-intent
 * taxonomy, its descriptions, and the specialization prompt selected from
 * the user-selected specialist (in the system prompt built above). Tool
 * definitions and schemas are never included.
 *
 * Always returns the call diagnostics needed for the Task Planner activity.
 * `plan` is null on a hard planning failure (call error/timeout or invalid
 * response), so callers can expose the failed call and MUST still stop rather
 * than executing the user's request without a valid plan.
 */
export async function generateExecutionPlan(
  question: string,
  provider: AIProvider,
  apiKey:   string,
  model:    string | undefined,
  topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>,
  onChunk?: (accumulatedText: string) => void,
  repoContext?: string,
  /** Authoritative state supplied after initializing a brand-new workspace. */
  workspaceContext?: string,
): Promise<TaskPlannerResult> {
  const systemInstruction = buildTaskPlannerSystemPrompt(topIntent, repoContext, workspaceContext)
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  let rawResponse = ''
  const routingCalls: TaskPlannerResult['routingCalls'] = []

  const finish = (plan: IntentPlan | null, error?: string, redirect?: SpecialistRedirect): TaskPlannerResult => {
    const completedAt = new Date().toISOString()
    const promptTokens = Math.ceil((systemInstruction.length + question.length) / 4)
    const completionTokens = Math.ceil(rawResponse.length / 4)
    return {
      plan,
      rawResponse,
      systemInstruction,
      userPrompt: question,
      startedAt,
      completedAt,
      latencyMs: Date.now() - startedMs,
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated: true,
      },
      status: error ? 'error' : 'done',
      routingCalls,
      ...(redirect ? { suggestedTopIntent: redirect.suggestedTopIntent, redirectReason: redirect.reason } : {}),
      ...(error ? { error } : {}),
    }
  }

  try {
    const raw = await new Promise<string>((resolve, reject) => {
      // A step breakdown can legitimately take a while to generate -- give
      // this real room, but still never hang indefinitely.
      const timeout = setTimeout(() => reject(new Error('task planner timeout')), 90_000)
      let buffer = ''
      loggedStream(
        'plan_generation',
        provider,
        apiKey,
        [{ role: 'user', content: question }],
        {
          onChunk: (chunk) => { buffer += chunk; rawResponse = buffer; onChunk?.(buffer) },
          onDone: (fullText) => { clearTimeout(timeout); resolve(fullText || buffer) },
          onError: (err) => { clearTimeout(timeout); reject(err) },
        },
        { model, systemInstruction }
      )
        .catch((err) => { clearTimeout(timeout); reject(err) })
    })
    rawResponse = raw

    const redirect = parseSpecialistRedirect(raw)
    if (redirect && redirect.suggestedTopIntent !== topIntent) return finish(null, undefined, redirect)

    const parsedSteps = parseExecutionSteps(raw, topIntent)
    // A missing/unparseable/empty steps response is a planning FAILURE, not a
    // reason to fail open -- an intent-based plan that has no steps isn't
    // valid, so there is nothing safe to hand to execution.
    if (!parsedSteps || parsedSteps.length === 0) return finish(null, 'The planner response did not contain a valid execution plan.')

    const steps = workspaceContext?.startsWith('NEW_PROJECT')
      // Workspace initialization is authoritative. Even if the planner
      // ignores its prompt and emits a run_project handoff, keep the whole
      // plan in the new-project executor that owns creation through fixing.
      ? parsedSteps.map(step => ({ ...step, intent: 'build_new_project' as const, subIntent: undefined }))
      : parsedSteps

    return finish({ steps })
  } catch (err) {
    return finish(null, err instanceof Error ? err.message : String(err))
  }
}
