// lib/intentRegistry.ts
//
// ── IntentRegistry ──────────────────────────────────────────────────────────
//
// The single source of truth mapping every (Intent, SubIntent) pair this
// agent can be routed into onto exactly the two things an execution step
// needs to run: the specialization PROMPT the model is given for that step,
// and the ALLOWED TOOLS (built-in tool names) it may call while running it.
//
// Before this module existed, those two facts were maintained in two
// separate, hand-synced places that had to be kept in lockstep by
// convention/comments alone:
//   - services/agent/ToolRegistry.ts  — EDIT_SUB_INTENT_TOOL_NAMES,
//     WEB_SUB_INTENT_TOOL_NAMES, DESKTOP_TASK_CATEGORY_TOOL_NAMES,
//     INTENT_TOOL_NAMES + getToolNamesForIntent().
//   - prompts/promptBuilder.ts        — EDIT_SUB_INTENT_PROMPTS +
//     getCodingSpecializationPrompt()/getIntentPrompt().
// Every comment in both files insisted the two had to resolve "the SAME
// (Intent, SubIntent) pair" — because nothing actually enforced that; they
// were two parallel branches over the same taxonomy that could silently
// drift apart. IntentRegistry replaces both with ONE table. ToolRegistry.ts
// and promptBuilder.ts are now thin, delegating wrappers kept only for
// call-site/back-compat stability (see their own file headers).
//
// ── Who resolves through this ────────────────────────────────────────────
// Every executor that needs a step's prompt or tool set resolves through
// this module — directly (services/agent/AgentLoop.ts is the authoritative,
// execution-time consumer of resolveIntentRegistryEntry()'s tool half) or
// through one of the thin wrappers described above. Nothing downstream of
// this module re-implements the (Intent, SubIntent) → {Prompt, AllowedTools}
// branching a second time.
//
// ── Who does NOT resolve through this ────────────────────────────────────
// lib/planGenerator.ts (the task planner) deliberately never imports this
// module. It selects Intent + SubIntent per plan step and nothing else —
// no tool names, no tool schemas, no prompts. Tool/prompt resolution is
// entirely an execution-time concern, handled once a step actually runs
// (see services/agent/TaskExecutor.ts / AgentLoop.ts).
//
import type {
  ChatIntent,
  AgentSubIntent,
  EditSubIntent,
  DesktopTaskCategory,
  DesignTaskSubIntent,
  BrowserTaskSubIntent,
} from './intentClassifier'
// ── Tool implementations (for their declared names only) ───────────────────
import { readFileTool } from '../services/agent/tools/readFileTool'
import { readLinesTool } from '../services/agent/tools/readLinesTool'
import { searchCodebaseTool, semanticSearchCodebaseTool } from '../services/agent/tools/searchCodebaseTool'
import { listDirectoryTool } from '../services/agent/tools/listDirectoryTool'
import { diagnosticsTool } from '../services/agent/tools/diagnosticsTool'
import {
  findDependenciesTool,
  findDependentsTool,
  traceImportChainTool,
  findComponentUsageTool,
  findHookUsageTool,
} from '../services/agent/tools/repoGraphTools'
import { proposeEditTool } from '../services/agent/tools/proposeEditTool'
import { batchProposeEditsTool } from '../services/agent/tools/batchProposeEditsTool'
import { createFileTool, renameFileTool, deleteFileTool } from '../services/agent/tools/fileOpTools'
import { copyFileTool, copyFolderTool, moveFolderTool, deleteFolderTool, createFolderTool } from '../services/agent/tools/folderOpTools'
import { terminalTool } from '../services/agent/tools/terminalTool'
import { curlTool } from '../services/agent/tools/curlTool'
import { browserCheckTool } from '../services/agent/tools/browserCheckTool'
import { webSearchTool } from '../services/agent/tools/webSearchTool'
import { stackOverflowSearchTool } from '../services/agent/tools/stackOverflowSearchTool'
import { packageChangelogTool } from '../services/agent/tools/packageChangelogTool'
import { manageTodosTool } from '../services/agent/tools/todoTool'
import { gitActionTool } from '../services/agent/tools/gitAgentTool'
import { getRepoOverviewTool } from '../services/agent/tools/repoOverviewTool'
import { grepCodebaseTool } from '../services/agent/tools/grepCodebaseTool'
import { skipVerificationTool } from '../services/agent/tools/verificationTools'
import { openDefaultBrowserTool } from '../services/agent/tools/openDefaultBrowserTool'
import {
  openInOsExplorerTool,
  openFileTool,
  openAppTool,
  focusAppTool,
  closeAppTool,
  listRunningAppsTool,
  killProcessTool,
  moveWindowTool,
  resizeWindowTool,
  minimizeWindowTool,
  maximizeWindowTool,
  listOpenWindowsTool,
  openProjectFolderTool,
} from '../services/agent/tools/desktopControlTools'
import { mouseClickTool, mouseDragPathTool, pressKeyTool, pressKeySequenceTool, typeLinkInBrowserTool } from '../services/agent/tools/inputControlTools'
import { takeScreenshotTool } from '../services/agent/tools/screenshotTool'
import { addFileToRequestTool } from '../services/agent/tools/addFileToRequestTool'
import { getSystemInfoTool, listFilesTool, searchFilesTool } from '../services/agent/tools/systemResearchTools'
import { openUrlTool } from '../services/agent/tools/desktopControlTools'
import { webTaskTool } from '../services/agent/tools/webTaskTool'

