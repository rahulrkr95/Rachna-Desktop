// services/connectors/IntentRouter.ts
//
// AI → Intent Router → Connector Manager → Connector → MCP Server.
//
// The agent never talks to a connector (or to GitHub, Notion, etc.)
// directly. It only ever sees tool declarations named
// "connector__{connectorId}__{toolName}" and calls executeToolCall() with
// that name. This module is the single place that resolves such a name
// back to a connector + tool and forwards the call to the Connector
// Manager — mirroring services/agent/mcpTools.ts's role for raw
// user-added MCP servers, but for the manifest-based connector framework.

import type { ProviderFunctionDeclaration } from '../../lib/providers/types'
import { connectorManager } from './ConnectorManager'
import { geminiSchemaConverter } from '../../lib/providers/schemaConverters/GeminiSchemaConverter'

const PREFIX = 'connector__'

function encodeName(connectorId: string, toolName: string): string {
  const safeId = connectorId.replace(/[^a-zA-Z0-9]/g, '_')
  return `${PREFIX}${safeId}__${toolName}`
}

function decodeName(encoded: string): { connectorId: string; toolName: string } | null {
  if (!encoded.startsWith(PREFIX)) return null
  const rest = encoded.slice(PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep === -1) return null
  return { connectorId: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
}

/** Whether a function-call name belongs to the connector namespace. */
export function isConnectorToolName(name: string): boolean {
  return name.startsWith(PREFIX)
}

/** Tool declarations for every tool exposed by every connected connector. */
export async function getConnectorToolDeclarations(): Promise<ProviderFunctionDeclaration[]> {
  const entries = await connectorManager.listAllTools()
  return entries.map(({ connectorId, connectorName, tool }) => {
    const declaration = geminiSchemaConverter.convert({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })
    return {
      ...declaration,
      name: encodeName(connectorId, tool.name),
      description: `[${connectorName}] ${declaration.description}`,
    }
  })
}

/**
 * Resolves a "connector__{id}__{tool}" function-call name and executes it
 * through the Connector Manager. This is the only entry point the agent
 * loop uses to reach a connector.
 */
export async function executeConnectorToolCall(
  encodedName: string,
  args: Record<string, unknown>
): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
  const decoded = decodeName(encodedName)
  if (!decoded) return { ok: false, error: `Cannot parse connector tool name: "${encodedName}"` }

  if (!connectorManager.isConnected(decoded.connectorId)) {
    return { ok: false, error: `Connector "${decoded.connectorId}" is not connected.` }
  }

  const result = await connectorManager.executeTool(decoded.connectorId, decoded.toolName, args)
  return result.ok ? { ok: true, data: result.text } : { ok: false, error: result.text }
}
