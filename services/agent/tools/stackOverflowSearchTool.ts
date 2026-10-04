// services/agent/tools/stackOverflowSearchTool.ts
//
// Tool: search_stackoverflow
//
// Lets the agent search Stack Overflow specifically, via the public
// StackExchange API (api.stackexchange.com — no API key required for the
// agent's low request volume). Returns structured question/answer data
// (scores, accepted-answer flag, answer body) rather than raw HTML, which
// is both more reliable to parse and more useful for the model than a
// generic web_search snippet — it can see the actual accepted fix, not
// just a link to it.
//
// Two-step flow per call:
//   1. /2.3/search/advanced — find matching questions, ranked by relevance.
//   2. /2.3/questions/{ids}/answers — pull the top answer body for each
//      question that has one, with markdown stripped down to plain text.
//
// filter=withbody is required on both calls to get `body` back; the
// default StackExchange filter omits it to save bandwidth.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Types ───────────────────────────────────────────────────────────────────

export interface StackOverflowSearchArgs {
  /** Search text, e.g. "TypeError cannot read property of undefined react useEffect". */
  query: string
  /** Max questions to return. Default 5, max 10. */
  maxResults?: number
}

export interface StackOverflowAnswer {
  isAccepted: boolean
  score: number
  /** Answer body, converted from the StackExchange HTML body to plain text. */
  body: string
}

export interface StackOverflowQuestionResult {
  title: string
  link: string
  score: number
  isAnswered: boolean
  tags: string[]
  /** Top answer (accepted if one exists, else highest-scored), if any. */
  topAnswer?: StackOverflowAnswer
}

export interface StackOverflowSearchResult {
  query: string
  questions: StackOverflowQuestionResult[]
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

interface SeQuestion {
  question_id: number
  title: string
  link: string
  score: number
  is_answered: boolean
  accepted_answer_id?: number
  tags: string[]
}

interface SeAnswer {
  question_id: number
  answer_id: number
  is_accepted: boolean
  score: number
  body?: string
}

const API_BASE = 'https://api.stackexchange.com/2.3'
const DEFAULT_MAX_RESULTS = 5
const HARD_MAX_RESULTS = 10

function htmlToPlainText(html: string): string {
  return html
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_m, code) => `\n\`\`\`\n${stripTags(code)}\n\`\`\`\n`)
    .replace(/<code>([\s\S]*?)<\/code>/g, (_m, code) => `\`${stripTags(code)}\``)
    .replace(/<\/(p|li|div)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let raw: TauriHttpResult
  try {
    raw = await invoke<TauriHttpResult>('run_http_request', {
      args: { url, method: 'GET', timeout_seconds: 20 },
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!raw.ok) {
    return { ok: false, error: `${raw.status} ${raw.status_text}: ${raw.body.slice(0, 300)}` }
  }
  try {
    return { ok: true, data: JSON.parse(raw.body) as T }
  } catch {
    return { ok: false, error: 'StackExchange API returned non-JSON response.' }
  }
}

// ── Tool definition ─────────────────────────────────────────────────────────

export const stackOverflowSearchTool: AgentTool<StackOverflowSearchArgs, StackOverflowSearchResult> = {
  declaration: {
    name: 'search_stackoverflow',
    description:
      'Search Stack Overflow for an unfamiliar API, library error, or "how do I do X with ' +
      'this library" question. Returns matching questions along with their top (accepted, ' +
      'or highest-scored) answer text — not just links — so you can see the actual fix. Use ' +
      'this when you hit a runtime/compile error involving a third-party API, or need to ' +
      'confirm how a library is conventionally used. For official docs or anything not ' +
      'Stack Overflow specific, prefer web_search.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search text — works best as the error message or a short natural-language ' +
            'description of the problem plus the library/language name, e.g. ' +
            '"react-query useMutation onError not firing".',
        },
        maxResults: {
          type: 'number',
          description: `Max questions to return. Default ${DEFAULT_MAX_RESULTS}, max ${HARD_MAX_RESULTS}.`,
        },
      },
      required: ['query'],
    },
  },

  describeCall: (args) => `Searching Stack Overflow: "${args.query ?? '…'}"`,

  execute: async (args, _ctx: ToolContext) => {
    const query = (args.query ?? '').trim()
    if (!query) {
      return toolErr('query must not be empty.')
    }

    const rawMax = typeof args.maxResults === 'number' ? args.maxResults : DEFAULT_MAX_RESULTS
    const maxResults = Math.min(Math.max(1, rawMax), HARD_MAX_RESULTS)

    const searchUrl =
      `${API_BASE}/search/advanced?order=desc&sort=relevance&site=stackoverflow` +
      `&pagesize=${maxResults}&q=${encodeURIComponent(query)}`

    const searchRes = await getJson<{ items: SeQuestion[] }>(searchUrl)
    if (!searchRes.ok) {
      return toolErr(`Stack Overflow search failed: ${searchRes.error}`)
    }

    const questions = searchRes.data.items ?? []
    if (questions.length === 0) {
      return toolOk<StackOverflowSearchResult>({ query, questions: [] })
    }

    // Pull top answers for questions that have at least one answer.
    const idsWithAnswers = questions.filter(q => q.is_answered).map(q => q.question_id)
    const answersByQuestion = new Map<number, SeAnswer[]>()

    if (idsWithAnswers.length > 0) {
      const answersUrl =
        `${API_BASE}/questions/${idsWithAnswers.join(';')}/answers` +
        `?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=100`
      const answersRes = await getJson<{ items: SeAnswer[] }>(answersUrl)
      if (answersRes.ok) {
        for (const a of answersRes.data.items ?? []) {
          const list = answersByQuestion.get(a.question_id) ?? []
          list.push(a)
          answersByQuestion.set(a.question_id, list)
        }
      }
      // If the answers call fails, we still return questions without bodies
      // rather than failing the whole tool call.
    }

    const result: StackOverflowQuestionResult[] = questions.map(q => {
      const answers = (answersByQuestion.get(q.question_id) ?? [])
        .slice()
        .sort((a, b) => {
          if (a.is_accepted !== b.is_accepted) return a.is_accepted ? -1 : 1
          return b.score - a.score
        })
      const best = answers[0]

      return {
        title: htmlToPlainText(q.title),
        link: q.link,
        score: q.score,
        isAnswered: q.is_answered,
        tags: q.tags ?? [],
        topAnswer: best
          ? {
              isAccepted: best.is_accepted,
              score: best.score,
              body: htmlToPlainText(best.body ?? '').slice(0, 4000),
            }
          : undefined,
      }
    })

    return toolOk<StackOverflowSearchResult>({ query, questions: result })
  },
}
