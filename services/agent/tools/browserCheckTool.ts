// services/agent/tools/browserCheckTool.ts
//
// Tool: browser_check
//
// Lets the agent open a real browser (Chromium via Playwright, run as a
// Node sidecar — see lib/browser-tool/run.js), navigate to a URL (typically
// the user's localhost dev server), take a screenshot, and read back
// console errors and failed network requests. This is what lets the agent
// actually CONFIRM a frontend change rendered/worked instead of just
// inferring it from source code.
//
// Playwright runs headlessly for diagnostics, then publishes its URL, title,
// errors, and capture into the persistent browser panel. The agent and user
// therefore share an in-IDE browser surface without a focus-stealing native
// Chromium window.
//
// Goes through the Rust `run_browser_check` Tauri command, which spawns
// `node lib/browser-tool/run.js` the same way `scan_repo` spawns the repo
// scanner CLI. If Playwright itself can't launch (not installed, missing
// system deps, etc.), this tool falls back to opening the URL in the OS
// Failure is reported in-place rather than falling back to an external OS
// browser, preserving the promise that browser work stays inside the IDE.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'
import { useBrowserStore } from '../../../store/useBrowserStore'

// ── Types ───────────────────────────────────────────────────────────────────

export interface BrowserCheckArgs {
  /** Full URL to navigate to, e.g. "http://localhost:5173" or "http://localhost:5173/settings". */
  url: string
  /**
   * Extra milliseconds to wait after the page finishes loading, to let
   * client-side rendering / async data settle before the screenshot is
   * taken. Default 1000, max 15000.
   */
  waitMs?: number
  /** Capture the full scrollable page instead of just the viewport. Default false. */
  fullPage?: boolean
  /** If set, wait for this CSS selector to appear before screenshotting. */
  selector?: string
  /** Viewport width in px. Default 1280. */
  width?: number
  /** Viewport height in px. Default 800. */
  height?: number
  /** Navigation timeout in ms. Default 30000, max 60000. */
  timeoutMs?: number
  /**
   * Leave the visible Chromium window open after the check completes,
   * instead of closing it automatically. Default false. Useful when the
   * agent wants the user to keep looking at what it just verified.
   */
  keepOpen?: boolean
}

export interface ConsoleMessage {
  type: string
  text: string
  location?: string
}

export interface FailedRequest {
  url: string
  method: string
  failure: string
}

export interface HttpErrorResponse {
  url: string
  status: number
  statusText: string
}

export interface BrowserCheckResult {
  url: string
  finalUrl: string
  title: string
  status: number | null
  navError?: string
  /** Base64-encoded PNG screenshot. Render as `data:image/png;base64,${screenshotBase64}`. */
  screenshotBase64: string | null
  consoleMessages: ConsoleMessage[]
  pageErrors: string[]
  failedRequests: FailedRequest[]
  httpErrors: HttpErrorResponse[]
  durationMs: number
  /** Convenience flag: true if there were any console errors, page errors, failed requests, or HTTP 4xx/5xx. */
  hasErrors: boolean
  /**
   * True when Playwright couldn't launch and this instead opened the URL
   * in the OS default desktop browser as a fallback. No screenshot or
   * console/network diagnostics are available for that run.
   */
  usedFallbackBrowser: boolean
  /** Human-readable note explaining what happened, set only in fallback mode. */
  note?: string
}

interface TauriBrowserCheckResult {
  ok: boolean
  error?: string
  url?: string
  finalUrl?: string
  title?: string
  status?: number | null
  navError?: string
  screenshotBase64?: string | null
  consoleMessages?: ConsoleMessage[]
  pageErrors?: string[]
  failedRequests?: FailedRequest[]
  httpErrors?: HttpErrorResponse[]
  durationMs?: number
}

// ── Tool definition ─────────────────────────────────────────────────────────

