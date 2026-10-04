// prompts/promptBuilder.ts
// Combines shared identity with the prompt for a planned execution step.
//
// The (Intent, SubIntent) → specialization-prompt lookup that used to live
// in this file (EDIT_SUB_INTENT_PROMPTS, getCodingSpecializationPrompt,
// getIntentPrompt's intent/sub-intent branching) now lives in
// lib/intentRegistry.ts, paired there with the SAME (Intent, SubIntent)
// pair's allowed tool names (see IntentRegistry's file header for why the
// prompt and tool-set lookups used to be two separately-maintained tables
// and why they're one now). This file is kept as a thin, backward-
// compatible wrapper — components/AiChat/prompts.ts and this file's own
// tests import `getIntentPrompt`/`buildPromptForIntent` from here — but it
// no longer contains any (Intent, SubIntent) branching of its own.

import type { ChatIntent, AgentSubIntent, TopIntent } from '../lib/intentClassifier'
import { EXECUTOR_PROMPT } from './executorPrompt'
import { resolveIntentRegistryEntry } from '../lib/intentRegistry'
import { buildCodingPrompt } from './codingPrompt'

/**
 * Resolves the specialization prompt for a single execution step's (Intent,
 * SubIntent) pair, exclusively through IntentRegistry — see
 * lib/intentRegistry.ts::resolveIntentRegistryEntry for the full resolution
 * order (sub-intent lookup + fallback, fixed per-intent prompts, and the
 * plain-chat default).
 */
export function getIntentPrompt(intent?: ChatIntent, subIntent?: AgentSubIntent): string {
  return resolveIntentRegistryEntry(intent, subIntent).prompt
}

export function buildPromptForIntent(intent?: ChatIntent, subIntent?: AgentSubIntent): string {
  return [EXECUTOR_PROMPT, getIntentPrompt(intent, subIntent)].join('\n\n')
}

/**
 * Resolves the prompt for the user-selected specialist. The Task Planner
 * uses it before selecting per-step sub-intents, so CODING_TASK with an
 * existing project intentionally uses the broad coding prompt. Execution
 * later resolves every planned step through the same intent registry.
 */
export function resolveSpecialistPrompt(
  topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>,
  codingWorkspace?: 'new_project' | 'existing_project',
): string {
  switch (topIntent) {
    case 'CODING_TASK':
      return codingWorkspace === 'new_project'
        ? getIntentPrompt('build_new_project')
        : buildCodingPrompt()
    case 'DESIGN_TASK':
      return getIntentPrompt('design_project', 'code_generation')
    case 'TERMINAL_TASK':
      return getIntentPrompt('terminal_task')
    case 'DESKTOP_TASK':
      // The category is selected by the planner; every desktop category
      // shares the base desktop behavior prompt.
      return getIntentPrompt('desktop_task', 'files')
    case 'MCP_TASK':
      return getIntentPrompt('mcp_task')
    case 'BROWSER_TASK':
      return getIntentPrompt('browser_task', 'research')
  }
}
