// lib/agenticClassifier.ts
//
// One lightweight pre-planning pass that both checks whether clarification
// is needed and confirms the specialist chip's requested TopIntent.


import type { AIProvider } from './providers/types'
import { loggedStream } from './llmCallLogger'
import type { TopIntent } from './intentClassifier'

export interface PromptCorrectionResult {
  correctedText?: string
  clarifyingQuestions?: string[]
  rawResponse?: string
  topIntent: TopIntent
}

export interface AutomationClassificationResult {
  kind: 'no_ai' | 'needs_ai'
  rawResponse?: string
}

const SYSTEM_ACCESS_NOTE = 
`Through configured tools, the agent can reach the user's system, including local files and installed apps, keyboard/mouse input and screenshots, coding tools, a terminal, web browser and connected MCP services.`

export const GENERIC_AGENT_IDENTITY = 
`You are an AI agent embedded in Rachna AI Studio, an AI-powered desktop IDE and assistant. ${SYSTEM_ACCESS_NOTE}`

function extractJson(raw: string): unknown {
  const json = raw.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error('Response did not contain a JSON object.')
  return JSON.parse(json)
}

async function runJsonCall(
  timeoutLabel: string,
  question: string,
  provider: AIProvider,
  apiKey: string,
  model: string | undefined,
  systemInstruction: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${timeoutLabel} timeout`)), 30_000)
    loggedStream('intent_classification', provider, apiKey, [{ role: 'user', content: question }], {
      onChunk: () => {},
      onDone: text => { clearTimeout(timeout); resolve(text) },
      onError: error => { clearTimeout(timeout); reject(error) },
    }, { model, systemInstruction }).catch(error => { clearTimeout(timeout); reject(error) })
  })
}

export const AUTOMATION_CLASSIFIER_PROMPT = `Classify this this automation by whether its work at the triggered time requires AI.
Return JSON format: {"kind":"NO_AI"} or {"kind":"NEEDS_AI"}.
NO_AI means purely deterministic terminal commands. 
NEEDS_AI means writing, reasoning, judgement, browsing, or coding decisions are required.`

export async function runAutomationClassifier(
  question: string,
  provider: AIProvider,
  apiKey: string,
  model?: string,
): Promise<AutomationClassificationResult> {
  try {
    const raw = await runJsonCall('automation classifier', question, provider, apiKey, model, AUTOMATION_CLASSIFIER_PROMPT)
    const parsed = extractJson(raw) as { kind?: unknown }
    if (parsed.kind !== 'NO_AI' && parsed.kind !== 'NEEDS_AI') throw new Error('Invalid automation classification.')
    return { kind: parsed.kind === 'NO_AI' ? 'no_ai' : 'needs_ai', rawResponse: raw }
  } catch {
    return { kind: 'needs_ai' }
  }
}

const TOP_INTENTS: readonly TopIntent[] = [
  'CODING_TASK', 'DESIGN_TASK', 'DESKTOP_TASK', 'MCP_TASK',
  'BROWSER_TASK', 'AUTOMATION', 'CHAT',
]

export function getPromptCorrectionSystemPrompt(chipIntent: TopIntent, repoContext?: string): string {
  const repoSection = repoContext
    ? `\n\nThe request targets these explicitly selected folders:\n${repoContext}`
    : ''
  return `${GENERIC_AGENT_IDENTITY}${repoSection}

The user has the "${chipIntent}" specialist selected as the default intent for this request.

Do two things:
1. Assess legibility. Set correctedText only if the request is genuinely unclear or garbled — never fix ordinary typos.
Ask clarifying questions ONLY when essential info is missing and can't be determined during execution (max 3, be highly judicious).
2. Confirm intent. Keep topIntent as "${chipIntent}" unless the request obviously and unambiguously belongs to a different one of: 
CODING_TASK, DESIGN_TASK, DESKTOP_TASK(Includes tasks on browser), MCP_TASK, BROWSER_TASK(Only headless browser tasks), AUTOMATION(Alarms, crons, scheduled task), CHAT. 
Only override on a clear mismatch — default to keeping the user's selection.

Return JSON only:
{"correctedText":null,"clarifyingQuestions":[],"topIntent":"${chipIntent}"}
`
}

export function parsePromptCorrectionResponse(raw: string, chipIntent: TopIntent): PromptCorrectionResult {
  const parsed = extractJson(raw) as { correctedText?: unknown; clarifyingQuestions?: unknown; topIntent?: unknown }
  const correctedText = typeof parsed.correctedText === 'string' ? parsed.correctedText.trim() || undefined : undefined
  const clarifyingQuestions = Array.isArray(parsed.clarifyingQuestions)
    ? parsed.clarifyingQuestions.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean).slice(0, 3)
    : undefined
  return {
    rawResponse: raw,
    topIntent: TOP_INTENTS.includes(parsed.topIntent as TopIntent) ? parsed.topIntent as TopIntent : chipIntent,
    ...(correctedText ? { correctedText } : {}),
    ...(clarifyingQuestions?.length ? { clarifyingQuestions } : {}),
  }
}

export async function runPromptCorrectionClassifier(
  question: string,
  provider: AIProvider,
  apiKey: string,
  model: string | undefined,
  chipIntent: TopIntent,
  repoContext?: string,
): Promise<PromptCorrectionResult> {
  if (!question.trim()) return { topIntent: chipIntent }
  try {
    const raw = await runJsonCall('request refinement and intent classifier', question, provider, apiKey, model, getPromptCorrectionSystemPrompt(chipIntent, repoContext))
    return parsePromptCorrectionResponse(raw, chipIntent)
  } catch {
    return { topIntent: chipIntent }
  }
}
