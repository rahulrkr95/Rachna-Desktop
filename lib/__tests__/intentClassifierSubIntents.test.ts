import { describe, expect, it } from 'vitest'
import {
  INTENT_DEFINITIONS,
  parseIntent,
  parseDesktopTaskCategory,
  parseBrowserTaskSubIntent,
} from '../intentClassifier'

describe('input_control intent taxonomy', () => {
  it('limits headless browser tasks to research', () => {
    expect(INTENT_DEFINITIONS).toContain('BROWSER_TASK:<research|automation>')
    expect(parseIntent('BROWSER_TASK:research')).toBe('browser_task')
    expect(parseBrowserTaskSubIntent('BROWSER_TASK:input_control')).toBeUndefined()
  })

  it('declares and parses input_control only as a desktop-task sub-intent', () => {
    expect(INTENT_DEFINITIONS).toContain('DESKTOP_TASK:<files|apps|research|input_control>')
    expect(INTENT_DEFINITIONS).toContain('DESIGN_TASK:<code_generation>')
    expect(parseDesktopTaskCategory('DESKTOP_TASK:input_control')).toBe('input_control')
    expect(INTENT_DEFINITIONS).toContain('SOFTWARE:WORK_WITH_REPO:<code_research|code_changes|run_project>')
    expect(INTENT_DEFINITIONS).toContain('including its normal build/run and verification lifecycle')
    expect(INTENT_DEFINITIONS).toContain('must never be added after SOFTWARE:NEW_PROJECT')
    expect(parseIntent('SOFTWARE:WORK_WITH_REPO:code_changes')).toBe('work_with_repo')
    expect(parseIntent('CODING_TASK:WORK_WITH_REPO:code_changes')).toBe('work_with_repo')
    expect(INTENT_DEFINITIONS).not.toContain('CODING_TASK:RUN_PROJECT:input_control')
  })
})
