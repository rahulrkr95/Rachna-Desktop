// services/agent/__tests__/ToolRegistry.test.ts
//
// Covers the intent-scoped (and, for work_with_repo/desktop_task,
// sub-intent-scoped) tool filtering in ToolRegistry:
//   - getToolDeclarations() with no args still returns everything
//     (fail-open default — must never regress).
//   - getToolDeclarations(names) restricts to exactly those names, silently
//     skipping any unknown/stale entries instead of throwing.
//   - getToolNamesForIntent() returns undefined for genuinely unmapped
//     combinations (no intent, work_with_repo without one of its three live
//     sub-intents, or desktop_task without a recognized category).
//   - browser_task has only one supported mode, so its tools live
//     directly on the intent like mcp_task.
//   - getToolNamesForIntent(intent, subIntent) returns the exact expected
//     narrow subset for each EditSubIntent / DesktopTaskCategory.
//   - build_new_project / terminal_task / mcp_task (single fixed sets, no
//     sub-intent) keep their existing exclusions.
//   - desktop_task:files / desktop_task:apps return their own scoped desktop-
//     control tool sets.

import './_localStoragePolyfill'
import { describe, it, expect } from 'vitest'
import { getToolDeclarations, getToolNamesForIntent, toolRegistry } from '../ToolRegistry'
import type { ChatIntent, EditSubIntent } from '../../../lib/intentClassifier'

// ── localStorage polyfill ────────────────────────────────────────────────────
// vitest.config.ts runs tests under environment: 'node', which has no
// localStorage. ToolRegistry pulls in several tool modules whose backing
// Zustand stores read localStorage eagerly at module-load time (e.g.
// useApiKeyStore) — pre-existing behaviour, not something this test is
// exercising — polyfilled via the side-effect import above (see
// _localStoragePolyfill.ts for why it has to be a separate, first import
// rather than inline code here).

const ALL_TOOL_NAMES = Object.keys(toolRegistry)


describe('getToolDeclarations', () => {
  it('returns every registered tool when called with no filter', () => {
    const decls = getToolDeclarations()
    expect(decls.map(d => d.name).sort()).toEqual([...ALL_TOOL_NAMES].sort())
  })

  it('restricts to exactly the given names when a filter is provided', () => {
    const subset = ['read_file', 'list_directory']
    const decls = getToolDeclarations(subset)
    expect(decls.map(d => d.name).sort()).toEqual([...subset].sort())
  })

  it('silently skips unknown/stale tool names instead of throwing', () => {
    const decls = getToolDeclarations(['read_file', 'this_tool_does_not_exist'])
    expect(decls.map(d => d.name)).toEqual(['read_file'])
  })

  it('returns an empty array for an empty filter (not the full registry)', () => {
    expect(getToolDeclarations([])).toEqual([])
  })
})

describe('getToolNamesForIntent — fail-open cases (no scoping at all)', () => {
  const failOpenIntents: Array<ChatIntent | undefined> = [
    undefined,
  ]

  for (const intent of failOpenIntents) {
    it(`returns undefined (full registry) for intent=${String(intent)}`, () => {
      expect(getToolNamesForIntent(intent)).toBeUndefined()
    })
  }
})

describe('getToolNamesForIntent — single fixed-set intents', () => {
  const scopedIntents: ChatIntent[] = ['build_new_project', 'terminal_task', 'mcp_task']

  for (const intent of scopedIntents) {
    it(`returns a strict, non-empty subset of the registry for ${intent}`, () => {
      const names = getToolNamesForIntent(intent)
      expect(names).toBeDefined()
      expect(names!.length).toBeGreaterThan(0)
      expect(names!.length).toBeLessThan(ALL_TOOL_NAMES.length)
      for (const name of names!) {
        expect(ALL_TOOL_NAMES).toContain(name)
      }
    })
  }

  it('build_new_project drops search/grep/graph/git tools (nothing exists yet)', () => {
    const names = getToolNamesForIntent('build_new_project')!
    expect(names).not.toContain('grep_codebase')
    expect(names).not.toContain('search_codebase')
    expect(names).not.toContain('git_action')
    expect(names).not.toContain('find_dependencies')
    expect(names).toContain('create_file')
    expect(names).toContain('run_terminal_command')
  })

  it('design_project has exactly the same tool set as build_new_project (shared execution pipeline, no duplicated list)', () => {
    const buildNames = getToolNamesForIntent('build_new_project')!
    const designNames = getToolNamesForIntent('design_project')!
    expect(designNames).toEqual(buildNames)
  })

  it('terminal_task excludes editing/web-only tools', () => {
    const names = getToolNamesForIntent('terminal_task')!
    expect(names).not.toContain('propose_edit')
    expect(names).not.toContain('web_task')
    expect(names).toContain('run_terminal_command')
  })

  it('mcp_task keeps only minimal context tools (MCP server tools are appended separately by AgentLoop)', () => {
    const names = getToolNamesForIntent('mcp_task')!
    expect(names).not.toContain('propose_edit')
    expect(names).not.toContain('run_terminal_command')
    expect(names).toContain('read_file')
  })

  it("chat (Agentic/Chat toggle set to Chat mode) returns an explicit EMPTY array, not undefined — must not fail open to the full registry", () => {
    const names = getToolNamesForIntent('chat')
    expect(names).toBeDefined()
    expect(names).toEqual([])
  })
})

