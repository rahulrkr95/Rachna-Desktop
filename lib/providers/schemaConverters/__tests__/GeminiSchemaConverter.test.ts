// lib/providers/schemaConverters/__tests__/GeminiSchemaConverter.test.ts

import { describe, it, expect } from 'vitest'
import { GeminiSchemaConverter } from '../GeminiSchemaConverter'

describe('GeminiSchemaConverter', () => {
  const converter = new GeminiSchemaConverter()

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
        unevaluatedProperties: false,
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
    })
  })

  it('recurses into nested properties and items, removing additionalProperties at every level', () => {
    const result = converter.convert({
      name: 'bulk_tag',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
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
          nested: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inner: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
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
        },
        nested: {
          type: 'object',
          properties: {
            inner: {
              type: 'object',
            },
          },
        },
      },
    })

    // No additionalProperties should survive anywhere in the tree.
    expect(JSON.stringify(result.parameters)).not.toContain('additionalProperties')
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

  it('resolves a local $ref against $defs, preserving type/properties/required/description', () => {
    const result = converter.convert({
      name: 'create_contact',
      inputSchema: {
        type: 'object',
        $defs: {
          Address: {
            type: 'object',
            description: 'A postal address',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
            },
            required: ['street', 'city'],
          },
        },
        properties: {
          address: { $ref: '#/$defs/Address' },
        },
        required: ['address'],
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          description: 'A postal address',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
          required: ['street', 'city'],
        },
      },
      required: ['address'],
    })

    const serialized = JSON.stringify(result.parameters)
    expect(serialized).not.toContain('$ref')
    expect(serialized).not.toContain('$defs')
  })

  it('resolves nested $refs (a $defs entry that itself contains a $ref)', () => {
    const result = converter.convert({
      name: 'create_order',
      inputSchema: {
        type: 'object',
        $defs: {
          Money: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              currency: { type: 'string' },
            },
          },
          LineItem: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              price: { $ref: '#/$defs/Money' },
            },
          },
        },
        properties: {
          item: { $ref: '#/$defs/LineItem' },
        },
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        item: {
          type: 'object',
          properties: {
            sku: { type: 'string' },
            price: {
              type: 'object',
              properties: {
                amount: { type: 'number' },
                currency: { type: 'string' },
              },
            },
          },
        },
      },
    })
  })

  it('resolves a $ref inside array items', () => {
    const result = converter.convert({
      name: 'bulk_create_contacts',
      inputSchema: {
        type: 'object',
        $defs: {
          Contact: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['name'],
          },
        },
        properties: {
          contacts: {
            type: 'array',
            items: { $ref: '#/$defs/Contact' },
          },
        },
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
    })
  })

  it('resolves $refs inside anyOf branches', () => {
    const result = converter.convert({
      name: 'set_owner',
      inputSchema: {
        type: 'object',
        $defs: {
          Person: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          Team: {
            type: 'object',
            properties: { teamName: { type: 'string' } },
          },
        },
        properties: {
          owner: {
            anyOf: [{ $ref: '#/$defs/Person' }, { $ref: '#/$defs/Team' }],
          },
        },
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        owner: {
          anyOf: [
            { type: 'object', properties: { name: { type: 'string' } } },
            { type: 'object', properties: { teamName: { type: 'string' } } },
          ],
        },
      },
    })
  })

  it('drops additionalProperties nested inside a resolved $ref', () => {
    const result = converter.convert({
      name: 'create_widget',
      inputSchema: {
        type: 'object',
        $defs: {
          Config: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
            },
          },
        },
        properties: {
          config: { $ref: '#/$defs/Config' },
        },
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
          },
        },
      },
    })
  })

  it('leaves schemas with no $ref/$defs entirely untouched aside from unsupported-key stripping', () => {
    const result = converter.convert({
      name: 'ping',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
    })

    expect(result.parameters).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
    })
  })
})