// ── Specialization prompts ──────────────────────────────────────────────────
import {
  buildCodingReadOnlyPrompt as buildCodingCodeResearchPrompt,
  buildCodingFeaturePrompt as buildCodingCodeChangesPrompt,
  buildCodingNewProjectPrompt,
  buildCodingRunPrompt,
  buildCodingTerminalPrompt,
} from '../prompts/codingPrompt'
import { buildDesignPrompt } from '../prompts/designPrompt'
import { DESKTOP_PROMPT } from '../prompts/desktopPrompt'
import { RESEARCH_PROMPT } from '../prompts/researchPrompt'
import { CHAT_PROMPT } from '../prompts/chatPrompt'

// ── Registry entry shape ────────────────────────────────────────────────────

/**
 * One row of the registry: everything an execution step tagged with a given
 * (Intent, SubIntent) pair needs at execution time.
 */
export interface IntentRegistryEntry {
  /** The fully-resolved specialization prompt text for this step. */
  prompt: string
  /**
   * Built-in tool names this step may call. `undefined` means "no
   * scoping — fail open to the full tool registry" (used only for the
   * handful of intents that are either unmapped or not yet wired to a live
   * tool set; see services/agent/ToolRegistry.ts::getToolDeclarations).
   */
  toolNames: readonly string[] | undefined
}

/** A registry row before its prompt is bound to this step's resolved tool names. */
interface UnresolvedEntry {
  toolNames: readonly string[] | undefined
  buildPrompt: (toolNames?: readonly string[]) => string
}

// ── Tool-name sets ───────────────────────────────────────────────────────────
//
// Grouped by the (Intent, SubIntent) bucket they belong to. These are the
// same sets that used to live in services/agent/ToolRegistry.ts — moved
// here so the set and the prompt it pairs with are declared side by side,
// in the ONE table below, instead of in two files a reader has to
// cross-reference by hand.

// -- work_with_repo --
const EDIT_CODE_RESEARCH_TOOL_NAMES: readonly string[] = [
  readFileTool.declaration.name,
  readLinesTool.declaration.name,
  searchCodebaseTool.declaration.name,
  semanticSearchCodebaseTool.declaration.name,
  grepCodebaseTool.declaration.name,
  listDirectoryTool.declaration.name,
  getRepoOverviewTool.declaration.name,
  findDependenciesTool.declaration.name,
  findDependentsTool.declaration.name,
  traceImportChainTool.declaration.name,
  findComponentUsageTool.declaration.name,
  findHookUsageTool.declaration.name,
  openInOsExplorerTool.declaration.name,
  openFileTool.declaration.name,
  addFileToRequestTool.declaration.name,
]

const EDIT_CODE_CHANGES_BASE_TOOL_NAMES: readonly string[] = [
  readFileTool.declaration.name,
  readLinesTool.declaration.name,
  grepCodebaseTool.declaration.name,
  searchCodebaseTool.declaration.name,
  listDirectoryTool.declaration.name,
  diagnosticsTool.declaration.name,
  proposeEditTool.declaration.name,
  batchProposeEditsTool.declaration.name,
  terminalTool.declaration.name,
  skipVerificationTool.declaration.name,
  openFileTool.declaration.name,
]

