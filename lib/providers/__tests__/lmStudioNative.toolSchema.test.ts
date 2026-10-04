// lib/providers/__tests__/lmStudioNative.toolSchema.test.ts

import { describe, it, expect } from 'vitest'
import { buildToolProtocolInstructions } from '../lmStudioNative'
import type { ProviderFunctionDeclaration } from '../types'

describe('LM Studio native — tool schema embedded in prompt', () => {
  it('strips unsupported JSON Schema keywords before embedding parameters in the prompt', () => {
    const tools: ProviderFunctionDeclaration[] = [
      {
        name: 'search_docs',
        description: 'Search documents',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text' },
          },
          required: ['query'],
          // Unsupported keys that should be stripped:
          // (cast via `as any`-equivalent since ProviderFunctionDeclaration's
          // parameters type doesn't declare these — MCP schemas commonly
          // include them anyway, hence the sanitizer.)
          ...( {
            $schema: 'http://json-schema.org/draft-07/schema#',
            deprecated: true,
            examples: [{ query: 'hi' }],
          } as Record<string, unknown> ),
        } as ProviderFunctionDeclaration['parameters'],
      },
    ]

    const prompt = buildToolProtocolInstructions(tools)

    expect(prompt).toContain('search_docs')
    expect(prompt).not.toContain('$schema')
    expect(prompt).not.toContain('deprecated')
    expect(prompt).not.toContain('examples')

    // The embedded JSON Schema itself should still carry supported fields.
    const match = prompt.match(/parameters \(JSON Schema\): (\{.*\})/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![1])
    expect(parsed).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
      },
      required: ['query'],
    })
  })

  it('returns an empty string when there are no tools', () => {
    expect(buildToolProtocolInstructions([])).toBe('')
  })
})
