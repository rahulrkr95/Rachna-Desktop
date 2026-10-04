// services/agent/tools/curlTool.ts
//
// Tool: curl_request
//
// Lets the agent make arbitrary HTTP requests from chat — i.e. "run curl".
// Goes through the Rust `run_http_request` Tauri command, which uses a
// native HTTP client (reqwest) instead of the webview's `fetch`. This means
// it is NOT subject to browser CORS restrictions, which is what makes it
// possible to reliably reach things like a remote LM Studio server running
// on another machine on the network (LM Studio's CORS headers, or lack
// thereof, simply don't matter here).
//
// "curl TYPE" = HTTP method. The `method` argument is a closed enum mirroring
// the verbs curl supports for typical API/debugging use: GET, POST, PUT,
// PATCH, DELETE, HEAD, OPTIONS.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Types ───────────────────────────────────────────────────────────────────

export type CurlMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

const ALLOWED_METHODS: CurlMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export interface CurlRequestArgs {
  /** Full URL, including scheme — e.g. "http://192.168.1.42:1234/v1/models". */
  url: string
  /**
   * The HTTP method / "curl type" to use. One of GET, POST, PUT, PATCH,
   * DELETE, HEAD, OPTIONS. Defaults to GET if omitted.
   */
  method?: CurlMethod
  /** Optional request headers, e.g. { "Authorization": "Bearer xyz" }. */
  headers?: Record<string, string>
  /**
   * Optional request body. Provide a JSON string for JSON APIs — it will be
   * sent as-is with `Content-Type: application/json` unless you set your own
   * Content-Type header.
   */
  body?: string
  /** Seconds before the request is aborted. Default 30. Maximum 120. */
  timeoutSeconds?: number
}

export interface CurlRequestResult {
  url: string
  method: CurlMethod
  status: number
  statusText: string
  headers: Record<string, string>
  /** Response body as text. If it looks like JSON, callers can JSON.parse it. */
  body: string
  ok: boolean
  durationMs: number
  timedOut: boolean
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

// ── Tool definition ─────────────────────────────────────────────────────────

export const curlTool: AgentTool<CurlRequestArgs, CurlRequestResult> = {
  declaration: {
    name: 'curl_request',
    description:
      'Make an HTTP request (i.e. "run curl") to any URL — local or remote — and ' +
      'return the status, headers, and body. Runs through a native HTTP client, ' +
      'not the browser, so it is NOT blocked by CORS. Use this to: ' +
      'reach a remote/LAN LM Studio (or Ollama, or any OpenAI-compatible) server ' +
      '(e.g. GET {baseUrl}/v1/models to list models, POST {baseUrl}/v1/chat/completions ' +
      'to chat); call any other local or external HTTP API; or debug a webhook/endpoint. ' +
      'You must specify the "type" of request via the `method` argument ' +
      '(GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS) — GET is used if omitted. ' +
      'For POST/PUT/PATCH requests with a JSON payload, pass `body` as a JSON string; ' +
      'Content-Type: application/json is set automatically unless you override it.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Full URL including scheme, e.g. "http://192.168.1.42:1234/v1/models" ' +
            'or "https://api.example.com/v1/resource".',
        },
        method: {
          type: 'string',
          enum: ALLOWED_METHODS,
          description:
            'The HTTP method / curl type to use: GET, POST, PUT, PATCH, DELETE, ' +
            'HEAD, or OPTIONS. Defaults to GET.',
        },
        headers: {
          type: 'object',
          description:
            'Optional request headers as key/value pairs, e.g. ' +
            '{ "Authorization": "Bearer xyz" }.',
        },
        body: {
          type: 'string',
          description:
            'Optional request body, usually a JSON string for POST/PUT/PATCH requests.',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Seconds before the request is aborted. Default 30. Maximum 120.',
        },
      },
      required: ['url'],
    },
  },

  describeCall: (args) => `${(args.method ?? 'GET').toUpperCase()} ${args.url ?? '…'}`,

  execute: async (args, _ctx: ToolContext) => {
    const url = (args.url ?? '').trim()
    if (!url) {
      return toolErr('url must not be empty.')
    }
    if (!/^https?:\/\//i.test(url)) {
      return toolErr('url must start with http:// or https://')
    }

    const rawMethod = (args.method ?? 'GET').toUpperCase() as CurlMethod
    if (!ALLOWED_METHODS.includes(rawMethod)) {
      return toolErr(
        `Unsupported curl type/method: "${args.method}". ` +
        `Must be one of: ${ALLOWED_METHODS.join(', ')}.`
      )
    }

    const rawTimeout = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 30
    const timeoutSeconds = Math.min(Math.max(1, rawTimeout), 120)

    let raw: TauriHttpResult
    try {
      raw = await invoke<TauriHttpResult>('run_http_request', {
        args: {
          url,
          method: rawMethod,
          headers: args.headers ?? undefined,
          body: args.body ?? undefined,
          timeout_seconds: timeoutSeconds,
        },
      })
    } catch (err) {
      return toolErr(
        `Request failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const result: CurlRequestResult = {
      url,
      method: rawMethod,
      status: raw.status,
      statusText: raw.status_text,
      headers: raw.headers,
      body: raw.body,
      ok: raw.ok,
      durationMs: raw.duration_ms,
      timedOut: raw.timed_out,
    }

    return toolOk(result)
  },
}
