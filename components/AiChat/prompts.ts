// components/AiChat/prompts.ts
//
// All prompt text and prompt-assembly logic lives here — no UI code.
// AiChat and the agent loop import from this module; prompts are never
// defined inline in React components.

import type { AiContext } from '../../types'
import type { ChatIntent, AgentSubIntent } from '../../lib/intentClassifier'
import { buildPromptForIntent } from '../../prompts/promptBuilder'
import type { RetrievalStats } from '../../lib/chunkSearch'
import type { SystemInfo, DetectedShell } from '../../services/agent/types'
import type { ScanResult } from '../../lib/repo-scanner/src/repoScanner/types'

/**
 * Builds a concise "## Repo Summary" section from the current ScanResult.
 * Returns null when no project is open or the scan hasn't run yet.
 */
export function buildRepoSummarySection(scanResult: ScanResult | null): string | null {
  if (!scanResult || scanResult.totalFiles === 0) return null

  // Language breakdown: top 6 by file count
  const langMap = new Map<string, number>()
  for (const f of scanResult.files) {
    const ext = f.extension || 'unknown'
    langMap.set(ext, (langMap.get(ext) ?? 0) + 1)
  }
  const topLangs = [...langMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, count]) => `${ext}(${count})`)
    .join(', ')

  // Top-level folders
  const folderSet = new Set<string>()
  for (const f of scanResult.files) {
    const parts = f.relativePath.split('/')
    if (parts.length > 1) folderSet.add(parts[0])
  }
  const folders = [...folderSet].sort().slice(0, 8).join(', ')

  const lines = [
    `## Repo Summary`,
    `Project: ${scanResult.projectRoot}`,
    `Files: ${scanResult.totalFiles} | Lines: ${scanResult.totalLines.toLocaleString()}`,
    topLangs ? `Languages: ${topLangs}` : null,
    folders  ? `Top-level folders: ${folders}` : null,
    `(Call get_repo_overview for a full structural breakdown.)`,
  ].filter(Boolean) as string[]

  return lines.join('\n')
}

/** Builds the "## Environment" block describing the detected OS/shell. */
export function buildEnvironmentSection(systemInfo: SystemInfo): string {
  return [
    '## Environment',
    `OS: ${systemInfo.osLabel}`,
    `Shell: ${systemInfo.shellLabel}`,
  ].join('\n')
}

/**
 * Returns the full system instruction for the agent loop: the base
 * SYSTEM_PROMPT plus an environment-specific section describing the
 * detected OS/shell and the command syntax to use with run_terminal_command.
 *
 * Optionally appends:
 *  - `projectRules`   — text loaded from `.rachna/rules.md` / `AGENTS.md`
 *                        (see lib/projectRules.ts), injected verbatim as a
 *                        "## Project Rules" section so it carries the same
 *                        authority as the rest of the system prompt.
 *  - `mcpToolsSection` — a description of any connected MCP server tools
 *                        (see services/agent/mcpTools.ts), so the model
 *                        knows they exist and what they're for — the base
 *                        tool list above is static and can't list them.
 *  - `rejectedEdits`   — the last N edits the user declined, formatted as
 *                        a "## Conversation Memory" block so the agent
 *                        doesn't re-propose the same changes.
 */
