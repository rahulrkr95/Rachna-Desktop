// lib/intentClassifier.ts
//

/**
 * The seven task types a turn can be scoped into for the Task
 * Planner, lib/planGenerator.ts). There is no classifier that assigns
 * TopIntent any more — routing is decided entirely by the specialist chip
 * (store/useSpecialistStore.ts + lib/specialistMapping.ts) in
 * components/AiChat/useChat.ts: the chip's selection (default DESKTOP) is
 * forced directly onto every turn, with no classification API call at all.
 *
 *   CHAT         — general conversation / a question, sent straight to the
 *                  model with no tools and no plan.
 *   AUTOMATION   — persist a schedule; the precompiled plan (if any) is
 *                  generated once up front against the full intent set,
 *                  since a scheduled job's eventual task type isn't known
 *                  ahead of its first run.
 *   CODING_TASK, TERMINAL_TASK, MCP_TASK, DESKTOP_TASK, DESIGN_TASK,
 *   BROWSER_TASK — enter the Task Planner directly, scoped to that
 *                  one intent's specialized prompt. TERMINAL_TASK has no
 *                  matching specialist chip of its own — it's reached from
 *                  CODING or DESKTOP steps that need a shell, decided by
 *                  the planner, not by chip selection.
 */
export type TopIntent =
  | 'CODING_TASK'
  | 'TERMINAL_TASK'
  | 'MCP_TASK'
  | 'DESKTOP_TASK'
  | 'AUTOMATION'
  | 'DESIGN_TASK'
  | 'BROWSER_TASK'
  | 'CHAT'

/** Back-compat alias — most callers still import `ExecutionMode`. */
export type ExecutionMode = TopIntent

/**
 * Every TopIntent that actually routes into the Task Planner (i.e.
 * everything except CHAT, which is answered directly, and AUTOMATION,
 * whose eventual task type isn't known at classification time). Listed in
 * classification-priority order — CODING_TASK FIRST, BROWSER_TASK LAST
 * among this set, per the overall priority order:
 * CODING_TASK > TERMINAL_TASK > MCP_TASK > DESKTOP_TASK > AUTOMATION >
 * DESIGN_TASK > BROWSER_TASK > CHAT.
 */
export const PLANNABLE_TOP_INTENTS: readonly Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>[] = [
  'CODING_TASK', 'TERMINAL_TASK', 'MCP_TASK', 'DESKTOP_TASK', 'DESIGN_TASK', 'BROWSER_TASK',
]

export type ChatIntent =
  | 'design_project'
  | 'build_new_project'
  | 'work_with_repo'
  | 'terminal_task'
  | 'desktop_task'
  | 'browser_task'
  | 'mcp_task'
  | 'chat'

export type DesktopTaskCategory = 'files' | 'apps' | 'research' | 'input_control'

/**
 * Sub-classification of DESIGN_TASK, extracted in the SAME classifier call
 * via a `DESIGN_TASK:<sub>` tag line. Undefined/unrecognized falls back to
 * the plain design flow (`code_generation` — a new visual design/mockup
 * project).
 *   code_generation — the default design flow: generate a new visual
 *     design/mockup project's actual code (renamed from the old bare/
 *     unsuffixed `DESIGN_TASK` tag for clarity — same flow/tools/prompt).
 */
export type DesignTaskSubIntent = 'code_generation'

/**
 * Sub-classification of WORK_WITH_REPO, extracted in the SAME classifier
 * call via an `WORK_WITH_REPO:<sub>` tag line. Lets ToolRegistry send a
 * much narrower tool set than the full coding registry for the common
 * case (read-only questions, a single-bug fix, a pure git ask), reserving
 * the generous "everything" set for genuinely broad multi-file work.
 * `run_project` lives here too — running/starting/launching an existing
 * project is still work on an existing project; it deliberately has no
 * tool set (undefined — fail open) since it routes to the dedicated Run
 * Configuration UI instead of the agent loop. See ToolRegistry's
 * EDIT_*_TOOL_NAMES arrays for the exact subsets.
 */
export type EditSubIntent = 'code_reasearch' | 'code_changes' | 'run_project'

/** Supported public-web execution modes. */
export type BrowserTaskSubIntent = 'research' | 'automation'

/**
 * Union of every "finer-grained than the top-level ChatIntent" tag this
 * classifier can produce in one call — EditSubIntent (work_with_repo),
 * BrowserTaskSubIntent (either web-task mode), or DesktopTaskCategory
 * (desktop_task). Callers that just thread "whatever sub-intent this turn
 * had" down to ToolRegistry.getToolNamesForIntent (useChat.ts, AgentLoop.ts)
 * use this single alias instead of repeating the three-way union everywhere.
 */
