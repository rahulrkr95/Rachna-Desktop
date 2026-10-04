// lib/providers/schemaConverters/GeminiSchemaConverter.ts
//
// Converts an MCP tool's JSON Schema into a Gemini-compatible
// FunctionDeclaration. Gemini's function-calling schema is a strict OpenAPI
// subset: it 400s outright on a handful of JSON Schema keywords that MCP
// servers commonly emit (e.g. via zod's toJSONSchema()/zod-to-json-schema).
//
// This is the ONLY place Gemini-specific schema sanitization should live.
// Other providers (OpenAI, Claude, ...) get their own converter file in this
// folder implementing ToolSchemaConverter<TDeclaration> — none of them
// import from here, and this file never imports from them, so adding or
// changing a provider's converter can't affect Gemini's.

import type { ProviderFunctionDeclaration } from '../types'
import type { JSONSchema, MCPTool, ToolSchemaConverter } from './types'

/** Alias for readability at call sites / per the spec's naming. */
export type GeminiFunctionDeclaration = ProviderFunctionDeclaration

/**
 * JSON Schema keywords Gemini's function-calling schema does not support.
 * These describe schema metadata/validation strictness rather than anything
 * the model needs in order to call the tool correctly, so they're safe to
 * drop rather than needing to be translated.
 *
 * `additionalProperties` is included here: Gemini's function-calling schema
 * rejects it outright (whether boolean or a sub-schema), so it must be
 * stripped at every level, not just the top one.
 *
 * `$ref` is included as a safety net — by the time sanitizeSchema() runs,
 * resolveRefs() should already have replaced every resolvable `$ref` with
 * its target's contents. Any `$ref` key that somehow survives (e.g. it
 * pointed outside `#/$defs/...` and couldn't be resolved) is dropped here
 * rather than being sent to Gemini, which doesn't understand JSON Schema
 * references.
 */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set<string>([
  'deprecated',
  'x-google-enum-descriptions',
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'examples',
  'example',
  'readOnly',
  'writeOnly',
  'contentEncoding',
  'contentMediaType',
  'unevaluatedProperties',
  'additionalProperties',
])

/** Matches a local `$ref` of the form `#/$defs/SomeName`. */
const LOCAL_DEFS_REF_PATTERN = /^#\/\$defs\/(.+)$/

export class GeminiSchemaConverter implements ToolSchemaConverter<GeminiFunctionDeclaration> {
  /**
   * Recursively resolves local `$ref` pointers (e.g. `#/$defs/Address`)
   * against the top-level `$defs` map, replacing each `$ref` node with the
   * referenced schema's contents. Runs *before* sanitizeSchema() so that
   * `$defs` is still available to resolve against — sanitizeSchema() strips
   * `$defs` (and any leftover `$ref`) afterwards.
   *
   * Handles refs nested anywhere in the tree (inside `properties`, array
   * `items`, `anyOf`/`oneOf`/`allOf`, etc), and refs-to-refs (a `$defs`
   * entry that itself contains a `$ref`), guarding against circular
   * references via `seen`.
   *
   * Per spec, only `type`, `properties`, `required`, `items`, `enum`, and
   * `description` are guaranteed to come through from the referenced
   * schema — but since this runs before sanitizeSchema(), any other valid
   * keys on the referenced schema are preserved too and simply pass through
   * sanitization normally. Sibling keys alongside `$ref` on the referencing
   * node (uncommon, but valid JSON Schema) take precedence over the
   * resolved schema's keys.
   */
  resolveRefs(schema: unknown, defs: Record<string, unknown>, seen: ReadonlySet<string> = new Set()): unknown {
    if (Array.isArray(schema)) {
      return schema.map(node => this.resolveRefs(node, defs, seen))
    }
    if (schema === null || typeof schema !== 'object') {
      return schema
    }

    const node = schema as Record<string, unknown>

    if (typeof node.$ref === 'string') {
      const match = LOCAL_DEFS_REF_PATTERN.exec(node.$ref)
      const defName = match?.[1]
      const { $ref: _drop, ...siblingKeys } = node

      if (!defName || !Object.prototype.hasOwnProperty.call(defs, defName) || seen.has(defName)) {
        // Unresolvable (not a local #/$defs/... ref) or circular: drop the
        // $ref itself — sanitizeSchema() would strip it anyway — and keep
        // resolving whatever sibling keys are present.
        return this.resolveRefs(siblingKeys, defs, seen)
      }

      const nextSeen = new Set(seen)
      nextSeen.add(defName)
      const resolvedTarget = this.resolveRefs(defs[defName], defs, nextSeen) as Record<string, unknown>
      const resolvedSiblings = this.resolveRefs(siblingKeys, defs, seen) as Record<string, unknown>

      return { ...resolvedTarget, ...resolvedSiblings }
    }

    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] = this.resolveRefs(value, defs, seen)
    }
    return out
  }

  /**
   * Recursively strips Gemini-unsupported JSON Schema keywords from a
   * schema node, preserving everything Gemini does understand (type,
   * properties, required, enum, items, description, etc). MCP schemas can
   * nest through `properties`, `items`, `anyOf`/`oneOf`/`allOf`, so this
   * walks the whole tree rather than just the top level.
   *
   * Assumes `$ref`s have already been resolved via resolveRefs() — this
   * step only removes keys, it doesn't understand references.
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
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
      out[key] = this.sanitizeSchema(value)
    }
    return out
  }

  /**
   * Converts a single MCP tool into a Gemini FunctionDeclaration: the name
   * and description pass through as-is (any provider-specific naming, e.g.
   * MCP's server-namespacing, is the caller's responsibility — this class
   * only knows about schema conversion), and inputSchema has its `$ref`s
   * resolved against `$defs` and is then recursively sanitized into
   * `parameters`.
   */
  convert(tool: MCPTool): GeminiFunctionDeclaration {
    let parameters: GeminiFunctionDeclaration['parameters'] = { type: 'object', properties: {} } as GeminiFunctionDeclaration['parameters']

    if (tool.inputSchema && typeof tool.inputSchema === 'object') {
      const defs = (tool.inputSchema as Record<string, unknown>).$defs
      const defsMap = defs && typeof defs === 'object' ? (defs as Record<string, unknown>) : {}
      const resolved = this.resolveRefs(tool.inputSchema, defsMap)
      parameters = this.sanitizeSchema(resolved) as GeminiFunctionDeclaration['parameters']
    }

    return {
      name: tool.name,
      description: tool.description || tool.name,
      parameters,
    }
  }
}

/** Shared singleton — schema conversion is stateless, no need for callers to instantiate their own. */
export const geminiSchemaConverter = new GeminiSchemaConverter()

// Re-exported for convenience so call sites don't need a separate import
// from './types' just to type an MCP tool.
export type { JSONSchema, MCPTool }
