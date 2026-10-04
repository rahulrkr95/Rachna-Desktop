import { describe, expect, it } from 'vitest'
import { parsePromptCorrectionResponse, getPromptCorrectionSystemPrompt } from '../agenticClassifier'

// The legacy top-level classifier (CHAT/AUTOMATION/AGENTIC_TASK) has been
// removed — routing is now decided entirely by the specialist chip (see
// store/useSpecialistStore.ts + lib/specialistMapping.ts), with no
// classification API call at all. What's left to test here is the
// correction/clarification and chip-intent confirmation pass.
describe('combined clarification / intent confirmation pass', () => {
  it('parses structured correction and clarification output', () => {
    expect(parsePromptCorrectionResponse('{"correctedText":"Fix login","clarifyingQuestions":["Which account?"],"topIntent":"CODING_TASK"}', 'DESKTOP_TASK')).toMatchObject({
      correctedText: 'Fix login',
      clarifyingQuestions: ['Which account?'],
      topIntent: 'CODING_TASK',
    })
  })

  it('omits empty fields', () => {
    expect(parsePromptCorrectionResponse('{"correctedText":null,"clarifyingQuestions":[]}', 'MCP_TASK')).toEqual({
      rawResponse: '{"correctedText":null,"clarifyingQuestions":[]}',
      topIntent: 'MCP_TASK',
    })
  })

  it('builds one prompt for clarification and conservative intent confirmation', () => {
    const prompt = getPromptCorrectionSystemPrompt('BROWSER_TASK')
    expect(prompt).toContain('Keep topIntent as "BROWSER_TASK"')
    expect(prompt).toContain('clarifying questions ONLY')
  })
})