export type AgentSubIntent = EditSubIntent | BrowserTaskSubIntent | DesktopTaskCategory | DesignTaskSubIntent


export function intentNeedsSystemInfo(intent?: ChatIntent, subIntent?: AgentSubIntent): boolean {
  if (!intent) return false
  return (
    intent === 'desktop_task' ||
    intent === 'browser_task' ||
    intent === 'mcp_task' ||
    intent === 'terminal_task' ||
    (intent === 'work_with_repo' && subIntent === 'run_project')
  )
}

/**
 * UX-002: human-readable label for a classified intent (+ sub-intent, where
 * applicable), shown next to the "AI call" chip for the classification
 * step itself — e.g. "Coding Task → Work With Repo → Feature" or
 * "Desktop Task → Apps". Mirrors parseIntent's tag vocabulary one-for-one so
 * this always stays in sync with what the classifier can actually emit.
 */
const SUB_INTENT_LABELS: Record<string, string> = {
  code_reasearch: 'Code Research', code_changes: 'Code Changes', run_project: 'Run Project',
  research: 'Research', input_control: 'Input Control', automation: 'Automation',
  files: 'Files', apps: 'Apps',
  code_generation: 'Code Generation',
}

/**
 * Human-readable label for just the top-level intent (no sub-intent),
 * e.g. 'work_with_repo' → 'Work With Repo'. Used wherever an intent and its
 * sub-intent need to render as two separate chips (see IntentPlanCard)
 * rather than describeIntent's single combined "A → B" string below.
 */
export function describeIntentLabel(intent: ChatIntent): string {
  switch (intent) {
    case 'design_project':            return 'Design'
    case 'build_new_project':         return 'New Project'
    case 'work_with_repo':             return 'Work With Repo'
    case 'terminal_task':              return 'Terminal Task'
    case 'desktop_task':               return 'Desktop Task'
    case 'browser_task':      return 'Browser Task'
    case 'mcp_task':                  return 'MCP Task'
    case 'chat':                      return 'Chat'
    default:                          return String(intent)
  }
}

/** Human-readable label for just a sub-intent — see describeIntentLabel above. Undefined when there isn't one. */
export function describeSubIntentLabel(subIntent?: AgentSubIntent): string | undefined {
  return subIntent ? SUB_INTENT_LABELS[subIntent] : undefined
}

/**
 * UX-002: human-readable label for a classified intent (+ sub-intent, where
 * applicable), shown next to the "AI call" chip for the classification
 * step itself — e.g. "Coding Task → Work With Repo → Feature" or
 * "Desktop Task → Apps". Mirrors parseIntent's tag vocabulary one-for-one so
 * this always stays in sync with what the classifier can actually emit.
 */
export function describeIntent(step: { intent: ChatIntent; subIntent?: AgentSubIntent }): string {
  const sub = describeSubIntentLabel(step.subIntent)
  switch (step.intent) {
    case 'design_project':            return 'Design'
    case 'build_new_project':         return 'Software → New Project'
    case 'work_with_repo':
      return `Software → Work With Repo${sub ? ` → ${sub}` : ''}`
    case 'terminal_task':             return 'Terminal Task'
    case 'desktop_task':
      return `Desktop Task${sub ? ` → ${sub}` : ''}`
    case 'browser_task':
      return `Browser Task${sub ? ` → ${sub}` : ''}`
    case 'mcp_task':                  return 'MCP Task'
    case 'chat':                      return 'Chat'
    default:                          return String(step.intent)
  }
}

/**
 * Tag vocabulary/definitions shared with lib/planGenerator.ts, split one
 * section per TopIntent so the planner sends only the definition
 * for the selected specialist, instead of the whole
 * taxonomy. Keys are the PLANNABLE_TOP_INTENTS values above.
 */
