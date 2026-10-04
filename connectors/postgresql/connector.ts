// connectors/postgresql/connector.ts

import { BaseMcpStdioConnector } from '../../services/connectors/BaseMcpStdioConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'
import {
  getPostgresConnectionString,
  setPostgresConnectionString,
  clearPostgresConnectionString,
} from './auth'

export class PostgreSQLConnector extends BaseMcpStdioConnector {
  readonly manifest = manifestJson as ConnectorManifest

  async isAuthenticated(): Promise<boolean> {
    const value = await getPostgresConnectionString()
    return !!value
  }

  async authenticate(fields: Record<string, string>): Promise<void> {
    const connectionString = fields.connectionString?.trim()
    if (!connectionString) throw new Error('A connection string is required.')
    await setPostgresConnectionString(connectionString)
  }

  async clearAuth(): Promise<void> {
    await clearPostgresConnectionString()
  }

  protected async resolveAuthEnv(): Promise<Record<string, string>> {
    const connectionString = await getPostgresConnectionString()
    if (!connectionString) throw new Error('PostgreSQL is not authenticated.')
    return { POSTGRES_CONNECTION_STRING: connectionString }
  }
}
