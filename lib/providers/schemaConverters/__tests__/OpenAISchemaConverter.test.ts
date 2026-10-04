// lib/providers/schemaConverters/__tests__/OpenAISchemaConverter.test.ts

import { describe, it, expect } from 'vitest'
import { OpenAISchemaConverter } from '../OpenAISchemaConverter'

describe('OpenAISchemaConverter', () => {
  const converter = new OpenAISchemaConverter()

  it('strips unsupported top-level keys while preserving valid ones', () => {
    const result = converter.convert({
      name: 'search_docs',
      description: 'Search documents',
      inputSchema: {
        type: 'object',
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'https://example.com/schema.json',
        $defs: { Foo: { type: 'string' } },
        deprecated: true,
        'x-google-enum-descriptions': ['a', 'b'],
        examples: [{ query: 'hello' }],
        example: { query: 'hi' },
        readOnly: true,
        writeOnly: false,
        contentEncoding: 'base64',
        contentMediaType: 'application/json',
        properties: {
          query: { type: 'string', description: 'Search text' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    })

    expect(result.name).toBe('search_docs')
    expect(result.description).toBe('Search documents')
    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
      },
      required: ['query'],
      additionalProperties: false,
    })
  })

  it('recurses into nested properties, items, and additionalProperties sub-schemas', () => {
    const result = converter.convert({
      name: 'bulk_tag',
      inputSchema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            deprecated: true,
            items: {
              type: 'string',
              examples: ['urgent'],
              enum: ['urgent', 'low'],
            },
          },
          metadata: {
            type: 'object',
            additionalProperties: {
              type: 'string',
              readOnly: true,
            },
          },
        },
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['urgent', 'low'] },
        },
        metadata: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    })
  })

  it('falls back to an empty object schema when inputSchema is missing', () => {
    const result = converter.convert({ name: 'no_args_tool' })
    expect(result.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('falls back to the tool name when description is missing', () => {
    const result = converter.convert({ name: 'ping', inputSchema: { type: 'object' } })
    expect(result.description).toBe('ping')
  })

  it('handles arrays of sub-schemas (anyOf/oneOf/allOf) recursively', () => {
    const result = converter.convert({
      name: 'union_tool',
      inputSchema: {
        type: 'object',
        properties: {
          value: {
            anyOf: [
              { type: 'string', deprecated: true },
              { type: 'number', examples: [1, 2] },
            ],
          },
        },
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
    })
  })
})
