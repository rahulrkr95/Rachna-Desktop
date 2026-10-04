// services/agent/mcpTools.ts
//
// Bridges the MCP client (store/useMcpStore.ts) to the agent's ToolRegistry.
//
// For every tool advertised by a connected MCP server we create a dynamic
// AgentTool. This avoids hardcoding MCP tool names — the set is discovered
// at runtime from the server's `tools/list` response.
//
// Because ToolRegistry is a static map populated at module load time, we
// expose two functions that the agent loop calls:
//
//   getMcpToolDeclarations() — all tools from connected servers as
//     ProviderFunctionDeclaration[], to be merged into the per-turn tool list
//     that's sent to the AI provider. Called on every agent turn so that newly
//     connected servers' tools are reflected immediately.
//
//   executeMcpTool(name, args, serverId?) — executes the tool on the correct
//     server, extracting text content from the MCP result.
//
//   getMcpToolsSection() — a "## MCP Tools" system-prompt block that tells
//     the model what servers and tools are currently available, mirroring the
//     static tool list in prompts.ts::SYSTEM_PROMPT.

import type { ProviderFunctionDeclaration } from '../../lib/providers/types'
import type { ToolResult } from './types'
import { mcpCallTool, flattenMcpResult } from '../../lib/mcp/McpClient'
import { useMcpStore } from '../../store/useMcpStore'
import { suggestMcpForRequest } from '../../lib/mcpCatalog'
import { geminiSchemaConverter } from '../../lib/providers/schemaConverters/GeminiSchemaConverter'

// ── Tool name encoding ────────────────────────────────────────────────────
//
// MCP tool names can conflict across servers ("query" from Postgres vs
// "query" from Sentry). We namespace them as "mcp_{serverId}_{name}" in the
// tool declaration name so the AI can call the right server, and we expose
// a helper to parse that namespace back out at execution time.

function encodeName(serverId: string, toolName: string): string {
  // Replace non-alphanumeric chars in serverId with _ to keep the function
  // declaration name valid for all AI provider schemas.
  const safeId = serverId.replace(/[^a-zA-Z0-9]/g, '_')
  return `mcp__${safeId}__${toolName}`
}

interface DecodedMcpTool {
  serverId: string
  toolName: string
}

function decodeName(encodedName: string): DecodedMcpTool | null {
  if (!encodedName.startsWith('mcp__')) return null
  const rest = encodedName.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep === -1) return null
  // Reverse the safeId substitution — we stored original serverId in the
  // useMcpStore, so we match by the safeId-encoded form against encoded names.
  const safeId = rest.slice(0, sep)
  const toolName = rest.slice(sep + 2)
  return { serverId: safeId, toolName }
}

// ── getMcpToolDeclarations ────────────────────────────────────────────────
//
// Schema sanitization (stripping JSON Schema keywords the target AI
// provider's function-calling API doesn't support) is NOT done here — it's
// delegated to a per-provider converter in lib/providers/schemaConverters/.
// This is the single point where a discovered MCP tool becomes a
// ProviderFunctionDeclaration; the app currently only calls Gemini, so it
// goes through GeminiSchemaConverter, but a future multi-provider setup can
// swap in the right converter here without touching MCP tool discovery
// (above) or execution (below) at all.

/**
 * Returns ProviderFunctionDeclarations for all tools from all currently
 * connected MCP servers. Merged into the tool list the agent loop sends to
 * the AI provider on every turn.
 */
export function getMcpToolDeclarations(): ProviderFunctionDeclaration[] {
  const connectedTools = useMcpStore.getState().getConnectedTools()
  return connectedTools.map(({ serverId, serverName, tool }) => {
    const declaration = geminiSchemaConverter.convert({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })
    return {
      ...declaration,
      name: encodeName(serverId, tool.name),
      description: `[MCP: ${serverName}] ${declaration.description}`,
    }
  })
}

/**
 * Finds connected servers that are relevant to a planned MCP step.  A
 * catalog match (for example, a Drive task) is deliberately preferred over
 * the mere existence of an unrelated connected server.
 */
