// lib/providers/schemaConverters/ClaudeSchemaConverter.ts
//
// Converts an MCP tool's JSON Schema into an Anthropic-compatible tool
// definition (the `{ name, description, input_schema }` shape the Claude
// Messages API's `tools` field expects).
//
// This is the ONLY place Claude-specific schema sanitization should live.
// It shares the MCPTool/ToolSchemaConverter contract in ./types.ts with
// GeminiSchemaConverter but does not import from — or get imported by —
// that file (or any future OpenAISchemaConverter etc.), so changes to one
// provider's sanitization rules can never affect another's.

import type { JSONSchema, MCPTool, ToolSchemaConverter } from './types'

/** The `{ name, description, input_schema }` shape Anthropic's `tools` API field expects. */
export interface ClaudeToolDefinition {
  name: string
  description: string
  input_schema: unknown
}

/**
 * JSON Schema keywords Anthropic's tool `input_schema` does not support (or
 * are provider-specific to other vendors, e.g. Gemini's
 * `x-google-enum-descriptions`). These describe schema metadata/validation
 * strictness rather than anything Claude needs in order to call the tool
 * correctly, so they're safe to drop rather than needing translation.
 */
const CLAUDE_UNSUPPORTED_SCHEMA_KEYS = new Set<string>([
  'x-google-enum-descriptions',
  'deprecated',
  '$schema',
  '$id',
  '$defs',
  'examples',
  'example',
  'readOnly',
  'writeOnly',
  'contentEncoding',
  'contentMediaType',
])

export class ClaudeSchemaConverter implements ToolSchemaConverter<ClaudeToolDefinition> {
  /**
   * Recursively strips Claude-unsupported JSON Schema keywords from a
   * schema node, preserving everything Claude does understand (type,
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
      if (CLAUDE_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
      out[key] = this.sanitizeSchema(value)
    }
    return out
  }

  /**
   * Converts a single MCP tool into a Claude tool definition: name and
   * description pass through as-is (any provider-specific naming, e.g.
   * MCP's server-namespacing, is the caller's responsibility — this class
   * only knows about schema conversion), and inputSchema is recursively
   * sanitized into `input_schema`.
   */
  convert(tool: MCPTool): ClaudeToolDefinition {
    const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? this.sanitizeSchema(tool.inputSchema)
      : { type: 'object', properties: {} }

    return {
      name: tool.name,
      description: tool.description || tool.name,
      input_schema: inputSchema,
    }
  }
}

/** Shared singleton — schema conversion is stateless, no need for callers to instantiate their own. */
export const claudeSchemaConverter = new ClaudeSchemaConverter()

// Re-exported for convenience so call sites don't need a separate import
// from './types' just to type an MCP tool.
export type { JSONSchema, MCPTool }
