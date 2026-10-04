// services/agent/tools/webTaskTool.ts
//
// Tool: web_task
//
// Powers the BROWSER_TASK intent (see lib/intentClassifier.ts): letting the
// agent act on the OPEN, UNAUTHENTICATED web — search results, public
// docs, a public form, scraping a public page, or polling a page for a
// change — by driving a real headless Chromium (via Playwright, run as a
// Node sidecar, lib/browser-tool/web-task.js) through an ordered list of
// steps in one browser session.
//
// This is deliberately session-less: it never loads cookies/local storage
// from a previous run, so it can only ever act as an anonymous visitor.
// Anything that needs the user's own logged-in account on a specific
// service (email, GitHub, a SaaS dashboard, etc.) belongs behind a real
// MCP connector (MCP_TASK), not this tool.
//
// "Write an automation script for a repetitive web task" (per the BROWSER_TASK
// intent's description) just means: the model composes the `steps` array
// once for the job, and that same array is what gets re-run — there's no
// separate "automation script" file format; the step list *is* the script.
//
// The `pressSequence` step is the BROWSER_TASK sibling of the desktop
// `press_key_sequence` tool (services/agent/tools/inputControlTools.ts): a
// long ordered run of up to 2000 individual keys, played through the page's
// own keyboard (via Playwright's page.keyboard, not the OS's), for things a
// single `press` can't do — repeated navigation, per-character typing that
// needs real keydown/keyup events (autocomplete widgets, custom editors),
// or replaying a captured keystroke sequence.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Types ───────────────────────────────────────────────────────────────────

export type WebTaskStep =
  | { action: 'goto'; url: string; timeoutMs?: number }
  | { action: 'click'; selector: string; timeoutMs?: number }
  | { action: 'fill'; selector: string; value: string; timeoutMs?: number }
  | { action: 'press'; selector: string; key: string; timeoutMs?: number }
  | { action: 'pressSequence'; selector?: string; keys: string[]; delayMs?: number; timeoutMs?: number }
  | { action: 'waitFor'; selector: string; timeoutMs?: number }
  | { action: 'wait'; ms: number }
  | { action: 'extractText'; selector: string; as?: string }
  | { action: 'extractAttr'; selector: string; attr: string; as?: string }
  | { action: 'screenshot'; fullPage?: boolean }

export interface WebTaskArgs {
  /**
   * Ordered steps to run in a single browser session. The FIRST step must
   * be a "goto" to load a starting page. Max 25 steps.
   */
  steps: WebTaskStep[]
  /** Viewport width in px. Default 1280. */
  width?: number
  /** Viewport height in px. Default 800. */
  height?: number
}

export interface WebTaskResult {
  finalUrl: string
  title: string
  /** Keyed by each step's `as` (or a sensible default) — text/attribute values pulled from the page. */
  extracted: Record<string, string[]>
  /** Base64-encoded PNG, present only if a "screenshot" step ran. Render as `data:image/png;base64,${screenshotBase64}`. */
  screenshotBase64: string | null
  stepLog: Array<{ action: string; ok: boolean; error?: string; [key: string]: unknown }>
  consoleErrors: string[]
  durationMs: number
  /**
   * Set only when a LATER step in the list failed partway through — steps
   * before it still ran and their results are in `extracted`/`stepLog`.
   * Absent when every step completed successfully.
   */
  partialFailure?: string
}

interface TauriWebTaskResult {
  ok: boolean
  error?: string
  finalUrl?: string
  title?: string
  extracted?: Record<string, string[]>
  screenshotBase64?: string | null
  stepLog?: Array<{ action: string; ok: boolean; error?: string; [key: string]: unknown }>
  consoleErrors?: string[]
  durationMs?: number
}

/** Max individual keys allowed in a single `pressSequence` step. */
const MAX_SEQUENCE_KEYS = 2000

// ── Tool definition ─────────────────────────────────────────────────────────

