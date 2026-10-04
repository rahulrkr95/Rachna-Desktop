// services/agent/tools/webSearchTool.ts
//
// Tool: web_search
//
// General-purpose web search the agent can reach for when it hits an
// unfamiliar API, library, error message, or anything else outside the
// repo and outside its training data. Most useful for: official docs pages,
// migration guides, and "what does this error mean" lookups.
//
// Implementation: queries DuckDuckGo's HTML endpoint (no API key, no
// account, generous rate limits) through the same native HTTP client used
// by curl_request — so it's not subject to webview CORS. The response is
// server-rendered HTML, not JSON, so results are extracted with a small
// regex pass over DuckDuckGo's stable `result__a` / `result__snippet`
// markup rather than pulling in a DOM/HTML-parsing dependency for one tool.
//
// For Stack Overflow specifically, prefer search_stackoverflow — it returns
// structured, scored answers instead of search snippets. For library
// version history, prefer get_package_changelog. Reach for web_search when
// the question is "what is this / how is this normally used" rather than
// "what changed" or "has someone hit this exact error".

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Types ───────────────────────────────────────────────────────────────────

export interface WebSearchArgs {
  /** Search query, e.g. "react-router v7 loader data api" or the exact error text. */
  query: string
  /** Max results to return. Default 5, max 10. */
  maxResults?: number
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResult {
  query: string
  results: WebSearchResultItem[]
}

interface TauriHttpResult {
  status: number
  status_text: string
  headers: Record<string, string>
  body: string
  ok: boolean
  duration_ms: number
  timed_out: boolean
}

// ── HTML extraction ──────────────────────────────────────────────────────────
// DuckDuckGo's HTML (non-JS) endpoint wraps each result in a predictable
// block. We pull title+href from `result__a` anchors and text from the
// following `result__snippet` element. This is intentionally tolerant —
// if DuckDuckGo tweaks markup, we degrade to fewer/zero results rather
// than throwing, and the tool reports that plainly.

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/** DuckDuckGo redirect links look like /l/?uddg=<encoded-real-url>&... */
function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const url = href.startsWith('//') ? `https:${href}` : href
    const parsed = new URL(url, 'https://duckduckgo.com')
    const real = parsed.searchParams.get('uddg')
    return real ? decodeURIComponent(real) : url
  } catch {
    return href
  }
}

function extractResults(html: string, maxResults: number): WebSearchResultItem[] {
  const items: WebSearchResultItem[] = []
  const anchorRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g

  const snippets: string[] = []
  let sMatch: RegExpExecArray | null
  while ((sMatch = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(sMatch[1]))
  }

  let aMatch: RegExpExecArray | null
  let i = 0
  while ((aMatch = anchorRe.exec(html)) !== null && items.length < maxResults) {
    const url = unwrapDuckDuckGoUrl(aMatch[1])
    const title = stripTags(aMatch[2])
    if (title && url) {
      items.push({ title, url, snippet: snippets[i] ?? '' })
    }
    i++
  }
  return items
}

// ── Tool definition ─────────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 5
const HARD_MAX_RESULTS = 10

export const webSearchTool: AgentTool<WebSearchArgs, WebSearchResult> = {
  declaration: {
    name: 'web_search',
    description:
      'Search the public web for documentation, API references, migration guides, or ' +
      'explanations of an error message. Use this whenever you encounter an unfamiliar ' +
      'API, library, framework feature, or error text that is not resolved by reading the ' +
      'repo — do not guess at how an unfamiliar API behaves, look it up. Returns titles, ' +
      'URLs, and snippets, not full page content (use curl_request on a returned URL if you ' +
      'need the full page — especially for time-sensitive facts like prices, versions, ' +
      'availability, or dates, where a snippet alone may be stale or ambiguous). For Stack ' +
      'Overflow Q&A specifically, prefer search_stackoverflow. For "what changed between ' +
      'versions", prefer get_package_changelog. A simple factual or current-information ' +
      'request usually only needs 1-3 calls to this tool — do not repeat the same or a ' +
      'substantially similar query hoping for a different result; reformulate with ' +
      'different terms or a narrower angle instead, or stop once you have enough.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query. Be specific — include the library/API name and version if ' +
            'known, e.g. "zustand v5 persist middleware migration" rather than just "zustand".',
        },
        maxResults: {
          type: 'number',
          description: `Max results to return. Default ${DEFAULT_MAX_RESULTS}, max ${HARD_MAX_RESULTS}.`,
        },
      },
      required: ['query'],
    },
  },

  describeCall: (args) => `Searching the web: "${args.query ?? '…'}"`,

  execute: async (args, _ctx: ToolContext) => {
    const query = (args.query ?? '').trim()
    if (!query) {
      return toolErr('query must not be empty.')
    }

    const rawMax = typeof args.maxResults === 'number' ? args.maxResults : DEFAULT_MAX_RESULTS
    const maxResults = Math.min(Math.max(1, rawMax), HARD_MAX_RESULTS)

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

    let raw: TauriHttpResult
    try {
      raw = await invoke<TauriHttpResult>('run_http_request', {
        args: {
          url,
          method: 'GET',
          headers: {
            // DuckDuckGo's HTML endpoint serves a stripped-down page to
            // generic clients; a browser-like UA keeps results consistent.
            'User-Agent':
              'Mozilla/5.0 (compatible; RachnaAIStudio-Agent/1.0; +https://github.com)',
          },
          timeout_seconds: 20,
        },
      })
    } catch (err) {
      return toolErr(
        `Web search request failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (!raw.ok) {
      return toolErr(
        `Web search returned ${raw.status} ${raw.status_text}. The search backend may be ` +
        'rate-limiting or blocking automated requests; try again with a narrower query.'
      )
    }

    const results = extractResults(raw.body, maxResults)

    return toolOk<WebSearchResult>({ query, results })
  },
}
