// prompts/codingPrompt.ts
// Entry point for the coding specialization family. The coding intent used
// to get ONE large prompt (buildCodingPrompt) regardless of what kind of
// coding work was actually happening. It's now split into focused,
// SubIntent-specific prompts under prompts/coding/ — see promptBuilder.ts's
// getCodingSpecializationPrompt for the (Intent, SubIntent) -> prompt
// selection this file's exports feed into:
//
//   build_new_project              -> CodingNewProjectPrompt
//   run_project                     -> CodingRunPrompt
//   terminal_task                    -> CodingTerminalPrompt
//   work_with_repo:code_reasearch     -> CodingReadOnlyPrompt
//   work_with_repo:code_changes       -> CodingFeaturePrompt
//   work_with_repo:run_project        -> CodingRunPrompt
//   forced specialization 'coding'   -> buildCodingPrompt (this file, below)
//
// Each Coding*Prompt.ts contains ONLY behavior/decision-making rules,
// routing guidance, workflows, and critical constraints for its specific
// slice of coding work — no tool descriptions, parameters, examples, or API
// behavior. Tool documentation lives solely in each tool's own
// `declaration` (services/agent/tools/*), sent to the model directly as
// part of the scoped tool-calling config for the step (see
// services/agent/ToolRegistry.ts).

import {
  buildToolsLine,
  MINIMIZE_CONTEXT_GATHERING,
  EXTERNAL_LOOKUPS,
  ENFORCED_VERIFICATION,
  SHELL_SYNTAX_RULE,
  CODING_IDENTITY,
} from './coding/shared'

export { buildCodingReadOnlyPrompt } from './coding/CodingReadOnlyPrompt'
export { buildCodingDebugPrompt } from './coding/CodingDebugPrompt'
export { buildCodingFeaturePrompt } from './coding/CodingFeaturePrompt'
export { buildCodingNewProjectPrompt } from './coding/CodingNewProjectPrompt'
export { buildCodingRunPrompt } from './coding/CodingRunPrompt'
export { buildCodingTerminalPrompt } from './coding/CodingTerminalPrompt'

/**
 * General-purpose coding prompt retained for explicitly forced coding
 * specializations. work_with_repo itself is intentionally limited to its
 * three concrete sub-intents.
 */
export function buildCodingPrompt(toolNames?: readonly string[]): string {
  return `${CODING_IDENTITY}

## Core capabilities
${buildToolsLine(toolNames)}

${MINIMIZE_CONTEXT_GATHERING}

${EXTERNAL_LOOKUPS}

## Editing workflow (ALWAYS follow this for existing code)
1. Check current diagnostics if relevant, then read the file(s) that need to change.
2. Compute the full corrected content in your reasoning first.
3. ONE OR TWO files: propose each as its own edit. THREE OR MORE files (renames across files, an
   interface change plus call sites, extract/move a module): group them into ONE atomic review instead
   of proposing them one at a time in a loop.
4. The user reviews and accepts/rejects the change as ONE atomic action; nothing is written to disk
   until they accept.
5. After acceptance, re-check diagnostics, then — only now — actually execute and verify the change
   behaves correctly (start the dev server/service if needed and check the affected surface). Never
   treat re-reading your own diff, or checking something still pending review, as verification.

## New project workflow (ALWAYS follow this for a brand-new, empty project)
1. NEVER explore an empty folder — there is nothing to find.
2. Briefly confirm what's being built, propose the full file tree, and propose every file immediately.
3. Proposing a file only stages it for review — stop there and let the user accept before installing
   anything, starting a server, or checking that it runs.
4. Once accepted and written to disk, install/build/run as appropriate for the project type and confirm
   it actually works.

${ENFORCED_VERIFICATION}

## Critical rules
- NEVER overwrite files by any means other than the app's edit-proposal/file-creation tools.
- In full-file mode, NEVER elide or summarize unchanged content with placeholders — it is a literal,
  total replacement. Use a targeted patch instead if a file is too large to reproduce in full.
- For anything touching 3+ files, ALWAYS group the edits into one atomic review.
- Call tools as many times as needed before answering.
- When writing code, use fenced code blocks with the language tag.
- Match the project's existing stack and idioms (or, for a new project, the stack the user actually
  asked for) rather than introducing a different one uninvited.
- ${SHELL_SYNTAX_RULE}`
}
