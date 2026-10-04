// services/agent/tools/grepCodebaseTool.ts
//
// Tool: grep_codebase
//
// Regex search across all files in the project using the fastest available
// tool on the host system. Tries ripgrep (rg) first — it is 10–20× faster
// than GNU grep on large repos thanks to its SIMD-accelerated engine and
// built-in .gitignore awareness. Falls back to POSIX grep when rg is absent.
//
// The command is executed via the Tauri `run_terminal_command` backend, the
// same path used by run_terminal_command, so it inherits the detected shell
// and working directory handling already set up for that tool.
//
// Parameters:
//   pattern   — regex pattern (ERE / Perl syntax for rg; ERE for grep -E)
//   glob      — optional file glob filter, e.g. "*.ts" or "src/**/*.rs"
//   maxResults — cap on returned matches (default 50)
//   caseSensitive — default true; set false for case-insensitive search
//   contextLines  — lines of context around each match (default 0)
//
// Output fields:
//   matches    — array of { file, line, col, text } match records
//   truncated  — true when results were capped at maxResults
//   tool       — "rg" or "grep" (which binary was used)
//   command    — the full command string that was run (useful for debugging)

import { invoke }            from '@tauri-apps/api/core'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────

export interface GrepCodebaseArgs {
  /** Regex pattern to search for (ripgrep / POSIX ERE syntax) */
  pattern: string
  /**
   * Optional glob to restrict search to specific files, e.g. "*.ts",
   * "src/**\/*.rs". Omit to search all files.
   */
  glob?: string
  /** Maximum number of matches to return (default 50, max 200) */
  maxResults?: number
  /** Case-sensitive search (default true) */
  caseSensitive?: boolean
  /** Lines of context before/after each match (default 0) */
  contextLines?: number
}

export interface GrepMatch {
  /** Relative file path from project root */
  file: string
  /** 1-based line number */
  line: number
  /** 1-based column of match start (may be 0 when unavailable) */
  col: number
  /** Full source line text */
  text: string
}

export interface GrepCodebaseResult {
  pattern: string
  matches: GrepMatch[]
  matchCount: number
  truncated: boolean
  /** Which binary was used: "rg" or "grep" */
  tool: 'rg' | 'grep'
  /** Exact command that was executed */
  command: string
}

// ── Helpers ───────────────────────────────────────────────────────────────

const DEFAULT_MAX = 50
const HARD_MAX    = 200

interface TauriCommandResult {
  stdout: string
  stderr: string
  exit_code: number | null
}

async function runCommand(
  command: string,
  cwd: string,
  shell: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const raw = await invoke<TauriCommandResult>('run_terminal_command', {
    command,
    cwd,
    timeoutSeconds: 30,
    shell,
  })
  return { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exit_code }
}

/**
 * Build the ripgrep command string.
 *
 * rg flags used:
 *   --line-number (-n)   — include line numbers
 *   --column             — include column numbers
 *   --no-heading         — flat output, one match per line
 *   --with-filename (-H) — always prepend filename
 *   --max-count N        — stop after N total matches
 *   --context C          — lines of surrounding context
 *   -i                   — case insensitive
 *   -g GLOB              — file glob filter
 *   -e PATTERN           — pattern (avoids ambiguity with patterns starting with -)
 */
function buildRgCommand(args: GrepCodebaseArgs, cap: number): string {
  const flags: string[] = [
    '--line-number',
    '--column',
    '--no-heading',
    '--with-filename',
    `--max-count=${cap}`,
  ]

  if (!args.caseSensitive) flags.push('--ignore-case')
  if (args.contextLines && args.contextLines > 0) {
    flags.push(`--context=${Math.min(args.contextLines, 5)}`)
  }
  if (args.glob) flags.push(`--glob=${JSON.stringify(args.glob)}`)

  const escapedPattern = args.pattern.replace(/'/g, "'\\''")
  return `rg ${flags.join(' ')} -e '${escapedPattern}' .`
}

/**
 * Build the grep fallback command.
 * Uses `grep -rEHn` (recursive, extended regex, filename, line numbers).
 */
function buildGrepCommand(args: GrepCodebaseArgs, cap: number): string {
  const flags: string[] = ['-rEHn', '--color=never']
  if (!args.caseSensitive) flags.push('-i')
  if (args.contextLines && args.contextLines > 0) {
    flags.push(`-C${Math.min(args.contextLines, 5)}`)
  }

  // Build include filter from glob (simplistic — converts *.ts → --include="*.ts")
  if (args.glob) {
    const simpleGlob = args.glob.split('/').pop() ?? args.glob
    flags.push(`--include="${simpleGlob}"`)
  }

  // Exclude common noise dirs
  const excludeDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'target']
  for (const d of excludeDirs) {
    flags.push(`--exclude-dir="${d}"`)
  }

  const escapedPattern = args.pattern.replace(/'/g, "'\\''")
  return `grep ${flags.join(' ')} '${escapedPattern}' . | head -${cap}`
}

/**
 * Parse the flat `file:line:col:text` output from ripgrep.
 * Lines look like:  src/App.tsx:12:5:export default function App() {
 */
function parseRgOutput(stdout: string, projectRoot: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  const normRoot = projectRoot.replace(/\\/g, '/').replace(/\/$/, '')

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('--')) continue  // context separator

    // rg --no-heading format: filepath:lineNum:colNum:text
    const m = line.match(/^(.+?):(\d+):(\d+):(.*)$/)
    if (!m) continue

    let filePath = m[1].replace(/\\/g, '/')
    // Strip project root prefix to get relative path
    if (filePath.startsWith(normRoot + '/')) {
      filePath = filePath.slice(normRoot.length + 1)
    } else if (filePath.startsWith('./')) {
      filePath = filePath.slice(2)
    }

    matches.push({
      file: filePath,
      line: parseInt(m[2], 10),
      col:  parseInt(m[3], 10),
      text: m[4],
    })
  }
  return matches
}

