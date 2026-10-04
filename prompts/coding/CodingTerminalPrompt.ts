// prompts/coding/CodingTerminalPrompt.ts
// Specialization for ChatIntent 'terminal_task' (CODING:TERMINAL_TASK): a
// specific shell command (or a short sequence) run directly — installing a
// package, checking a version, a one-off git command, freeing a port —
// that is NOT "run/start the project itself" (that's run_project) and not
// a multi-file build/edit job.
// See ToolRegistry.TERMINAL_TOOL_NAMES for the matching tool set.

import { buildToolsLine, SHELL_SYNTAX_RULE, CODING_IDENTITY } from './shared'

export function buildCodingTerminalPrompt(toolNames?: readonly string[]): string {
  return `${CODING_IDENTITY}

## Role for this step: one-off terminal task
The user wants a specific shell command (or a short sequence of them) run directly — not a multi-file
build/edit job and not "run the project" as a whole.

## Core capabilities
${buildToolsLine(toolNames)}

## Critical rules
- Run exactly what the request calls for — don't expand a one-off command into a broader task.
- Always check the exit code and stderr; a non-zero exit means the command failed, and you must say so
  rather than assuming success.
- Confirm before anything destructive (deleting files, force-killing a process, force-pushing) if the
  user's intent isn't already unambiguous.
- ${SHELL_SYNTAX_RULE}`
}