export function buildSystemPrompt(
  systemInfo: SystemInfo,
  opts: {
    /** Classified intent for this turn; chooses the intent-specific system prompt. */
    intent?: ChatIntent
    /** Classified sub-intent for this turn; further specializes the selected prompt. */
    subIntent?: AgentSubIntent
    projectRules?: string | null
    mcpToolsSection?: string | null
    /** Recent rejected edits from SQLite — built by useChat before each turn. */
    rejectedEdits?: Array<{ file_path: string; description: string }> | null
    /**
     * Current agent plan from useTodoStore — injected so the model stays
     * aware of its own task list across turns without re-reading it explicitly.
     * Pass formatTodosForPrompt(useTodoStore.getState().todos) from useChat.
     */
    todoContext?: string | null
    /**
     * Compact repo summary from the latest ScanResult — injected so the model
     * has an always-available architectural overview without calling
     * get_repo_overview first. Build via buildRepoSummarySection(scanResult).
     */
    repoSummary?: string | null
    /**
     * Two-stage classification pipeline: whether to include the
     * environment/system-info section at all for this turn. Defaults to
     * true so call sites that don't run classification (retry, edit-
     * message, plan-approve) keep their existing behaviour. useChat.ts
     * passes intentNeedsSystemInfo(intent) (see lib/intentClassifier.ts) so
     * system info is only actually sent to the model for AGENTIC_TASK turns
     * (plus RUN_PROJECT/TERMINAL_TASK, which need the shell to work at
     * all) — never for a plain SOFTWARE/WORK_WITH_REPO turn or CHAT.
     */
    includeSystemInfo?: boolean
  } = {}
): string {
  const parts = [buildPromptForIntent(opts.intent, opts.subIntent)]
  if (opts.includeSystemInfo ?? true) {
    parts.push(buildEnvironmentSection(systemInfo))
  }

  // ── Compact repo summary (language breakdown + folder structure) ─────────
  if (opts.repoSummary) {
    parts.push(opts.repoSummary)
  }

  if (opts.mcpToolsSection) {
    parts.push(opts.mcpToolsSection)
  }

  if (opts.projectRules) {
    parts.push(
      '## Project Rules\n' +
      'The following were provided by the project itself (.rachna/rules.md, ' +
      '.rachna-rules, and/or AGENTS.md). Treat them as binding instructions, with the same ' +
      'authority as the rest of this system prompt — they exist precisely ' +
      'to encode conventions that can\'t be inferred from the code alone.\n\n' +
      opts.projectRules
    )
  }

  // ── Conversation memory: rejected-edit summary ─────────────────────────
  // Injected so the agent knows not to re-propose changes the user already
  // declined in this project. The list is capped at 3 entries (most recent
  // first) so it stays concise and never dominates the prompt.
  if (opts.rejectedEdits && opts.rejectedEdits.length > 0) {
    const lines = opts.rejectedEdits
      .slice(0, 3)
      .map(e => `- \`${e.file_path}\`: ${e.description}`)
      .join('\n')
    parts.push(
      '## Conversation Memory\n' +
      'The user has previously rejected the following proposed edits in this ' +
      'project. Do NOT re-propose these exact changes unless the user ' +
      'explicitly asks you to try again:\n\n' +
      lines
    )
  }

  // ── Active todo plan ────────────────────────────────────────────────────
  // Injected on every turn so the model can see its own plan and pick up
  // exactly where it left off without calling manage_todos(read) first.
  if (opts.todoContext) {
    parts.push(opts.todoContext)
  }

  return parts.join('\n\n')
}

// ── Active-file context character limit ───────────────────────────────────────
// This limit now applies ONLY when retrieval explicitly decides to inject
// a file's content (e.g. the file ranked highly and fits in budget).
// Automatic full-content injection on every turn has been removed.
const MAX_ACTIVE_FILE_CHARS = 12_000

// ── assembleUserPrompt ────────────────────────────────────────────────────────
// Builds the full user-turn content string that is sent to the model.
// Combines active file METADATA (path only — no content), selection,
// retrieved repo context, and the raw user question into a single structured
// block.
//
// ── Active File Context Policy ───────────────────────────────────────────────
// The currently open file's CONTENT is NOT injected automatically.
// Only lightweight metadata is included:
//   - Current file path  (ranking signal, gives the model orientation)
//   - Open file paths    (ranking signal, shows editor session scope)
// This metadata is passed as a retrieval ranking signal via RetrievalOptions
// (activeFilePaths). The actual file content is only included when retrieval
// determines the file is relevant to the user's request — preventing token
// waste on every turn while still surfacing context when it matters.

export interface AssembledPromptInput {
  /** Raw question the user typed. */
  question: string
  /** IDE context — active file path, selection, language. fileContent is
   *  intentionally not used for automatic injection; see policy above. */
  context: AiContext
  /** Pre-built context blocks from the retrieval pipeline. */
  repoContextBlock: string
  symbolContextBlock: string
  graphContextBlock: string
  /** Semantic (vector embedding) search results, already formatted. */
  semanticContextBlock?: string
  /**
   * Optional: aggregated verification failure context from the last accepted
   * edit (build failures, test failures, lint errors). Injected BEFORE the
   * user question so the agent can self-heal immediately.
   */
  verificationContext?: string
  /**
   * Display name of the primary open project's root folder (e.g.
   * "my-app"), used to label the retrieved-context block as
   * "Repo Context for Folder 1: <name>" so the model can tell which
   * project a given chunk of context came from once additional folders
   * are added (see additionalFoldersContext below). Omitted when no
   * project is open.
   */
  primaryFolderName?: string
  /**
   * Pre-formatted context blocks for any additional folders added to the
   * File Explorer beyond the primary project (see
   * store/useAdditionalFoldersStore.ts) — each already labeled
   * "Repo Context for Folder N: <name>" by the caller (useChat.ts). Lets
   * composite tasks that span multiple repos/services see all of them at
   * once, distinguished by folder.
   */
  additionalFoldersContext?: string
}