/**
 * Parse `grep -rEHn` output format: file:line:text
 */
function parseGrepOutput(stdout: string, projectRoot: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  const normRoot = projectRoot.replace(/\\/g, '/').replace(/\/$/, '')

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('--')) continue

    const m = line.match(/^(.+?):(\d+):(.*)$/)
    if (!m) continue

    let filePath = m[1].replace(/\\/g, '/')
    if (filePath.startsWith(normRoot + '/')) {
      filePath = filePath.slice(normRoot.length + 1)
    } else if (filePath.startsWith('./')) {
      filePath = filePath.slice(2)
    }

    matches.push({
      file: filePath,
      line: parseInt(m[2], 10),
      col:  0,
      text: m[3],
    })
  }
  return matches
}

/** Resolve the detected shell from context, defaulting to 'sh'. */
function resolveShell(ctx: ToolContext): string {
  return ctx.systemInfo?.shell ?? 'sh'
}

// ── Tool ──────────────────────────────────────────────────────────────────

export const grepCodebaseTool: AgentTool<GrepCodebaseArgs, GrepCodebaseResult> = {
  declaration: {
    name: 'grep_codebase',
    description:
      'Search the project codebase for a regex pattern across all files, ' +
      'returning file paths, line numbers, and matching text. Uses ripgrep ' +
      '(rg) when available, falling back to grep. Unlike search_codebase ' +
      '(which searches the indexed FTS5 database), grep_codebase searches ' +
      'the raw file system in real time — use it when you need regex ' +
      'precision, want to search non-indexed files (e.g. Dockerfiles, YAML), ' +
      'or need exact string matches with column numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'Regex pattern to search for (ripgrep / POSIX ERE syntax). ' +
            'Examples: "TODO:", "useState\\(", "\\bAuthProvider\\b".',
        },
        glob: {
          type: 'string',
          description:
            'Optional glob pattern to restrict search to specific file types, ' +
            'e.g. "*.ts", "*.{ts,tsx}", "src/**/*.rs". Omit to search all files.',
        },
        maxResults: {
          type: 'number',
          description: `Maximum matches to return (default ${DEFAULT_MAX}, max ${HARD_MAX}).`,
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search. Default true.',
        },
        contextLines: {
          type: 'number',
          description: 'Lines of context before/after each match (0–5). Default 0.',
        },
      },
      required: ['pattern'],
    },
  },

  describeCall: (args) =>
    `Searching codebase for pattern "${args.pattern}"${args.glob ? ` in ${args.glob}` : ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const pattern = args.pattern?.trim()
    if (!pattern) return toolErr('pattern must not be empty.')

    if (!ctx.projectRoot) {
      return toolErr('No project folder is open — cannot run grep_codebase.')
    }

    const cap     = Math.min(args.maxResults ?? DEFAULT_MAX, HARD_MAX)
    const shell   = resolveShell(ctx)
    const cwd     = ctx.projectRoot

    // ── Try ripgrep first ────────────────────────────────────────────────
    let usedTool: 'rg' | 'grep' = 'rg'
    let command = buildRgCommand(args, cap)

    let result: { stdout: string; stderr: string; exitCode: number | null }

    try {
      result = await runCommand(command, cwd, shell)

      // Exit code 1 means "no matches" in rg — that's not an error
      // Exit code 2+ means rg itself errored (e.g. not found)
      if (result.exitCode !== null && result.exitCode > 1) {
        throw new Error(`rg exited with code ${result.exitCode}: ${result.stderr}`)
      }
    } catch {
      // rg not available — fall back to grep
      usedTool = 'grep'
      command  = buildGrepCommand(args, cap)

      try {
        result = await runCommand(command, cwd, shell)
        // grep exit code 1 = no matches (not an error)
        if (result.exitCode !== null && result.exitCode > 1) {
          return toolErr(
            `grep failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`
          )
        }
      } catch (err) {
        return toolErr(
          `Both rg and grep failed. Install ripgrep for best results. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    const matches =
      usedTool === 'rg'
        ? parseRgOutput(result.stdout, ctx.projectRoot)
        : parseGrepOutput(result.stdout, ctx.projectRoot)

    const truncated = matches.length >= cap

    return toolOk<GrepCodebaseResult>({
      pattern,
      matches: matches.slice(0, cap),
      matchCount: matches.length,
      truncated,
      tool:    usedTool,
      command,
    })
  },
}
