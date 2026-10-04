// prompts/__tests__/promptBuilder.test.ts
//
// Covers:
//   - The DESIGN vs CODING:NEW_PROJECT (build_new_project) prompt split:
//     each intent gets its own, distinct specialist prompt, and neither
//     falls back to the generic CHAT_PROMPT.
//   - SubIntent-specific specialization: each (Intent, SubIntent) pair
//     resolves to its OWN focused Coding*Prompt, not one shared blob.
//   - Tool-name scoping: the specialist prompt's tool mentions must match
//     EXACTLY what ToolRegistry.getToolNamesForIntent resolves for that
//     same intent/subIntent -- no hardcoded, hand-maintained tool list that
//     can drift from what's actually sent to the model at execution time.
//   - work_with_repo has exactly three supported sub-intents and no generic
//     prompt fallback.

import '../../services/agent/__tests__/_localStoragePolyfill'
import { describe, it, expect } from 'vitest'
import { getIntentPrompt, resolveSpecialistPrompt } from '../promptBuilder'
import { EXECUTOR_PROMPT } from '../executorPrompt'
import { GENERIC_AGENT_IDENTITY } from '../../lib/agenticClassifier'

describe('EXECUTOR_PROMPT', () => {
  it('starts with the shared generic agent identity', () => {
    expect(EXECUTOR_PROMPT.startsWith(GENERIC_AGENT_IDENTITY)).toBe(true)
    expect(EXECUTOR_PROMPT).not.toContain('You are the execution agent for Rachna AI Studio.')
  })
})
import {
  buildCodingReadOnlyPrompt as buildCodingCodeResearchPrompt,
  buildCodingFeaturePrompt as buildCodingCodeChangesPrompt,
  buildCodingNewProjectPrompt,
  buildCodingRunPrompt,
  buildCodingTerminalPrompt,
} from '../codingPrompt'
import { buildDesignPrompt } from '../designPrompt'
import { CHAT_PROMPT } from '../chatPrompt'
import { getToolNamesForIntent } from '../../services/agent/ToolRegistry'

describe('getIntentPrompt — design_project vs build_new_project', () => {
  it('design_project resolves to buildDesignPrompt output', () => {
    const toolNames = getToolNamesForIntent('design_project')
    expect(getIntentPrompt('design_project')).toBe(buildDesignPrompt(toolNames))
  })

  it('build_new_project resolves to buildCodingNewProjectPrompt output', () => {
    const toolNames = getToolNamesForIntent('build_new_project')
    expect(getIntentPrompt('build_new_project')).toBe(buildCodingNewProjectPrompt(toolNames))
  })

  it('build_new_project stays autonomous through creation and verification', () => {
    const prompt = getIntentPrompt('build_new_project')
    expect(prompt).toMatch(/do not stop for a\s+second file-review or manual-approval round/)
    expect(prompt).toContain('Install the required dependencies')
    expect(prompt).toContain('Build and run the project')
    expect(prompt).toContain('Fix any failure')
    expect(prompt).not.toContain('Stop here and let the user')
    expect(prompt).not.toContain('Once the user accepts')
  })

  it('the two specialist prompts are not the same text even with identical tool sets', () => {
    expect(getIntentPrompt('design_project')).not.toEqual(getIntentPrompt('build_new_project'))
  })

  it('neither intent falls back to the generic CHAT_PROMPT', () => {
    expect(getIntentPrompt('design_project')).not.toBe(CHAT_PROMPT)
    expect(getIntentPrompt('build_new_project')).not.toBe(CHAT_PROMPT)
  })

  it('design prompt is focused on visual/design work', () => {
    const prompt = getIntentPrompt('design_project')
    expect(prompt).toMatch(/design/i)
    expect(prompt).toMatch(/tailwind/i)
    expect(prompt).toMatch(/lucide/i)
  })
})

describe('resolveSpecialistPrompt — selected specialist prompt', () => {
  it('uses the new-project specialist for CODING_TASK:NEW_PROJECT', () => {
    expect(resolveSpecialistPrompt('CODING_TASK', 'new_project')).toBe(getIntentPrompt('build_new_project'))
  })

  it('uses specialist-specific prompts for non-coding task types', () => {
    expect(resolveSpecialistPrompt('DESIGN_TASK')).toBe(getIntentPrompt('design_project', 'code_generation'))
    expect(resolveSpecialistPrompt('TERMINAL_TASK')).toBe(getIntentPrompt('terminal_task'))
    expect(resolveSpecialistPrompt('DESKTOP_TASK')).toBe(getIntentPrompt('desktop_task', 'files'))
    expect(resolveSpecialistPrompt('MCP_TASK')).toBe(getIntentPrompt('mcp_task'))
    expect(resolveSpecialistPrompt('BROWSER_TASK')).toBe(getIntentPrompt('browser_task', 'research'))
  })
})