export function assembleUserPrompt({
  question,
  context,
  repoContextBlock,
  symbolContextBlock,
  graphContextBlock,
  semanticContextBlock,
  verificationContext,
  primaryFolderName,
  additionalFoldersContext,
}: AssembledPromptInput): string {
  const parts: string[] = []

  // ── Editor context metadata (paths only — NO file content) ──────────────
  // This tells the model which file is focused and what else is open so it
  // can orient itself. Content is deliberately withheld here; it only appears
  // below if retrieval decided it was relevant (via repoContextBlock).
  if (context.file) {
    const currentFileLine =
      `Current File: ${context.filePath || context.file}` +
      (context.language ? ` (${context.language})` : '')
    parts.push(currentFileLine)
  }

  // Selection — always injected when present (user explicitly highlighted it)
  if (context.selection) {
    parts.push(`Selected Code:\n\`\`\`${context.language ?? ''}\n${context.selection}\n\`\`\``)
  }

  // Retrieved context — join all non-empty blocks
  const retrievedContext = [repoContextBlock, symbolContextBlock, semanticContextBlock, graphContextBlock]
    .filter(Boolean)
    .join('\n\n')

  if (retrievedContext) {
    // ✅ Retrieval found results — inject them, labeled by folder so the
    // model can tell them apart once additional folders are in play (a
    // plain "Retrieved Repo Context:" header when only one project is
    // open, matching prior behavior for single-folder workspaces).
    const label = primaryFolderName
      ? `Repo Context for Folder 1: ${primaryFolderName}`
      : 'Retrieved Repo Context'
    parts.push(`${label}:\n${retrievedContext}`)
  }
  // ✅ Retrieval genuinely returned zero results — omit the "Retrieved Repo
  // Context" block entirely rather than sending a "No repository context
  // found" placeholder. The model already has EXISTING vs NEW/EMPTY project
  // signals elsewhere in the prompt (file tree, current file, etc.), so
  // padding every empty-retrieval turn with this boilerplate just wastes
  // tokens without adding guidance.

  // ── Additional folders (multi-repo composite tasks) ──────────────────────
  // Already formatted (one "Repo Context for Folder N: <name>" block per
  // extra folder) by the caller — see useChat.ts. Injected regardless of
  // whether the primary project's retrieval found anything, so a folder
  // added purely as a second reference project still shows up.
  if (additionalFoldersContext) {
    parts.push(additionalFoldersContext)
  }


  // ── Verification context (build / test / lint failures from last edit) ──────
  // Injected just before the user question so the agent immediately sees
  // what broke and can self-heal without another round-trip.
  if (verificationContext) {
    parts.push(
      '---\n## ⚠️ Post-Edit Verification Results\n' + verificationContext + '\n---'
    )
  }

  parts.push(`User Question: ${question}`)
  return parts.join('\n\n')
}

// ── buildNoContextMessage ─────────────────────────────────────────────────────
// Creates the retrieval-stats object for a turn with zero context found.

export function isNoContextFound(stats: Omit<RetrievalStats, 'noContextFound'>): boolean {
  return stats.chunksFound === 0 && stats.symbolsFound === 0 && stats.filesRetrieved.length === 0
}

// ── Build New Project flow (file-tree-first, parallel content generation) ──
//
// Used by services/agent/buildNewProject.ts. This flow deliberately does NOT
// go through the normal agent tool loop:
//   1. One plain completion asks for the file tree ONLY (strict JSON).
//   2. All files are proposed on the review bar immediately as placeholders.
//   3. One plain completion PER FILE, run in parallel, asks for that file's
//      complete content. Each proposal is updated in place as it arrives.
//   4. Nothing is written to disk, and the project is NOT indexed, until the
//      user accepts the proposed files via the review bar.
// This is why these are separate, narrowly-scoped prompts rather than reuses
// of SYSTEM_PROMPT — the model must return raw JSON / raw file content only,
// with no tool calls, no markdown fences, and no commentary.