export const INTENT_DEFINITIONS_BY_TOP_INTENT: Record<Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>, string> = {
  DESIGN_TASK: `
DESIGN_TASK:<code_generation>
- code_generation: Create UI, mockups, or visual designs. These are Tailwind HTML pages in a canvas.

DESIGN_TASK is only used when the user requests a new design for something. If they don't mention design and code is needed, that's CODING_TASK instead.
`.trim(),

  CODING_TASK: `
SOFTWARE:NEW_PROJECT [Create a new software project, including its normal build/run and verification lifecycle; not covered in DESIGN_TASK]

SOFTWARE:WORK_WITH_REPO:<code_research|code_changes|run_project>
- code_research: Inspect or explain something from the code (no code change needed).
- code_changes: Modify or fix existing repo's code.
- run_project: Build or run an existing project.

SOFTWARE:WORK_WITH_REPO can only be used when the user's request starts with an existing project/repository. It must never be added after SOFTWARE:NEW_PROJECT to build, run, test, or verify the newly created project; those execution responsibilities remain part of SOFTWARE:NEW_PROJECT.
`.trim(),

  TERMINAL_TASK: `
TERMINAL_TASK : 
 - tasks which can be done by using the system terminal to execute terminal commands.
`.trim(),

  DESKTOP_TASK: `
DESKTOP_TASK:<files|apps|research|input_control>
- files: Manage local files/folders.
- apps: Launch or control any desktop apps. Even the web browsers (prefer this over BROWSER_TASK).
- research: Inspect the user's local system or installed software.
- input_control: Interact using the user's local mouse/keyboard along with screenshots for vision.

`.trim(),

  MCP_TASK: `
MCP_TASK:<service>
- Used when it is possible to fulfill the user's request using a dedicated MCP connector. Use a short lowercase service name (e.g. github, figma, slack, jira). Use unknown if the service cannot be determined.
`.trim(),

  BROWSER_TASK: `
BROWSER_TASK:<research|automation>
- research: Look something up / gather facts using web_search, curl, and open_url.
- automation: Drive a real headless browser through an ordered list of steps (goto/click/fill/extract/screenshot) to carry out a repeatable public-web task.

BROWSER_TASK is used only for public pages (pages accessible without login), driven via a headless Playwright browser. Cannot be combined with DESKTOP_TASK:apps (opening a real browser app). This is second-lowest in classification priority (ahead only of CHAT) — only use it when none of the higher-priority task types fit.
`.trim(),
}

/** Full plannable taxonomy in priority order. The Task Planner uses every definition to validate whether a request belongs to the selected specialist. AUTOMATION and CHAT are handled outside this array. */
export const INTENT_DEFINITIONS = PLANNABLE_TOP_INTENTS
  .map((intent, i) => `${i + 1}. ${INTENT_DEFINITIONS_BY_TOP_INTENT[intent]}`)
  .join('\n\n')

/** Returns every plannable intent definition so the Task Planner can validate specialist relevance. */
export function getIntentDefinitions(): string {
  return INTENT_DEFINITIONS
}

/**
 * Direct 1:1 mapping from a TopIntent to its ChatIntent, for every
 * TopIntent EXCEPT CODING_TASK — CODING_TASK covers two ChatIntents
 * (build_new_project / work_with_repo), so each step's tag line still
 * needs to be parsed via parseIntent to tell them apart.
 */
export function chatIntentForTopIntent(
  topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION' | 'CODING_TASK'>,
): ChatIntent {
  switch (topIntent) {
    case 'DESIGN_TASK':   return 'design_project'
    case 'TERMINAL_TASK': return 'terminal_task'
    case 'DESKTOP_TASK':  return 'desktop_task'
    case 'MCP_TASK':      return 'mcp_task'
    case 'BROWSER_TASK':  return 'browser_task'
  }
}


export function parseIntent(tagLine: string): ChatIntent {
  const upper = tagLine.toUpperCase()
  // The SOFTWARE tags (NEW_PROJECT / WORK_WITH_REPO / run_project sub-intent)
  // map back onto the SAME internal ChatIntent values
  // ('build_new_project' | 'work_with_repo' | 'run_project') the rest of the
  // app (useChat.ts, AgentLoop.ts, ToolRegistry.ts, ...) already branches
  // on — grouping them under SOFTWARE is a classifier-output change only,
  // not a flow change. TERMINAL_TASK is its own top-level tag (no
  // grouping prefix) and maps to 'terminal_task'. Checked here in the same
  // priority order (CODING_TASK > TERMINAL_TASK > MCP_TASK > DESKTOP_TASK >
  // AUTOMATION > DESIGN_TASK > BROWSER_TASK > CHAT) the system prompt
  // documents among themselves. Also
  // still accepts old/ungrouped tags (BUILD_NEW_PROJECT, bare
  // CODING:*/CODING_TASK:* prefixes, WORK_WITH_REPO/RUN_PROJECT/
  // TERMINAL_TASK) for back-compat, in case a stale cached prompt or
  // another provider ever emits them.
  // DESIGN_TASK is the current tag; bare DESIGN is accepted for back-compat
  // with stale cached prompts / other providers.
  if (upper.includes('WORK_WITH_REPO') || upper.includes('EDIT EXISTING') || upper.includes('RUN_PROJECT') || upper.includes('RUN PROJECT')) return 'work_with_repo'
  if (upper.includes('NEW_PROJECT') || upper.includes('NEW PROJECT') || upper.includes('BUILD_NEW') || upper.includes('BUILD NEW') || upper === 'SOFTWARE') return 'build_new_project'
  if (upper.includes('TERMINAL_TASK') || upper.includes('TERMINAL TASK')) return 'terminal_task'
  if (upper.includes('MCP_TASK') || upper.includes('MCP TASK')) return 'mcp_task'
  if (upper.includes('DESKTOP_TASK') || upper.includes('DESKTOP TASK')) return 'desktop_task'
  if (upper === 'DESIGN_TASK' || upper.startsWith('DESIGN_TASK:') || upper.startsWith('DESIGN_TASK ') ||
      upper === 'DESIGN' || upper.startsWith('DESIGN:') || upper.startsWith('DESIGN ')) return 'design_project'
  if (upper.includes('BROWSER_TASK') || upper.includes('BROWSER TASK') || upper.includes('WEB_TASK') || upper.includes('WEB TASK')) return 'browser_task'
  return 'chat'
}