const EDIT_CODE_CHANGES_TOOL_NAMES: readonly string[] = [
  ...EDIT_CODE_CHANGES_BASE_TOOL_NAMES,
  semanticSearchCodebaseTool.declaration.name,
  getRepoOverviewTool.declaration.name,
  findDependenciesTool.declaration.name,
  findDependentsTool.declaration.name,
  traceImportChainTool.declaration.name,
  findComponentUsageTool.declaration.name,
  findHookUsageTool.declaration.name,
  createFileTool.declaration.name,
  renameFileTool.declaration.name,
  deleteFileTool.declaration.name,
  manageTodosTool.declaration.name,
  gitActionTool.declaration.name,
]

// run_project intentionally uses the normal agent pipeline, but has no edit
// tools: it can start and observe the project, validate it in a browser, and
// stop the process when needed.
const RUN_PROJECT_TOOL_NAMES: readonly string[] = [
  terminalTool.declaration.name,
  browserCheckTool.declaration.name,
  killProcessTool.declaration.name,
  listRunningAppsTool.declaration.name,
  diagnosticsTool.declaration.name,
]

// -- build_new_project / design_project (share one tool set — see below) --
const BUILD_NEW_PROJECT_TOOL_NAMES: readonly string[] = [
  createFileTool.declaration.name,
  terminalTool.declaration.name,
  diagnosticsTool.declaration.name,
  browserCheckTool.declaration.name,
  manageTodosTool.declaration.name,
  skipVerificationTool.declaration.name,
  openInOsExplorerTool.declaration.name,
  openFileTool.declaration.name,
]

// -- terminal_task --
const TERMINAL_TOOL_NAMES: readonly string[] = [
  terminalTool.declaration.name,
  curlTool.declaration.name,
  gitActionTool.declaration.name,
  readFileTool.declaration.name,
  listDirectoryTool.declaration.name,
  killProcessTool.declaration.name,
]

// -- browser_task --
const BROWSER_TASK_RESEARCH_TOOL_NAMES: readonly string[] = [
  webSearchTool.declaration.name,
  curlTool.declaration.name,
  stackOverflowSearchTool.declaration.name,
  packageChangelogTool.declaration.name,
  openUrlTool.declaration.name,
]

// automation: drives a real headless browser (webTaskTool) through an
// ordered list of steps for a repeatable public-web task.
const BROWSER_TASK_AUTOMATION_TOOL_NAMES: readonly string[] = [
  webTaskTool.declaration.name,
]

const DESKTOP_TASK_INPUT_CONTROL_TOOL_NAMES: readonly string[] = [
  focusAppTool.declaration.name,
  mouseClickTool.declaration.name,
  mouseDragPathTool.declaration.name,
  pressKeyTool.declaration.name,
  pressKeySequenceTool.declaration.name,
  typeLinkInBrowserTool.declaration.name,
  takeScreenshotTool.declaration.name,
]

// -- desktop_task --
const DESKTOP_TASK_FILES_TOOL_NAMES: readonly string[] = [
  openInOsExplorerTool.declaration.name,
  openProjectFolderTool.declaration.name,
  openFileTool.declaration.name,
  listDirectoryTool.declaration.name,
  readFileTool.declaration.name,
  createFileTool.declaration.name,
  renameFileTool.declaration.name,
  deleteFileTool.declaration.name,
  copyFileTool.declaration.name,
  copyFolderTool.declaration.name,
  moveFolderTool.declaration.name,
  deleteFolderTool.declaration.name,
  createFolderTool.declaration.name,
  addFileToRequestTool.declaration.name,
]

const DESKTOP_TASK_APPS_TOOL_NAMES: readonly string[] = [
  openDefaultBrowserTool.declaration.name,
  openAppTool.declaration.name,
  focusAppTool.declaration.name,
  closeAppTool.declaration.name,
  listRunningAppsTool.declaration.name,
  killProcessTool.declaration.name,
  moveWindowTool.declaration.name,
  resizeWindowTool.declaration.name,
  minimizeWindowTool.declaration.name,
  maximizeWindowTool.declaration.name,
  listOpenWindowsTool.declaration.name,
]

const DESKTOP_TASK_RESEARCH_TOOL_NAMES: readonly string[] = [
  getSystemInfoTool.declaration.name,
  terminalTool.declaration.name,
  listFilesTool.declaration.name,
  readFileTool.declaration.name,
  searchFilesTool.declaration.name,
]

// -- mcp_task / chat --
const MCP_TASK_TOOL_NAMES: readonly string[] = [
  readFileTool.declaration.name,
  listDirectoryTool.declaration.name,
  webSearchTool.declaration.name,
]

