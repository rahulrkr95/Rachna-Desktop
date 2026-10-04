// lib/providers/schemaConverters/OpenAISchemaConverter.ts
//
// Converts an MCP tool's JSON Schema into an OpenAI-compatible function
// definition (the `{ type: 'function', function: { name, description,
// parameters } }` shape the Chat Completions `tools` field expects).
//
// This is the ONLY place OpenAI-specific schema sanitization should live.
// It shares the MCPTool/ToolSchemaConverter contract in ./types.ts with
// GeminiSchemaConverter and ClaudeSchemaConverter but does not import from
// — or get imported by — either of those (or any future provider
// converter), so changes to one provider's sanitization rules can never
// affect another's.

import type { JSONSchema, MCPTool, ToolSchemaConverter } from './types'

/** The `{ name, description, parameters }` shape nested under OpenAI's `function` tool field. */
export interface OpenAIFunctionDefinition {
  name: string
  description: string
  parameters: unknown
}

/**
 * JSON Schema keywords OpenAI's function-calling `parameters` schema does
 * not support (or are provider-specific to other vendors, e.g. Gemini's
 * `x-google-enum-descriptions`). These describe schema metadata/validation
 * strictness rather than anything the model needs in order to call the
 * tool correctly, so they're safe to drop rather than needing translation.
 */
const OPENAI_UNSUPPORTED_SCHEMA_KEYS = new Set<string>([
  'x-google-enum-descriptions',
  'examples',
  'example',
  'readOnly',
  'writeOnly',
  'contentEncoding',
  'contentMediaType',
  'deprecated',
  '$schema',
  '$id',
  '$defs',
])

export class OpenAISchemaConverter implements ToolSchemaConverter<OpenAIFunctionDefinition> {
  /**
   * Recursively strips OpenAI-unsupported JSON Schema keywords from a
   * schema node, preserving everything OpenAI does understand (type,
   * properties, required, enum, items, description, additionalProperties,
   * etc). MCP schemas can nest through `properties`, `items`,
   * `anyOf`/`oneOf`/`allOf`, and sub-schemas under `additionalProperties`,
   * so this walks the whole tree rather than just the top level.
   */
  sanitizeSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) {
      return schema.map(node => this.sanitizeSchema(node))
    }
    if (schema === null || typeof schema !== 'object') {
      return schema
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (OPENAI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
      out[key] = this.sanitizeSchema(value)
    }
    return out
  }

  /**
   * Converts a single MCP tool into an OpenAI function definition: name and
   * description pass through as-is (any provider-specific naming, e.g.
   * MCP's server-namespacing, is the caller's responsibility — this class
   * only knows about schema conversion), and inputSchema is recursively
   * sanitized into `parameters`.
   */
  convert(tool: MCPTool): OpenAIFunctionDefinition {
    const parameters = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? this.sanitizeSchema(tool.inputSchema)
      : { type: 'object', properties: {} }

    return {
      name: tool.name,
      description: tool.description || tool.name,
      parameters,
    }
  }
}

/** Shared singleton — schema conversion is stateless, no need for callers to instantiate their own. */
export const openAISchemaConverter = new OpenAISchemaConverter()

// Re-exported for convenience so call sites don't need a separate import
// from './types' just to type an MCP tool.
export type { JSONSchema, MCPTool }