export const browserCheckTool: AgentTool<BrowserCheckArgs, BrowserCheckResult> = {
  declaration: {
    name: 'browser_check',
    description:
      'Open the embedded IDE browser and navigate to a URL — typically the user\'s running localhost dev ' +
      'server, e.g. "http://localhost:5173" — take a screenshot, and report back ' +
      'browser console messages (including errors), uncaught page exceptions, failed ' +
      'network requests, and HTTP error responses (4xx/5xx). The browser session appears ' +
      'as a persistent tab inside Rachna AI Studio; it never opens an external window. ' +
      'Use this AFTER making a frontend code change and the dev server is running, to ' +
      'actually confirm the change rendered correctly and the page works, rather than ' +
      'assuming from source code alone. You can optionally wait for a specific CSS ' +
      'selector to appear before capturing, useful for confirming a particular component ' +
      'mounted. Requires the dev server to already be running — this tool does not start one.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Full URL to load, e.g. "http://localhost:5173" or "http://localhost:5173/settings".',
        },
        waitMs: {
          type: 'number',
          description:
            'Extra milliseconds to wait after load completes, to let client-side rendering ' +
            'settle before the screenshot. Default 1000, max 15000.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of just the viewport. Default false.',
        },
        selector: {
          type: 'string',
          description:
            'Optional CSS selector to wait for before capturing — useful for confirming a ' +
            'specific component actually mounted.',
        },
        width: { type: 'number', description: 'Viewport width in px. Default 1280.' },
        height: { type: 'number', description: 'Viewport height in px. Default 800.' },
        timeoutMs: { type: 'number', description: 'Navigation timeout in ms. Default 30000, max 60000.' },
        keepOpen: {
          type: 'boolean',
          description:
            'Leave the visible browser window open after the check completes instead of ' +
            'closing it automatically. Default false.',
        },
      },
      required: ['url'],
    },
  },

  describeCall: (args) => `Open ${args.url ?? '…'} in the embedded browser`,

  execute: async (args, _ctx: ToolContext) => {
    const url = (args.url ?? '').trim()
    if (!url) {
      return toolErr('url must not be empty.')
    }
    if (!/^https?:\/\//i.test(url)) {
      return toolErr('url must start with http:// or https://')
    }

    let raw: TauriBrowserCheckResult
    try {
      raw = await invoke<TauriBrowserCheckResult>('run_browser_check', {
        args: {
          url,
          wait_ms: args.waitMs ?? undefined,
          full_page: args.fullPage ?? undefined,
          selector: args.selector ?? undefined,
          width: args.width ?? undefined,
          height: args.height ?? undefined,
          timeout_ms: args.timeoutMs ?? undefined,
          keep_open: false,
          headless: true,
        },
      })
    } catch (err) {
      return toolErr(
        `browser_check failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (!raw.ok) {
      return toolErr(raw.error ?? 'The embedded browser could not start.')
    }

    const consoleMessages = raw.consoleMessages ?? []
    const pageErrors = raw.pageErrors ?? []
    const failedRequests = raw.failedRequests ?? []
    const httpErrors = raw.httpErrors ?? []

    const hasErrors =
      pageErrors.length > 0 ||
      failedRequests.length > 0 ||
      httpErrors.length > 0 ||
      consoleMessages.some((m) => m.type === 'error')

    const result: BrowserCheckResult = {
      url,
      finalUrl: raw.finalUrl ?? url,
      title: raw.title ?? '',
      status: raw.status ?? null,
      navError: raw.navError,
      screenshotBase64: raw.screenshotBase64 ?? null,
      consoleMessages,
      pageErrors,
      failedRequests,
      httpErrors,
      durationMs: raw.durationMs ?? 0,
      hasErrors,
      usedFallbackBrowser: false,
    }

    // The agent and user share one durable in-IDE browser surface. Updating
    // it here makes every agent navigation immediately visible without an
    // external Playwright/Chromium window stealing focus.
    useBrowserStore.getState().updateFromAgent(result)

    return toolOk(result)
  },
}
