// lib/projectRules.ts
//
// Persistent, project-scoped custom instructions for the agent.
//
// On every turn, useChat.ts calls loadProjectRules(projectRoot) and folds
// the result into the system prompt (see prompts.ts::buildSystemPrompt).
// Two file names are recognised, checked in this order:
//
//   1. .rachna/rules.md   — Rachna-native location, namespaced so it never
//                            collides with other tools' config files.
//   2. AGENTS.md           — the emerging cross-tool convention (Cursor,
//                            Aider, Codex, etc. all read a file by this
//                            name at the project root). Reading it too means
//                            a repo that already has one "just works" with
//                            no Rachna-specific setup.
//
// If both exist, BOTH are injected (Rachna rules first) — a repo maintainer
// may want general-purpose AGENTS.md conventions PLUS Rachna-specific
// instructions (e.g. "always use propose_edit, never raw file writes").

import { getPathInfo, readFileContent } from './tauriFs'

/** Hard cap so a runaway rules file can't blow the prompt budget. */
const MAX_RULES_CHARS = 8_000

export const RACHNA_RULES_RELATIVE_PATH   = '.rachna/rules.md'
export const RACHNA_RULES_FLAT_PATH       = '.rachna-rules'    // flat-file alternative
export const AGENTS_MD_RELATIVE_PATH      = 'AGENTS.md'

export interface ProjectRulesResult {
  /** Combined, ready-to-inject text, or null if no rules file was found. */
  text: string | null
  /** Which file(s) contributed, for UI/debugging. */
  sources: string[]
}

function joinPath(root: string, relative: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  return `${trimmedRoot}${sep}${relative.replace(/\//g, sep)}`
}

function truncate(content: string, label: string): string {
  const trimmed = content.trim()
  if (trimmed.length <= MAX_RULES_CHARS) return trimmed
  return trimmed.slice(0, MAX_RULES_CHARS) + `\n…(${label} truncated at ${MAX_RULES_CHARS} chars)`
}

async function tryRead(path: string): Promise<string | null> {
  try {
    const info = await getPathInfo(path)
    if (!info.exists || !info.is_file) return null
    const content = await readFileContent(path)
    return content
  } catch {
    return null
  }
}

/**
 * Loads `.rachna/rules.md` and/or `AGENTS.md` from the project root.
 * Never throws — returns `{ text: null, sources: [] }` when neither exists
 * or no project is open.
 */
export async function loadProjectRules(projectRoot: string | null): Promise<ProjectRulesResult> {
  if (!projectRoot) return { text: null, sources: [] }

  const blocks: string[] = []
  const sources: string[] = []

  const rachnaRules = await tryRead(joinPath(projectRoot, RACHNA_RULES_RELATIVE_PATH))
  if (rachnaRules && rachnaRules.trim()) {
    blocks.push(truncate(rachnaRules, RACHNA_RULES_RELATIVE_PATH))
    sources.push(RACHNA_RULES_RELATIVE_PATH)
  }

  // Flat-file alternative: .rachna-rules at the project root
  if (blocks.length === 0 || !rachnaRules) {
    const rachnaRulesFlat = await tryRead(joinPath(projectRoot, RACHNA_RULES_FLAT_PATH))
    if (rachnaRulesFlat && rachnaRulesFlat.trim()) {
      blocks.push(truncate(rachnaRulesFlat, RACHNA_RULES_FLAT_PATH))
      sources.push(RACHNA_RULES_FLAT_PATH)
    }
  }

  const agentsMd = await tryRead(joinPath(projectRoot, AGENTS_MD_RELATIVE_PATH))
  if (agentsMd && agentsMd.trim()) {
    blocks.push(truncate(agentsMd, AGENTS_MD_RELATIVE_PATH))
    sources.push(AGENTS_MD_RELATIVE_PATH)
  }

  if (blocks.length === 0) return { text: null, sources: [] }

  const text = sources
    .map((src, i) => `### From ${src}\n${blocks[i]}`)
    .join('\n\n')

  return { text, sources }
}

/** Default scaffold written when the user creates rules.md from the UI. */
export const RULES_TEMPLATE = `# Project Rules

Custom instructions the agent reads on every turn, in addition to its
built-in system prompt. Use this for conventions that are specific to
this repo and would otherwise have to be repeated in every chat.

Examples:

- Coding style: prefer named exports; no default exports for components.
- Testing: every new function needs a Vitest unit test in the same folder.
- Never touch files under \`vendor/\` or \`generated/\`.
- Package manager: this repo uses pnpm, not npm.
- Run \`pnpm typecheck\` after any change to \`*.ts\` files before proposing it as done.
`