export function getRelevantConnectedMcpServers(task: string): string[] {
  const { servers, runtime } = useMcpStore.getState()
  const connected = servers.filter(server => runtime[server.id]?.status === 'connected')
  if (connected.length === 0) return []

  const suggestion = suggestMcpForRequest(task)
  const normalizedSuggestion = suggestion?.quickstart.toLowerCase()
  if (normalizedSuggestion) {
    return connected
      .filter(server => {
        const name = server.name.toLowerCase()
        return name.includes(normalizedSuggestion) || normalizedSuggestion.includes(name)
      })
      .map(server => server.id)
  }

  const words = task.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  const matched = connected.filter(server => {
    const rt = runtime[server.id]
    const searchable = [server.name, ...rt.tools.flatMap(tool => [tool.name, tool.description ?? ''])]
      .join(' ')
      .toLowerCase()
    return words.some(word => searchable.includes(word))
  })
  // For an uncatalogued service, one connected server is an unambiguous
  // fallback; multiple unrelated servers require an actual metadata match.
  return (matched.length > 0 ? matched : connected.length === 1 ? connected : []).map(server => server.id)
}

/**
 * Finds enabled server configurations that could handle a task, regardless
 * of whether their process/session has been started yet. This supports lazy
 * MCP startup without treating a configured server as missing.
 */
export function getRelevantConfiguredMcpServers(task: string): string[] {
  const { servers } = useMcpStore.getState()
  const enabled = servers.filter(server => server.enabled)
  if (enabled.length === 0) return []

  const suggestion = suggestMcpForRequest(task)
  const normalizedSuggestion = suggestion?.quickstart.toLowerCase()
  if (normalizedSuggestion) {
    return enabled
      .filter(server => {
        const name = server.name.toLowerCase()
        return name.includes(normalizedSuggestion) || normalizedSuggestion.includes(name)
      })
      .map(server => server.id)
  }

  const words = task.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  const matched = enabled.filter(server => {
    const searchable = [server.name, server.command, server.url ?? '', ...server.args]
      .join(' ')
      .toLowerCase()
    return words.some(word => searchable.includes(word))
  })
  return (matched.length > 0 ? matched : enabled.length === 1 ? enabled : []).map(server => server.id)
}

// ── executeMcpTool ────────────────────────────────────────────────────────

/**
 * Executes an MCP tool call by name (using the mcp__{safeId}__{toolName}
 * encoding). Called by AgentLoop when it recognises an mcp__* function call.
 */
export async function executeMcpTool(
  encodedName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const decoded = decodeName(encodedName)
  if (!decoded) {
    return { ok: false, error: `Cannot parse MCP tool name: "${encodedName}"` }
  }

  // Resolve the original serverId from the store (safeId may have replaced
  // non-alphanumeric chars, so we match by safeId encoding).
  const { servers, runtime } = useMcpStore.getState()
  const server = servers.find(s => {
    const safe = s.id.replace(/[^a-zA-Z0-9]/g, '_')
    return safe === decoded.serverId
  })

  if (!server) {
    return { ok: false, error: `MCP server "${decoded.serverId}" not found` }
  }
  const rt = runtime[server.id]
  if (!rt || rt.status !== 'connected') {
    return { ok: false, error: `MCP server "${server.name}" is not connected` }
  }

  try {
    const result = await mcpCallTool(server.id, decoded.toolName, args)
    if (result.isError) {
      const errorText = flattenMcpResult(result)
      return { ok: false, error: `MCP tool returned an error: ${errorText}` }
    }
    const text = flattenMcpResult(result)
    return { ok: true, data: text }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `MCP tool "${decoded.toolName}" failed`,
    }
  }
}

// ── getMcpToolsSection ────────────────────────────────────────────────────

/**
 * Returns a "## MCP Tools" system-prompt section describing all currently
 * connected servers and their tools, so the model knows they exist and when
 * to call them. Returns null when no servers are connected (avoids polluting
 * the prompt with an empty section).
 */
export function getMcpToolsSection(): string | null {
  const connectedTools = useMcpStore.getState().getConnectedTools()
  if (connectedTools.length === 0) return null

  // Group by server for readability
  const byServer: Record<string, typeof connectedTools> = {}
  for (const entry of connectedTools) {
    if (!byServer[entry.serverId]) byServer[entry.serverId] = []
    byServer[entry.serverId].push(entry)
  }

  const lines: string[] = [
    '## MCP Tools',
    'In addition to your built-in tools, the following MCP servers are',
    'currently connected. Each tool is available as a function call using',
    'the name shown. Call them exactly like built-in tools.',
    '',
  ]

  for (const entries of Object.values(byServer)) {
    const serverName = entries[0].serverName
    lines.push(`### ${serverName}`)
    for (const { tool, serverId } of entries) {
      const encodedName = encodeName(serverId, tool.name)
      lines.push(`- \`${encodedName}\`: ${tool.description || '(no description)'}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

/** Whether a given tool name belongs to the MCP namespace. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}