describe('getIntentPrompt — coding family resolves to focused SubIntent-specific prompts', () => {
  it('work_with_repo:code_reasearch resolves to buildCodingReadOnlyPrompt output', () => {
    const toolNames = getToolNamesForIntent('work_with_repo', 'code_reasearch')
    expect(getIntentPrompt('work_with_repo', 'code_reasearch')).toBe(buildCodingCodeResearchPrompt(toolNames))
  })

  it('work_with_repo:code_changes resolves to buildCodingFeaturePrompt output', () => {
    const toolNames = getToolNamesForIntent('work_with_repo', 'code_changes')
    expect(getIntentPrompt('work_with_repo', 'code_changes')).toBe(buildCodingCodeChangesPrompt(toolNames))
  })

  it('work_with_repo with no sub-intent has no generic coding fallback', () => {
    expect(getToolNamesForIntent('work_with_repo', undefined)).toBeUndefined()
    expect(getIntentPrompt('work_with_repo', undefined)).toBe(CHAT_PROMPT)
  })

  it('work_with_repo with an unrecognized sub-intent has no generic coding fallback', () => {
    expect(getToolNamesForIntent('work_with_repo', 'not_a_real_subintent' as any)).toBeUndefined()
    expect(getIntentPrompt('work_with_repo', 'not_a_real_subintent' as any)).toBe(CHAT_PROMPT)
  })

  it('work_with_repo:run_project resolves to buildCodingRunPrompt output', () => {
    const toolNames = getToolNamesForIntent('work_with_repo', 'run_project')
    expect(getIntentPrompt('work_with_repo', 'run_project')).toBe(buildCodingRunPrompt(toolNames))
  })

  it('terminal_task resolves to buildCodingTerminalPrompt output', () => {
    const toolNames = getToolNamesForIntent('terminal_task')
    expect(getIntentPrompt('terminal_task')).toBe(buildCodingTerminalPrompt(toolNames))
  })

  it('every coding SubIntent produces a genuinely distinct prompt, not shared text', () => {
    const prompts = [
      getIntentPrompt('work_with_repo', 'code_reasearch'),
      getIntentPrompt('work_with_repo', 'code_changes'),
      getIntentPrompt('build_new_project'),
      getIntentPrompt('work_with_repo', 'run_project'),
      getIntentPrompt('terminal_task'),
    ]
    expect(new Set(prompts).size).toBe(prompts.length)
  })
})

describe('getIntentPrompt — specialization prompts stay behavior-only, not tool documentation', () => {
  it('the code_reasearch prompt does not document write/terminal/git tool call syntax', () => {
    const prompt = getIntentPrompt('work_with_repo', 'code_reasearch')
    expect(prompt).not.toMatch(/run_terminal_command/i)
    expect(prompt).not.toMatch(/git_action/i)
    expect(prompt).not.toMatch(/propose_edit/i)
  })

  it('specialist coding prompts are meaningfully smaller than the old single-prompt design implied', () => {
    // The read-only research prompt should be a fraction of a "does everything" prompt's
    // size, since tool descriptions/parameters/examples have been removed. code_changes now
    // covers what used to be two separate sub-intents (debug + feature merged), so it's
    // naturally larger, but should still be smaller than the generic fallback prompt.
    const readOnly = getIntentPrompt('work_with_repo', 'code_reasearch')
    const changes = getIntentPrompt('work_with_repo', 'code_changes')
    expect(readOnly.length).toBeLessThan(3000)
    expect(changes.length).toBeLessThan(6000)
  })
})

describe('getIntentPrompt — tool-name scoping matches ToolRegistry exactly', () => {
  it('work_with_repo:code_reasearch only mentions the code_reasearch tool set, not the full coding registry', () => {
    const prompt = getIntentPrompt('work_with_repo', 'code_reasearch')
    const toolNames = getToolNamesForIntent('work_with_repo', 'code_reasearch')!
    for (const name of toolNames) {
      expect(prompt).toContain(name)
    }
    expect(toolNames).not.toContain('run_terminal_command')
    expect(toolNames).not.toContain('git_action')
    expect(toolNames).not.toContain('propose_edit')
  })

  it('chat intent gets an explicit "no tools" tool set, not the fail-open full registry', () => {
    const toolNames = getToolNamesForIntent('chat')
    expect(toolNames).toEqual([])
  })

  it('different EditSubIntents produce different coding prompts', () => {
    const readOnly = getIntentPrompt('work_with_repo', 'code_reasearch')
    const feature = getIntentPrompt('work_with_repo', 'code_changes')
    expect(readOnly).not.toEqual(feature)
  })

  it('build_new_project and terminal_task each mention their own scoped tool names', () => {
    for (const intent of ['build_new_project', 'terminal_task'] as const) {
      const prompt = getIntentPrompt(intent)
      const toolNames = getToolNamesForIntent(intent)!
      for (const name of toolNames) {
        expect(prompt).toContain(name)
      }
    }
  })

  it('work_with_repo:run_project resolves to its own process-oriented prompt and scoped tools', () => {
    const prompt = getIntentPrompt('work_with_repo', 'run_project')
    const toolNames = getToolNamesForIntent('work_with_repo', 'run_project')
    expect(toolNames).toEqual([
      'run_terminal_command',
      'browser_check',
      'kill_process',
      'list_running_apps',
      'get_diagnostics',
    ])
    expect(prompt).toBe(buildCodingRunPrompt(toolNames))
  })
})