/** System prompt for step 1: propose the file tree only, as strict JSON. */
export const FILE_TREE_SYSTEM_PROMPT = `You are a senior software architect planning the file structure for a brand-new, empty project.

Given the user's request, decide the full set of files needed to build a working first version of what they asked for (source files, config files, package manifest, entry HTML, README — whatever a real, runnable project of this kind needs).

Respond with ONLY a raw JSON object, no markdown code fences, no commentary before or after, matching exactly this shape:
{"projectSummary": "one short sentence describing what is being built", "files": [{"path": "relative/path/to/file.ext", "description": "one line describing what this file contains and why"}]}

Rules:
- Paths are relative to the project root, using forward slashes, no leading slash, no "..".
- Include every file the project needs to actually run (e.g. package.json for a Node project, index.html for a static site) — not just the "interesting" ones.
- Order files sensibly (config/manifest files first, then source, then entry points last) — this is the order they will be created in.
- Keep the file count reasonable for the scope of the request (typically 3-25 files). Do not pad with speculative files the request doesn't call for.
- Output raw JSON only. Do not wrap it in \`\`\`json or any other formatting.`

/**
 * System prompt for step 1, DESIGN mode — same JSON contract as
 * FILE_TREE_SYSTEM_PROMPT, but planning a set of static, standalone HTML
 * design pages instead of a runnable app. See runBuildNewProjectFlow's
 * `mode: 'design'` — routed here whenever the classifier tags a request
 * DESIGN (lib/intentClassifier.ts), which is always treated as a new
 * project of its own.
 */
export const DESIGN_FILE_TREE_SYSTEM_PROMPT = `You are a senior product designer / creative director planning the page structure for a brand-new visual design project.

Given the user's request, decide the full set of files needed — every page is a single, standalone, self-contained HTML file (Tailwind via CDN + lucide icons via CDN, no build step, no backend, no framework). Add a short README.md summarizing the design. Do not propose package.json, config files, or any server/build tooling — this is a pure static design deliverable.

Respond with ONLY a raw JSON object, no markdown code fences, no commentary before or after, matching exactly this shape:
{"projectSummary": "one short sentence describing the design being created", "files": [{"path": "relative/path/to/page.html", "description": "one line describing this page's purpose and key sections"}]}

Rules:
- Paths are relative to the project root, using forward slashes, no leading slash, no "..". Use "index.html" for the primary/first page.
- Every page must be its own complete .html file — never split markup, styles, or scripts for one page across multiple files.
- Keep the page count matched to the request's scope (a single landing page is usually 1 file; a small multi-page site is typically 2-6 pages). Do not pad with speculative pages the request doesn't call for.
- Order files sensibly — index.html (or the primary page) first, then supporting pages, then README.md last.
- Output raw JSON only. Do not wrap it in \`\`\`json or any other formatting.`

/** User-turn text for step 1. `mode` selects wording appropriate to a design vs. a coding project. */
export function buildFileTreeUserPrompt(originalRequest: string, projectName: string, mode: 'code' | 'design' = 'code'): string {
  const action = mode === 'design' ? 'Propose the page tree now, as raw JSON only.' : 'Propose the file tree now, as raw JSON only.'
  return `Project name: ${projectName}\n\nOriginal request:\n${originalRequest}\n\n${action}`
}

export interface ProposedFileTreeEntry {
  path: string
  description: string
}

export interface ProposedFileTree {
  projectSummary: string
  files: ProposedFileTreeEntry[]
}

/**
 * Parses the model's file-tree response, tolerating stray markdown fences or
 * leading/trailing commentary the model may add despite instructions.
 * Returns null if no valid file tree could be extracted.
 */
export function parseFileTreeResponse(raw: string): ProposedFileTree | null {
  const stripped = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = stripped.indexOf('{')
  const end   = stripped.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    if (!parsed || !Array.isArray(parsed.files)) return null

    const files: ProposedFileTreeEntry[] = parsed.files
      .filter((f: unknown): f is { path?: unknown; description?: unknown } =>
        !!f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string'
      )
      .map((f: { path: unknown; description?: unknown }) => ({
        path: String(f.path).trim(),
        description: typeof f.description === 'string' ? f.description : '',
      }))
      .filter((f: ProposedFileTreeEntry) => f.path.length > 0 && !f.path.includes('..'))

    if (files.length === 0) return null

    return {
      projectSummary: typeof parsed.projectSummary === 'string' ? parsed.projectSummary : '',
      files,
    }
  } catch {
    return null
  }
}

