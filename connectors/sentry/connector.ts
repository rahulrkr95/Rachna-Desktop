// connectors/sentry/connector.ts

import { BaseMcpStdioConnector } from '../../services/connectors/BaseMcpStdioConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'
import { getSentryCredentials, setSentryCredentials, clearSentryCredentials } from './auth'

export class SentryConnector extends BaseMcpStdioConnector {
  readonly manifest = manifestJson as ConnectorManifest

  async isAuthenticated(): Promise<boolean> {
    const { token, org } = await getSentryCredentials()
    return !!token && !!org
  }

  async authenticate(fields: Record<string, string>): Promise<void> {
    const token = fields.token?.trim()
    const org = fields.org?.trim()
    if (!token) throw new Error('A Sentry auth token is required.')
    if (!org) throw new Error('A Sentry organization slug is required.')
    await setSentryCredentials(token, org)
  }

  async clearAuth(): Promise<void> {
    await clearSentryCredentials()
  }

  protected async resolveAuthEnv(): Promise<Record<string, string>> {
    const { token, org } = await getSentryCredentials()
    if (!token || !org) throw new Error('Sentry is not authenticated.')
    return { SENTRY_AUTH_TOKEN: token, SENTRY_ORG: org }
  }
}