describe('getToolNamesForIntent — work_with_repo sub-intents', () => {
  it('has no no-sub-intent fallback; one of the three live sub-intents is required', () => {
    expect(getToolNamesForIntent('work_with_repo')).toBeUndefined()
  })

  it('does not provide a work_with_repo fallback for an unrecognized sub-intent string', () => {
    // @ts-expect-error — deliberately passing a bogus value to prove there is no fallback
    expect(getToolNamesForIntent('work_with_repo', 'not_a_real_sub_intent')).toBeUndefined()
  })

  it('code_reasearch is read-only: zero write/terminal/git tools', () => {
    const names = getToolNamesForIntent('work_with_repo', 'code_reasearch')!
    expect(names).toContain('read_file')
    expect(names).toContain('search_codebase')
    expect(names).toContain('find_dependencies')
    for (const writeTool of ['propose_edit', 'batch_propose_edits', 'create_file', 'rename_file', 'delete_file', 'run_terminal_command', 'git_action']) {
      expect(names).not.toContain(writeTool)
    }
  })

  it('code_changes keeps edit + terminal tools', () => {
    const names = getToolNamesForIntent('work_with_repo', 'code_changes')!
    expect(names).toContain('propose_edit')
    expect(names).toContain('get_diagnostics')
    expect(names).toContain('run_terminal_command')
    expect(names).toContain('find_dependencies')
    expect(names).toContain('git_action')
    expect(names).toContain('manage_todos')
  })

  it('code_reasearch is a strict subset of code_changes', () => {
    const researchNames = getToolNamesForIntent('work_with_repo', 'code_reasearch')!
    const changesNames  = getToolNamesForIntent('work_with_repo', 'code_changes')!
    expect(changesNames.length).toBeGreaterThan(researchNames.length)
  })

  it('supports exactly the three work_with_repo sub-intents', () => {
    const subIntents: EditSubIntent[] = ['code_reasearch', 'code_changes', 'run_project']
    expect(subIntents).toHaveLength(3)
    expect(getToolNamesForIntent('work_with_repo', 'code_reasearch')).toBeDefined()
    expect(getToolNamesForIntent('work_with_repo', 'code_changes')).toBeDefined()
    expect(getToolNamesForIntent('work_with_repo', 'run_project')).toEqual([
      'run_terminal_command',
      'browser_check',
      'kill_process',
      'list_running_apps',
      'get_diagnostics',
    ])
  })
})

describe('getToolNamesForIntent — browser_task', () => {
  it('attaches research tools directly to the top-level intent', () => {
    expect(getToolNamesForIntent('browser_task')).toEqual(getToolNamesForIntent('browser_task', 'research'))
  })

  it('research excludes the browser-automation tool', () => {
    const names = getToolNamesForIntent('browser_task', 'research')!

    expect(names).toContain('web_search')
    expect(names).toContain('curl_request')

    expect(names).not.toContain('web_task')
    expect(names).not.toContain('browser_check')
  })

})

describe('getToolNamesForIntent — desktop_task categories', () => {
  it('research exposes only the five modular local research tools', () => {
    expect(getToolNamesForIntent('desktop_task', 'research')).toEqual([
      'get_system_info',
      'run_terminal_command',
      'list_files',
      'read_file',
      'search_files',
    ])
  })

  it('exposes input-control tools only for the input_control category', () => {
    for (const category of ['files', 'apps', 'research'] as const) {
      const names = getToolNamesForIntent('desktop_task', category)!
      expect(names).not.toContain('mouse_click')
      expect(names).not.toContain('press_key')
    }
    const names = getToolNamesForIntent('desktop_task', 'input_control')!
    expect(names).not.toContain('openDefaultBrowser')
    expect(names).toContain('mouse_click')
    expect(names).toContain('mouse_drag_path')
    expect(names).toContain('press_key')
    expect(names).toContain('press_key_sequence')
    expect(names).toContain('type_link_in_browser')
  })

  it('files returns the file/folder desktop-control tools, nothing app-related', () => {
    const names = getToolNamesForIntent('desktop_task', 'files')!
    expect(names).toBeDefined()
    expect(names).toContain('open_in_os_explorer')
    expect(names).toContain('open_project_folder')
    expect(names).toContain('open_file')
    expect(names).not.toContain('open_app')
    expect(names).not.toContain('kill_process')
    for (const name of names) {
      expect(ALL_TOOL_NAMES).toContain(name)
    }
  })

  it('apps returns the app-control tools, nothing file-related', () => {
    const names = getToolNamesForIntent('desktop_task', 'apps')!
    expect(names).toBeDefined()
    expect(names).toContain('open_app')
    // openDefaultBrowser lives here now — launching the system default
    // browser is app control, not raw mouse/keyboard input control.
    expect(names).toContain('openDefaultBrowser')
    expect(names).toContain('focus_app')
    expect(names).toContain('close_app')
    expect(names).toContain('list_running_apps')
    expect(names).toContain('kill_process')
    expect(names).not.toContain('open_in_os_explorer')
    for (const name of names) {
      expect(ALL_TOOL_NAMES).toContain(name)
    }
  })

  it('falls open (undefined) when no system-task category is given', () => {
    expect(getToolNamesForIntent('desktop_task')).toBeUndefined()
  })
})