/** System prompt for step 3: generate ONE file's complete content, raw text only. */
export const FILE_CONTENT_SYSTEM_PROMPT = `You are a senior software engineer writing ONE complete file for a brand-new project. Another step already decided the full file tree — you are filling in the content for a single file from that tree.

Respond with ONLY the raw, complete content of the file. No markdown code fences, no explanation, no commentary before or after — just the exact bytes that should be written to disk. The file must be complete and runnable/valid on its own (imports resolved against the other files in the tree, correct syntax for its language, no placeholders like "// TODO: implement" for core functionality).`

/**
 * System prompt for step 3, DESIGN mode — produces one complete,
 * production-quality static HTML design page per file (see
 * DESIGN_FILE_TREE_SYSTEM_PROMPT above for the matching tree-planning
 * prompt).
 */
export const DESIGN_FILE_CONTENT_SYSTEM_PROMPT = `You are a senior product designer / front-end designer writing ONE complete, self-contained HTML design page. Another step already decided the full page tree — you are filling in the content for a single page from that tree.

Respond with ONLY the raw, complete HTML content of the file. No markdown code fences, no explanation, no commentary before or after — just the exact bytes that should be written to disk (unless the target file is README.md, in which case write plain markdown instead of HTML).

For every .html page, follow these rules exactly:
- Start with \`<!DOCTYPE html>\`, a proper \`<head>\` with a descriptive \`<title>\`, and a \`<meta name="viewport" content="width=device-width, initial-scale=1">\`.
- Load Tailwind CSS from the CDN: \`<script src="https://cdn.tailwindcss.com"></script>\`. Use Tailwind utility classes for ALL styling — no separate .css files, no inline \`style=\` attributes except for one-off values Tailwind can't express (e.g. a specific background-image URL).
- Load Lucide icons from the CDN: \`<script src="https://unpkg.com/lucide@latest"></script>\`, and call \`lucide.createIcons();\` in a \`<script>\` at the end of \`<body>\`. Use \`<i data-lucide="icon-name"></i>\` for every icon — never inline SVGs, never emoji as icons, never a different icon library.
- If linking to another page proposed in the tree, use a plain relative \`href\` (e.g. \`href="pricing.html"\`) — every page must also be fully self-contained and viewable on its own by opening the file directly.
- Design to a genuinely high, modern bar: real content (no "Lorem ipsum" placeholder text — write believable copy that fits the request), a clear visual hierarchy, generous whitespace, a considered color palette (2-3 accent colors plus neutrals, applied consistently), a real type scale (distinct sizes/weights for hero, headings, body, captions), and thoughtful micro-details (hover states via Tailwind's \`hover:\`/\`transition\` utilities, subtle shadows/rounding, well-aligned grids). Prefer web-safe/system font stacks or a single Google Font loaded via \`<link>\` — don't reference fonts that need local installation.
- Make it responsive: layouts must reflow sensibly at mobile widths using Tailwind's responsive prefixes (\`sm:\`, \`md:\`, \`lg:\`).
- No backend, no build step, no framework imports (no React/Vue/etc.), no external data fetching — pure static HTML/Tailwind/Lucide/vanilla JS only, and only vanilla \`<script>\` if the page needs simple interactivity (e.g. a mobile nav toggle, an accordion).`

/** User-turn text for step 3 — includes the full tree for cross-file consistency. */
export function buildFileContentUserPrompt(params: {
  originalRequest: string
  projectName: string
  projectSummary: string
  targetPath: string
  targetDescription: string
  allFiles: ProposedFileTreeEntry[]
  mode?: 'code' | 'design'
}): string {
  const treeList = params.allFiles
    .map(f => `- ${f.path}${f.description ? ` — ${f.description}` : ''}`)
    .join('\n')
  const noun = params.mode === 'design' ? 'page' : 'file'

  return [
    `Project name: ${params.projectName}`,
    params.projectSummary ? `Project summary: ${params.projectSummary}` : '',
    `Original request:\n${params.originalRequest}`,
    `Full ${noun} tree (for context — you are writing ONLY the one ${noun} marked below):\n${treeList}`,
    `Now write the complete content for: ${params.targetPath}`,
    params.targetDescription ? `This ${noun}'s purpose: ${params.targetDescription}` : '',
    `Output ONLY the raw content for ${params.targetPath}, nothing else.`,
  ].filter(Boolean).join('\n\n')
}

/** Strips stray markdown code fences the model may add despite instructions. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/)
  return fenceMatch ? fenceMatch[1] : trimmed
}