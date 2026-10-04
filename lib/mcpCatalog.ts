// lib/mcpCatalog.ts
//
// Lightweight keyword → public MCP quickstart mapping, used by the
// MCP_TASK intent (lib/intentClassifier.ts + components/AiChat/useChat.ts)
// to suggest a free, publicly available MCP server for the user's request
// instead of just dropping them into a blank "Add Server" form.
//
// `quickstart` values must match a QUICKSTARTS[].name entry in
// components/McpSettingsPanel.tsx — this is purely a hint for which
// template to pre-select, not a hard dependency. When nothing matches,
// McpSettingsPanel still opens with the full "Add Server" form so the
// user can configure any MCP server, public or private.

interface CatalogEntry {
  /** Must match a QUICKSTARTS[].name in McpSettingsPanel.tsx */
  quickstart: string
  keywords: string[]
  /** Short human-readable label shown in the chat notice. */
  note: string
}

const CATALOG: CatalogEntry[] = [
  {
    quickstart: 'GitHub',
    keywords: ['github', 'pull request', 'pull requests', ' pr ', 'issue', 'issues', 'repo', 'repository'],
    note: 'GitHub (read issues, PRs, repos)',
  },
  {
    quickstart: 'PostgreSQL',
    keywords: ['postgres', 'postgresql', 'sql database', 'database query', 'db query'],
    note: 'PostgreSQL (query a database)',
  },
  {
    quickstart: 'Sentry',
    keywords: ['sentry', 'error tracking', 'crash report', 'exception tracking'],
    note: 'Sentry (read errors and events)',
  },
  {
    quickstart: 'Figma Remote',
    keywords: ['figma', 'design file', 'design mockup'],
    note: 'Figma (read design files & components)',
  },
  {
    quickstart: 'Slack',
    keywords: ['slack', 'channel message', 'slack message'],
    note: 'Slack (search channels and messages)',
  },
  {
    quickstart: 'Notion',
    keywords: ['notion', 'notion page', 'notion database'],
    note: 'Notion (search and update workspaces)',
  },
  {
    quickstart: 'Google Drive',
    keywords: ['google drive', 'drive file', 'google doc'],
    note: 'Google Drive (search and read files)',
  },
  {
    quickstart: 'Gmail',
    keywords: ['gmail', 'email', 'inbox'],
    note: 'Gmail (search, read, and send email)',
  },
  {
    quickstart: 'Google Calendar',
    keywords: ['google calendar', 'calendar event', 'calendar'],
    note: 'Google Calendar (read and manage events)',
  },
  {
    quickstart: 'Filesystem',
    keywords: ['browse local files', 'read files on disk', 'filesystem access'],
    note: 'Filesystem (browse/read local files)',
  },
]

export interface McpSuggestion {
  quickstart: string
  note: string
}

/** Maps a classifier-provided service hint (e.g. "github") straight to a catalog entry. */
const SERVICE_HINT_TO_QUICKSTART: Record<string, string> = {
  github: 'GitHub',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  sql: 'PostgreSQL',
  sentry: 'Sentry',
  figma: 'Figma Remote',
  slack: 'Slack',
  notion: 'Notion',
  'google drive': 'Google Drive',
  gdrive: 'Google Drive',
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  'google calendar': 'Google Calendar',
  filesystem: 'Filesystem',
}

/**
 * Best-effort match against the user's request. `serviceHint` — the
 * `<service>` keyword the intent classifier already extracted in the SAME
 * API call that produced the MCP_TASK tag (see lib/intentClassifier.ts) —
 * is tried first, since it comes from the model actually reading the
 * message rather than a fixed keyword list. Falls back to local keyword
 * matching against `text` when the hint is absent or unrecognized. Returns
 * null when nothing matches — the caller should still open the MCP panel,
 * just without a pre-selected quickstart (the user can add any server,
 * including ones with no entry here, via the "Custom" template).
 */
export function suggestMcpForRequest(text: string, serviceHint?: string): McpSuggestion | null {
  if (serviceHint) {
    const quickstart = SERVICE_HINT_TO_QUICKSTART[serviceHint.toLowerCase()]
    if (quickstart) {
      const entry = CATALOG.find(e => e.quickstart === quickstart)
      if (entry) return { quickstart: entry.quickstart, note: entry.note }
    }
  }

  const lower = ` ${text.toLowerCase()} `
  for (const entry of CATALOG) {
    if (entry.keywords.some(k => lower.includes(k))) {
      return { quickstart: entry.quickstart, note: entry.note }
    }
  }
  return null
}
