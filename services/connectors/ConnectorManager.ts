// services/connectors/ConnectorManager.ts
//
// Central registry + lifecycle manager for all connectors. This is the
// only thing in the app that ever holds a reference to a connector
// instance. Everything else — the AI, the agent tools, Settings UI —
// goes through here (see services/connectors/IntentRouter.ts for the
// AI-facing side).
//
// Flow: AI → Intent Router → Connector Manager → Connector → MCP Server.

import { create } from 'zustand'
import type {
  IConnector,
  ConnectorManifest,
  ConnectorHealth,
  ConnectorTool,
  ConnectorToolResult,
  ConnectorResource,
  ConnectorResourceContent,
  ConnectorPrompt,
} from '../../types/connector'

interface ConnectorManagerState {
  /** Bumped on every registry/health change so React components re-render. */
  revision: number
}

const useConnectorManagerStore = create<ConnectorManagerState>(() => ({ revision: 0 }))

class ConnectorManager {
  private connectors = new Map<string, IConnector>()

  // ── Registration ─────────────────────────────────────────────────────

  /** Adding a new connector: implement IConnector + manifest, then call this once at startup. */
  register(connector: IConnector): void {
    this.connectors.set(connector.manifest.id, connector)
    this.bump()
  }

  unregister(id: string): void {
    const c = this.connectors.get(id)
    if (c?.isConnected()) c.disconnect().catch(() => {})
    this.connectors.delete(id)
    this.bump()
  }

  get(id: string): IConnector | undefined {
    return this.connectors.get(id)
  }

  list(): ConnectorManifest[] {
    return Array.from(this.connectors.values()).map(c => c.manifest)
  }

  // ── Auth ─────────────────────────────────────────────────────────────

  async isAuthenticated(id: string): Promise<boolean> {
    return (await this.connectors.get(id)?.isAuthenticated()) ?? false
  }

  async authenticate(id: string, fields: Record<string, string>): Promise<void> {
    const c = this.requireConnector(id)
    await c.authenticate(fields)
    this.bump()
  }

  async reauthenticate(id: string, fields: Record<string, string>): Promise<void> {
    const c = this.requireConnector(id)
    await c.reauthenticate(fields)
    this.bump()
  }

  async clearAuth(id: string): Promise<void> {
    const c = this.requireConnector(id)
    await c.disconnect().catch(() => {})
    await c.clearAuth()
    this.bump()
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async connect(id: string, projectRoot?: string | null): Promise<void> {
    const c = this.requireConnector(id)
    const withRoot = c as IConnector & { setProjectRoot?: (root: string | null) => void }
    withRoot.setProjectRoot?.(projectRoot ?? null)
    this.bump()
    try {
      await c.connect()
    } finally {
      this.bump()
    }
  }

  async disconnect(id: string): Promise<void> {
    const c = this.requireConnector(id)
    await c.disconnect()
    this.bump()
  }

  // ── Health / capability discovery ───────────────────────────────────

  getHealth(id: string): ConnectorHealth | undefined {
    return this.connectors.get(id)?.getHealth()
  }

  getAllHealth(): Record<string, ConnectorHealth> {
    const out: Record<string, ConnectorHealth> = {}
    for (const [id, c] of this.connectors) out[id] = c.getHealth()
    return out
  }

  isConnected(id: string): boolean {
    return this.connectors.get(id)?.isConnected() ?? false
  }

  // ── Tools / resources / prompts (aggregated, namespaced by connector id) ─

  async listAllTools(): Promise<Array<{ connectorId: string; connectorName: string; tool: ConnectorTool }>> {
    const out: Array<{ connectorId: string; connectorName: string; tool: ConnectorTool }> = []
    for (const c of this.connectors.values()) {
      if (!c.isConnected() || !c.getCapabilities().tools) continue
      const tools = await c.listTools()
      for (const tool of tools) out.push({ connectorId: c.manifest.id, connectorName: c.manifest.name, tool })
    }
    return out
  }

  async executeTool(connectorId: string, toolName: string, args: Record<string, unknown>): Promise<ConnectorToolResult> {
    const c = this.connectors.get(connectorId)
    if (!c) return { ok: false, text: `Unknown connector "${connectorId}"` }
    return c.executeTool(toolName, args)
  }

  async listResources(connectorId: string): Promise<ConnectorResource[]> {
    return this.connectors.get(connectorId)?.listResources() ?? []
  }

  async readResource(connectorId: string, uri: string): Promise<ConnectorResourceContent> {
    const c = this.connectors.get(connectorId)
    if (!c) return { uri, text: '' }
    return c.readResource(uri)
  }

  async listPrompts(connectorId: string): Promise<ConnectorPrompt[]> {
    return this.connectors.get(connectorId)?.listPrompts() ?? []
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private requireConnector(id: string): IConnector {
    const c = this.connectors.get(id)
    if (!c) throw new Error(`Connector "${id}" is not registered`)
    return c
  }

  private bump(): void {
    useConnectorManagerStore.setState(s => ({ revision: s.revision + 1 }))
  }
}

/** Singleton — the app has exactly one Connector Manager. */
export const connectorManager = new ConnectorManager()

/** React hook: re-renders on any registration/connection/health change. */
export function useConnectorManagerRevision(): number {
  return useConnectorManagerStore(s => s.revision)
}