/** Deliberately an explicit EMPTY array, not "unmapped" (which would fail open to the full registry) — Chat mode must carry zero tools. */
const CHAT_TOOL_NAMES: readonly string[] = []

// ── The registry itself ─────────────────────────────────────────────────────
//
// One table per intent that has sub-intent variation (work_with_repo,
// desktop_task), plus flat rows for intents with a single fixed {prompt, tools}
// pairing (including browser_task).

const WORK_WITH_REPO_ENTRIES: Record<EditSubIntent, UnresolvedEntry> = {
  code_reasearch:  { toolNames: EDIT_CODE_RESEARCH_TOOL_NAMES,   buildPrompt: buildCodingCodeResearchPrompt },
  code_changes:    { toolNames: EDIT_CODE_CHANGES_TOOL_NAMES,    buildPrompt: buildCodingCodeChangesPrompt },
  run_project:     { toolNames: RUN_PROJECT_TOOL_NAMES,          buildPrompt: buildCodingRunPrompt },
}


const BROWSER_TASK_ENTRIES: Partial<Record<BrowserTaskSubIntent, UnresolvedEntry>> = {
  research:   { toolNames: BROWSER_TASK_RESEARCH_TOOL_NAMES,   buildPrompt: () => RESEARCH_PROMPT },
  automation: { toolNames: BROWSER_TASK_AUTOMATION_TOOL_NAMES, buildPrompt: () => RESEARCH_PROMPT },
}

/** Fallback for a missing/unrecognized BROWSER_TASK sub-tag — same {prompt, tools} as `research`. */
const BROWSER_TASK_DEFAULT: UnresolvedEntry = BROWSER_TASK_ENTRIES.research!

/**
 * desktop_task's specialization prompt is fixed (DESKTOP_PROMPT) regardless
 * of sub-category — only the ALLOWED TOOLS narrow per category.
 */
const DESKTOP_TASK_ENTRIES: Partial<Record<DesktopTaskCategory, UnresolvedEntry>> = {
  files:            { toolNames: DESKTOP_TASK_FILES_TOOL_NAMES,            buildPrompt: () => DESKTOP_PROMPT },
  apps:             { toolNames: DESKTOP_TASK_APPS_TOOL_NAMES,             buildPrompt: () => DESKTOP_PROMPT },
  research:         { toolNames: DESKTOP_TASK_RESEARCH_TOOL_NAMES,         buildPrompt: () => `${DESKTOP_PROMPT}\n\n## Local research\nResearch only information about the local machine. Do not perform web research or use the internet; open-web research belongs to BROWSER_TASK:research. Select the narrowest appropriate tool automatically: prefer get_system_info for structured OS and hardware facts; use run_terminal_command only for read-only developer-environment queries that structured system information cannot answer; use list_files to browse, read_file for a known file, and search_files to locate names or content recursively. Never use a terminal command as a substitute for an available structured or filesystem tool.` },
  input_control:     { toolNames: DESKTOP_TASK_INPUT_CONTROL_TOOL_NAMES,    buildPrompt: () => `${DESKTOP_PROMPT}\n\n## Input control\nVisibly interact with the user's desktop or browser using mouse and keyboard controls. Whenever typing a URL into a browser address bar, use type_link_in_browser and perform navigation with a separate Enter key action.` },
}

/**
 * design_project (DESIGN_TASK) sub-intent table. `code_generation` (the
 * default design flow — renamed from the old bare/unsuffixed DESIGN_TASK
 * tag) intentionally points at the SAME array reference as
 * `build_new_project` (BUILD_NEW_PROJECT_TOOL_NAMES) — DESIGN_TASK and
 * CODING:NEW_PROJECT share the exact same available tool calls and
 * execution pipeline; only the specialist prompt differs.
 */
const DESIGN_TASK_ENTRIES: Partial<Record<DesignTaskSubIntent, UnresolvedEntry>> = {
  code_generation:  { toolNames: BUILD_NEW_PROJECT_TOOL_NAMES,          buildPrompt: buildDesignPrompt },
}

/** Fallback for a missing/unrecognized DESIGN_TASK sub-tag — same {prompt, tools} as `code_generation`. */
const DESIGN_TASK_DEFAULT: UnresolvedEntry = {
  toolNames: BUILD_NEW_PROJECT_TOOL_NAMES,
  buildPrompt: buildDesignPrompt,
}