export const webTaskTool: AgentTool<WebTaskArgs, WebTaskResult> = {
  declaration: {
    name: 'web_task',
    description:
      'Drive a real headless browser through an ordered list of steps to search, browse, ' +
      'read, or extract data from the OPEN web — for tasks that do NOT require the user\'s ' +
      'own logged-in session on a specific site (this tool never loads cookies or saved ' +
      'sign-in state; it is always an anonymous visitor). Use this for: reading a public ' +
      'page or article, checking documentation, extracting data/links/prices from a public ' +
      'page, filling a public search or contact form, or building a small repeatable check ' +
      '(e.g. "does this page still say X"). The first step MUST be "goto" to load a starting ' +
      'URL. Available step actions: goto (url), click (selector), fill (selector, value), ' +
      'press (selector, key — e.g. "Enter"), pressSequence (keys — an ordered list of up to ' +
      '2000 individual keys played through the page\'s own keyboard one after another, ' +
      'optionally focusing "selector" first — for repeated navigation, custom widgets that ' +
      'need real per-key events, or replaying a captured keystroke run), waitFor (selector), ' +
      'wait (ms), extractText (selector, optional "as" name — grabs visible text from every ' +
      'matching element), extractAttr (selector, attr — e.g. "href", optional "as" name), and ' +
      'screenshot (optional fullPage). For anything needing the user\'s actual account on a ' +
      'named service (email inbox, GitHub, a SaaS dashboard, etc.), do not use this tool — ' +
      'that needs a proper MCP connector instead. Max 25 steps per call; if a step fails, ' +
      'execution stops there and everything extracted up to that point is still returned.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description:
            'Ordered list of step objects to run in one browser session. First step must be ' +
            '"goto". Each step is an object with an `action` field plus whatever that action ' +
            'needs: ' +
            'goto — {action:"goto", url}; ' +
            'click — {action:"click", selector}; ' +
            'fill — {action:"fill", selector, value}; ' +
            'press — {action:"press", selector, key} (key e.g. "Enter"); ' +
            'pressSequence — {action:"pressSequence", keys, selector?, delayMs?} (keys = ordered ' +
            'array of up to 2000 individual key names, e.g. ["ArrowDown","ArrowDown","Enter"]; ' +
            'selector, if given, is focused before the run starts; delayMs is the pause between ' +
            'keys in ms, default 30); ' +
            'waitFor — {action:"waitFor", selector}; ' +
            'wait — {action:"wait", ms}; ' +
            'extractText — {action:"extractText", selector, as?} (as = optional name for the ' +
            'result\'s `extracted` map, grabs visible text from every matching element); ' +
            'extractAttr — {action:"extractAttr", selector, attr, as?} (attr e.g. "href"); ' +
            'screenshot — {action:"screenshot", fullPage?}. ' +
            'Any step may also include `timeoutMs` to override its default timeout.',
          items: { type: 'object' },
        },
        width: { type: 'number', description: 'Viewport width in px. Default 1280.' },
        height: { type: 'number', description: 'Viewport height in px. Default 800.' },
      },
      required: ['steps'],
    },
  },

  describeCall: (args) => {
    const first = args.steps?.[0]
    const url = first && first.action === 'goto' ? first.url : undefined
    return url ? `Run web task on ${url}` : 'Run web task'
  },

  execute: async (args, _ctx: ToolContext) => {
    const steps = Array.isArray(args.steps) ? args.steps : []
    if (steps.length === 0) {
      return toolErr('steps must be a non-empty array.')
    }
    if (steps.length > 25) {
      return toolErr(`Too many steps (${steps.length}); max is 25.`)
    }
    if (steps[0]?.action !== 'goto') {
      return toolErr('The first step must be a "goto" to load a starting page.')
    }
    const first = steps[0] as Extract<WebTaskStep, { action: 'goto' }>
    if (!first.url || !/^https?:\/\//i.test(first.url)) {
      return toolErr('The first step\'s url must start with http:// or https://')
    }

    for (const step of steps) {
      if (step.action !== 'pressSequence') continue
      const keys = (step as Extract<WebTaskStep, { action: 'pressSequence' }>).keys
      if (!Array.isArray(keys) || keys.length === 0) {
        return toolErr('pressSequence requires a non-empty "keys" array.')
      }
      if (keys.length > MAX_SEQUENCE_KEYS) {
        return toolErr(`pressSequence has too many keys (${keys.length}); max is ${MAX_SEQUENCE_KEYS} per step.`)
      }
      if (keys.some((k) => typeof k !== 'string' || k.length === 0)) {
        return toolErr('Every item in pressSequence\'s "keys" must be a non-empty string.')
      }
    }

    let raw: TauriWebTaskResult
    try {
      raw = await invoke<TauriWebTaskResult>('run_web_task', {
        args: {
          steps,
          width: args.width ?? undefined,
          height: args.height ?? undefined,
        },
      })
    } catch (err) {
      return toolErr(`web_task failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!raw.ok && !raw.finalUrl) {
      // Total failure with nothing recovered at all (e.g. Playwright missing,
      // launch failed, or the very first goto itself failed).
      return toolErr(raw.error ?? 'web_task failed for an unknown reason.')
    }

    // A partial failure (some steps ran, then one failed) is still useful —
    // surface it as a successful tool call whose result carries the error
    // in `partialFailure`, rather than an outright tool failure, so the
    // agent can see exactly what was extracted before things stopped.
    const result: WebTaskResult = {
      finalUrl: raw.finalUrl ?? '',
      title: raw.title ?? '',
      extracted: raw.extracted ?? {},
      screenshotBase64: raw.screenshotBase64 ?? null,
      stepLog: raw.stepLog ?? [],
      consoleErrors: raw.consoleErrors ?? [],
      durationMs: raw.durationMs ?? 0,
      partialFailure: !raw.ok && raw.error ? raw.error : undefined,
    }

    return toolOk(result)
  },
}
