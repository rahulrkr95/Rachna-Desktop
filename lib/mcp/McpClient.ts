// lib/mcp/McpClient.ts
//
// Thin wrapper around the Rust-side MCP client commands
// (see src-tauri/src/mcp.rs). Mirrors lib/tauriFs.ts / lib/keychain.ts in
// shape — no business logic here, just typed invoke() calls. The MCP
// server config (which servers exist, their command/args/env, whether
// they're enabled) lives in store/useMcpStore.ts.

import { invoke } from '@tauri-apps/api/core'

/** Mirrors the Rust `McpTool` struct (camelCase via serde rename). */
export interface McpToolInfo {
  name: string
  description: string
  inputSchema: {
    type: string
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

export interface McpConnectArgs {
  serverId: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** Remote MCP server URL (Streamable HTTP). If set, stdio fields are ignored. */
  url?: string
  /**
   * Bearer token sent as `Authorization: Bearer <authToken>` for remote
   * (`url`-based) servers only — e.g. a valid OAuth access token resolved
   * by services/oauth/OAuthManager.ts. Ignored for stdio servers. Callers
   * are responsible for making sure the token isn't expired (OAuthManager
   * refreshes before returning one) — this layer just forwards it.
   */
  authToken?: string
}

/** Mirrors the Rust `Resource` struct from rmcp (camelCase via serde). */
export interface McpResourceInfo {
  uri: string
  name: string
  description?: string
  mimeType?: string
  [key: string]: unknown
}

/** Mirrors the Rust `Prompt` struct from rmcp (camelCase via serde). */
export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
  [key: string]: unknown
}

/**
 * Connects to an MCP server — spawning it as a local process over stdio, or
 * dialing it over Streamable HTTP when `url` is set — and returns its
 * advertised tools. The official rmcp SDK handles the `initialize`
 * handshake, transport, and protocol negotiation. Throws on spawn/dial
 * failure or a handshake error.
 */
export async function mcpConnect(opts: McpConnectArgs): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>('mcp_connect', {
    serverId: opts.serverId,
    command: opts.command,
    args: opts.args,
    env: opts.env,
    cwd: opts.cwd ?? null,
    url: opts.url ?? null,
    authToken: opts.authToken ?? null,
  })
}

/** Re-fetches the tool list for an already-connected server. */
export async function mcpListTools(serverId: string): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>('mcp_list_tools', { serverId })
}

/**
 * Calls a tool on an already-connected server.
 * Returns the raw MCP `tools/call` result — typically
 * `{ content: Array<{ type: 'text'; text: string } | ...>, isError?: boolean }`.
 */
export async function mcpCallTool(
  serverId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ content?: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean }> {
  return invoke('mcp_call_tool', { serverId, name, arguments: args })
}

/** Re-fetches the resource list for an already-connected server. */
export async function mcpListResources(serverId: string): Promise<McpResourceInfo[]> {
  return invoke<McpResourceInfo[]>('mcp_list_resources', { serverId })
}

/** Reads a resource by URI from an already-connected server. */
export async function mcpReadResource(
  serverId: string,
  uri: string
): Promise<{ contents?: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }> {
  return invoke('mcp_read_resource', { serverId, uri })
}

/** Re-fetches the prompt list for an already-connected server. */
export async function mcpListPrompts(serverId: string): Promise<McpPromptInfo[]> {
  return invoke<McpPromptInfo[]>('mcp_list_prompts', { serverId })
}

/** Kills the server process (or closes the remote connection) and drops the session. */
export async function mcpDisconnect(serverId: string): Promise<void> {
  return invoke<void>('mcp_disconnect', { serverId })
}


/**
 * Flattens an MCP `tools/call` result into a single string suitable for
 * feeding back to the model as a tool result. MCP responses are a list of
 * content blocks (text, image, resource); we surface text blocks verbatim
 * and summarise anything else, since the agent's ToolResult is plain JSON.
 */
export function flattenMcpResult(result: { content?: Array<{ type: string; text?: string }> ; isError?: boolean }): string {
  const blocks = result.content ?? []
  if (blocks.length === 0) return result.isError ? 'Tool returned an error with no content.' : '(empty result)'

  return blocks
    .map(block => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return `[${block.type} content omitted]`
    })
    .join('\n')
}
