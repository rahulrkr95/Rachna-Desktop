import '../../services/agent/__tests__/_localStoragePolyfill'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildTaskPlannerSystemPrompt, parseExecutionSteps, parseSpecialistRedirect } from '../planGenerator'
import { resolveSpecialistPrompt } from '../../prompts/promptBuilder'
import { INTENT_DEFINITIONS, PLANNABLE_TOP_INTENTS, getIntentDefinitions } from '../intentClassifier'

describe('Task Planner selected-specialist prompt', () => {
  it('requires a topIntent at compile time', () => {
    if (false) {
      // @ts-expect-error The Task Planner cannot be built without a selected specialist.
      buildTaskPlannerSystemPrompt()
    }
  })

  it('contains all intent definitions but only the supplied specialist behavior prompt', () => {
    const prompt = buildTaskPlannerSystemPrompt('TERMINAL_TASK')
    expect(prompt).toContain(resolveSpecialistPrompt('TERMINAL_TASK'))
    expect(prompt).not.toContain(resolveSpecialistPrompt('DESIGN_TASK'))
    expect(getIntentDefinitions()).toBe(INTENT_DEFINITIONS)
    for (const intent of PLANNABLE_TOP_INTENTS) {
      expect(prompt).toContain(intent)
    }
    expect(prompt).not.toContain('AGENTIC_TASK')
    expect(prompt).not.toContain('Classify it into')
    expect(prompt).not.toContain('Meaning of specilists')
  })

  it('uses the new-project specialist after new workspace initialization', () => {
    const prompt = buildTaskPlannerSystemPrompt('CODING_TASK', undefined, 'NEW_PROJECT initialized')

    expect(prompt).toContain(resolveSpecialistPrompt('CODING_TASK', 'new_project'))
  })

  it('may report a specialist mismatch without planning under it', () => {
    const prompt = buildTaskPlannerSystemPrompt('CODING_TASK')
    expect(prompt).toContain('selected specialist')
    expect(prompt).toContain('must not produce a plan under another specialist')
    expect(parseSpecialistRedirect('{"moveTo":"DESIGN_TASK","reason":"Visual design request."}')).toEqual({
      suggestedTopIntent: 'DESIGN_TASK',
      reason: 'Visual design request.',
    })
  })

  it('requires JSON execution plans without sentinel markers', () => {
    const prompt = buildTaskPlannerSystemPrompt('CODING_TASK')
    expect(prompt).toContain('"steps"')
    expect(prompt).toContain('"dependsOn"')
    expect(prompt).toContain('Do not use Markdown fences')
    expect(prompt).not.toContain('STEP: step_<n>')
  })

  it.each([
    ['CODING_TASK', 'SOFTWARE:WORK_WITH_REPO:code_changes', 'work_with_repo', 'code_changes'],
    ['CODING_TASK', 'SOFTWARE:NEW_PROJECT', 'build_new_project', undefined],
    ['TERMINAL_TASK', 'TERMINAL_TASK', 'terminal_task', undefined],
    ['DESKTOP_TASK', 'DESKTOP_TASK:apps', 'desktop_task', 'apps'],
    ['DESIGN_TASK', 'DESIGN_TASK:code_generation', 'design_project', 'code_generation'],
    ['BROWSER_TASK', 'BROWSER_TASK:automation', 'browser_task', 'automation'],
    ['MCP_TASK', 'MCP_TASK:github', 'mcp_task', undefined],
  ] as const)('parses %s steps under the supplied specialist', (topIntent, tag, intent, subIntent) => {
    const raw = JSON.stringify({ steps: [{ id: 'step_1', intent: tag, task: 'Do the work', dependsOn: [] }] })
    expect(parseExecutionSteps(raw, topIntent)?.[0]).toMatchObject({ intent, subIntent })
  })

  it('parses multiple JSON steps with dependencies and empty dependsOn', () => {
    const raw = `{"steps":[{"id":"step_1","intent":"SOFTWARE:WORK_WITH_REPO:code_research","task":"Inspect the project","dependsOn":[]},{"id":"step_2","intent":"SOFTWARE:WORK_WITH_REPO:code_changes","task":"Implement the change","dependsOn":["step_1"]}]}`
    expect(parseExecutionSteps(raw, 'CODING_TASK')).toEqual([
      { id: 'step_1', intent: 'work_with_repo', subIntent: undefined, task: 'Inspect the project', dependsOn: [] },
      { id: 'step_2', intent: 'work_with_repo', subIntent: 'code_changes', task: 'Implement the change', dependsOn: ['step_1'] },
    ])
  })

  it.each([
    ['malformed JSON', '{"steps":[}'],
    ['missing steps', '{"plan":[]}'],
    ['empty steps', '{"steps":[]}'],
    ['missing id', '{"steps":[{"intent":"TERMINAL_TASK","task":"Work","dependsOn":[]}]}'],
    ['empty intent', '{"steps":[{"id":"step_1","intent":"","task":"Work","dependsOn":[]}]}'],
    ['empty task', '{"steps":[{"id":"step_1","intent":"TERMINAL_TASK","task":" ","dependsOn":[]}]}'],
    ['non-array dependsOn', '{"steps":[{"id":"step_1","intent":"TERMINAL_TASK","task":"Work","dependsOn":"none"}]}'],
    ['invalid dependency', '{"steps":[{"id":"step_1","intent":"TERMINAL_TASK","task":"Work","dependsOn":[""]}]}'],
  ])('rejects %s', (_label, json) => {
    expect(parseExecutionSteps(json, 'TERMINAL_TASK')).toBeNull()
  })

  it('rejects sentinel markers and other text around the JSON', () => {
    const json = '{"steps":[{"id":"step_1","intent":"TERMINAL_TASK","task":"Work","dependsOn":[]}]}'
    expect(parseExecutionSteps(json, 'TERMINAL_TASK')).not.toBeNull()
  })

  it('preserves the original specialist during plan-feedback regeneration', () => {
    const source = readFileSync(new URL('../../components/AiChat/useChat.ts', import.meta.url), 'utf8')
    expect(source).toContain('generateExecutionPlan(revisedRequest, provider, apiKey, selectedModel, planCtx.topIntent)')
    expect(source).toContain('topIntent: planCtx.topIntent')
  })

  it('has no production planner call that omits topIntent', () => {
    const source = readFileSync(new URL('../../components/AiChat/useChat.ts', import.meta.url), 'utf8')
    const calls = [...source.matchAll(/generateExecutionPlan\(([\s\S]*?)\)/g)].map(match => match[1])
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.includes('topIntent') || call.includes('planCtx.topIntent'))).toBe(true)
  })
})
