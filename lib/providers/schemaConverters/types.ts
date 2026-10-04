// lib/providers/schemaConverters/types.ts
//
// Shared, provider-agnostic types for converting an MCP tool's JSON Schema
// into whatever shape a given AI provider's function-calling API expects.
//
// Each provider that needs schema massaging (Gemini today; OpenAI, Claude,
// etc. potentially later) gets its own converter file in this folder that
// implements ToolSchemaConverter<TDeclaration>. Keeping the interface here
// — rather than on GeminiSchemaConverter itself — means adding a new
// provider never requires touching the Gemini converter, and callers can
// depend on the interface instead of a concrete class.

/** A JSON Schema node, as emitted by MCP servers (e.g. via zod-to-json-schema). */
export interface JSONSchema {
  type?: string
  // Typed loosely (rather than Record<string, JSONSchema>) so this matches
  // the inputSchema shape MCP servers/connectors actually hand us — see
  // McpToolInfo (lib/mcp/McpClient.ts) and ConnectorTool
  // (types/connector.ts) — without requiring a cast at every call site.
  // GeminiSchemaConverter.sanitizeSchema() still recurses into these
  // structurally at runtime regardless of the declared type.
  properties?: Record<string, unknown>
  required?: string[]
  items?: unknown
  enum?: unknown[]
  description?: string
  additionalProperties?: boolean | unknown
  anyOf?: unknown[]
  oneOf?: unknown[]
  allOf?: unknown[]
  [key: string]: unknown
}

/**
 * Minimal shape of an MCP tool that schema converters need. Deliberately
 * decoupled from lib/mcp/McpClient.ts's McpToolInfo (and the analogous
 * ConnectorTool in types/connector.ts) so this folder has no dependency on
 * MCP transport/connector code — it only needs name/description/inputSchema.
 */
export interface MCPTool {
  name: string
  description?: string
  inputSchema?: JSONSchema
}

/**
 * A provider-agnostic contract: given an MCP tool, produce whatever
 * function-declaration shape that provider's API expects. Implementations
 * live alongside this file, one per provider.
 */
export interface ToolSchemaConverter<TDeclaration> {
  convert(tool: MCPTool): TDeclaration
}