/**
 * Every intent with a single fixed {prompt, tools} pairing — no sub-intent
 * variation. (`run_project` now lives under WORK_WITH_REPO_ENTRIES as an
 * EditSubIntent — see that table.)
 */
const FIXED_INTENT_ENTRIES: Partial<Record<ChatIntent, UnresolvedEntry>> = {
  build_new_project:      { toolNames: BUILD_NEW_PROJECT_TOOL_NAMES,          buildPrompt: buildCodingNewProjectPrompt },
  terminal_task:          { toolNames: TERMINAL_TOOL_NAMES,                  buildPrompt: buildCodingTerminalPrompt },
  mcp_task: {
    toolNames: MCP_TASK_TOOL_NAMES,
    buildPrompt: () => `${CHAT_PROMPT}\n\n## MCP task behaviour\nUse connected MCP tools only when the request requires an external service connector. If the needed connector is not available, explain what setup is required.`,
  },
  chat: { toolNames: CHAT_TOOL_NAMES, buildPrompt: () => CHAT_PROMPT },
}

/** Genuinely unknown/unclassified intent — fails open on tools, plain CHAT_PROMPT on the prompt side. */
const DEFAULT_ENTRY: UnresolvedEntry = { toolNames: undefined, buildPrompt: () => CHAT_PROMPT }

/**
 * Looks up the single registry row for an (Intent, SubIntent) pair. This is
 * the ONE place that branches on the taxonomy — everything else in this
 * module (and everything outside it, via the exports below) just reads the
 * result.
 */
function lookupEntry(intent?: ChatIntent, subIntent?: AgentSubIntent): UnresolvedEntry {
  if (!intent) return DEFAULT_ENTRY

  if (intent === 'work_with_repo') {
    return subIntent && subIntent in WORK_WITH_REPO_ENTRIES
      ? WORK_WITH_REPO_ENTRIES[subIntent as EditSubIntent]
      : DEFAULT_ENTRY
  }

  if (intent === 'desktop_task') {
    const category = subIntent as DesktopTaskCategory | undefined
    return category && category in DESKTOP_TASK_ENTRIES ? DESKTOP_TASK_ENTRIES[category]! : DEFAULT_ENTRY
  }

  if (intent === 'design_project') {
    const sub = subIntent as DesignTaskSubIntent | undefined
    return sub && sub in DESIGN_TASK_ENTRIES ? DESIGN_TASK_ENTRIES[sub]! : DESIGN_TASK_DEFAULT
  }

  if (intent === 'browser_task') {
    const sub = subIntent as BrowserTaskSubIntent | undefined
    return sub && sub in BROWSER_TASK_ENTRIES ? BROWSER_TASK_ENTRIES[sub]! : BROWSER_TASK_DEFAULT
  }

  return FIXED_INTENT_ENTRIES[intent] ?? DEFAULT_ENTRY
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the built-in tool names allowed for a given (Intent, SubIntent)
 * pair, or `undefined` to signal "no scoping — use the full tool registry"
 * (unknown intent, or an intent/sub-intent combination that isn't mapped).
 *
 * This is the exact same lookup resolveIntentRegistryEntry() uses for its
 * `toolNames` field — exposed on its own because some callers (e.g.
 * services/agent/AgentLoop.ts's tool-declaration builder) only need the
 * tool half, not a freshly-built prompt string.
 */
export function getToolNamesForIntent(intent?: ChatIntent, subIntent?: AgentSubIntent): readonly string[] | undefined {
  return lookupEntry(intent, subIntent).toolNames
}

/**
 * Resolves the full registry row — specialization prompt AND allowed tool
 * names — for a single execution step's (Intent, SubIntent) pair. This is
 * the ONE function every executor should call to learn both facts about a
 * step; nothing should re-derive either one from `intent`/`subIntent`
 * through a separate table.
 *
 * @param intent    The planned step's ChatIntent.
 * @param subIntent The step's EditSubIntent / BrowserTaskSubIntent /
 *                  DesktopTaskCategory, when `intent` calls for one.
 */
export function resolveIntentRegistryEntry(
  intent?: ChatIntent,
  subIntent?: AgentSubIntent,
): IntentRegistryEntry {
  const entry = lookupEntry(intent, subIntent)
  const prompt = entry.buildPrompt(entry.toolNames)
  return { prompt, toolNames: entry.toolNames }
}