/** Pulls the `<category>` keyword out of a `DESKTOP_TASK:<category>` tag line, if present/valid. */
export function parseDesktopTaskCategory(tagLine: string): DesktopTaskCategory | undefined {
  const match = tagLine.match(/DESKTOP[_ ]TASK\s*:\s*([a-zA-Z_]+)/i)
  if (!match) return undefined
  const category = match[1].toLowerCase()
  const valid: readonly string[] = ['files', 'apps', 'research', 'input_control']
  return valid.includes(category) ? (category as DesktopTaskCategory) : undefined
}

/**
 * Pulls the `<sub>` keyword out of a `DESIGN_TASK:<sub>` tag line, if
 * present/valid. A missing/bare `DESIGN_TASK` tag (no `:<sub>` at all —
 * old/back-compat form) resolves to `code_generation`, the default design
 * flow. An unrecognized sub-tag returns undefined, which the registry
 * falls back to `code_generation` for as well — see DesignTaskSubIntent /
 * lib/intentRegistry.ts::DESIGN_TASK_DEFAULT.
 */
export function parseDesignTaskSubIntent(tagLine: string): DesignTaskSubIntent | undefined {
  const match = tagLine.match(/DESIGN[_ ]TASK\s*:\s*([a-zA-Z_]+)/i)
  if (!match) return 'code_generation'
  const sub = match[1].toLowerCase()
  const valid: readonly string[] = ['code_generation']
  return valid.includes(sub) ? (sub as DesignTaskSubIntent) : undefined
}

/**
 * Pulls the `<sub>` keyword out of a `SOFTWARE:WORK_WITH_REPO:<sub>` tag
 * line, if present/valid. Undefined means the tag is missing or not one of
 * work_with_repo's three concrete sub-intents.
 */
export function parseEditSubIntent(tagLine: string): EditSubIntent | undefined {
  if (/RUN[_ ]PROJECT/i.test(tagLine)) return 'run_project'
  const match = tagLine.match(/(?:SOFTWARE\s*:\s*)?(?:WORK[_ ]WITH[_ ]REPO|EDIT[_ ]EXISTING)\s*:\s*([a-zA-Z_]+)/i)
  if (!match) return undefined
  const sub = match[1].toLowerCase()
  const valid: readonly string[] = ['code_reasearch', 'code_changes', 'run_project']
  return valid.includes(sub) ? (sub as EditSubIntent) : undefined
}

/**
 * Pulls the supported `research` keyword out of a `BROWSER_TASK` tag
 * line. The execution registry attaches the same tools directly to the
 * top-level browser_task intent because this intent has only one
 * live mode.
 */
export function parseBrowserTaskSubIntent(tagLine: string): BrowserTaskSubIntent | undefined {
  const match = tagLine.match(/(?:BROWSER[_ ]TASK|HEADLESS[_ ]BROWSER[_ ]TASK|WEB[_ ]TASK(?:\s*:\s*unauthenticated)?)\s*:\s*([a-zA-Z_]+)/i)
  if (!match) return undefined
  const sub = match[1].toLowerCase()
  const valid: readonly string[] = ['research', 'automation']
  return valid.includes(sub) ? (sub as BrowserTaskSubIntent) : undefined
}

export const BROWSER_TASK_UNSUPPORTED =
  '**Could not complete request.** The headless browser task was missing its required research sub-intent. Please retry the request.'
