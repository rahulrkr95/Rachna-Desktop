// lib/repoScanner/intentDetector.ts
//
// Query Intent Detection (spec section C).
//
// Classifies a free-text user request into one of a small set of intents so
// the hybrid retriever can bias which retrieval stage gets the most weight
// and how far the dependency graph should be expanded.
//
// This is deliberately a fast, deterministic, keyword/regex classifier —
// no model call, no network — so it costs nothing on every retrieval.

export type QueryIntent =
  | 'modify'              // "add a field to...", "refactor...", "rename..."
  | 'bug_fix'              // "fix", "broken", "error", "crash", "not working"
  | 'explain'              // "explain", "what does X do", "how does X work"
  | 'find_implementation'  // "where is X defined", "find the function that..."
  | 'architecture'         // "how is X structured", "overview", "design"
  | 'frontend'             // "style", "css", "layout", "UI", "component"
  | 'general'              // fallback — no strong signal either way

export interface IntentBias {
  intent: QueryIntent
  /** Multiplier applied to exact symbol-match scores. */
  symbolWeight: number
  /** Multiplier applied to filename/path-match scores. */
  pathWeight: number
  /** Multiplier applied to import/reference (graph-propagated) scores. */
  importWeight: number
  /** Multiplier applied to BM25 keyword scores. */
  keywordWeight: number
  /** Multiplier applied to embedding fallback scores (kept low by design). */
  vectorWeight: number
  /** How many hops to expand the dependency graph from top-ranked files. */
  graphHops: number
  /** File extensions to boost for this intent (e.g. html/css for frontend). */
  preferredExtensions: string[]
}

// ── Keyword tables ──────────────────────────────────────────────────────────

const BUGFIX_PATTERNS = /\b(fix|bug|broken|crash(?:es|ing)?|error|exception|fail(?:s|ing|ure)?|not work(?:ing)?|regression|stack trace|throws?)\b/i
const EXPLAIN_PATTERNS = /\b(explain|what does|what is|how does .* work|walk me through|describe|understand)\b/i
const FIND_PATTERNS = /\b(where is|find (?:the )?(?:function|method|class|symbol|implementation|definition)|defined|locate|which file)\b/i
const ARCH_PATTERNS = /\b(architecture|overview|structure(?:d)?|design|how (?:is|are) .* (?:organized|structured)|data flow|module layout|big picture)\b/i
const FRONTEND_PATTERNS = /\b(css|style(?:s|sheet|d|ing)?|layout|ui|ux|component|markup|html|responsive|theme|color|font|button|modal|page design)\b/i
const MODIFY_PATTERNS = /\b(add|implement|create|update|change|refactor|rename|remove|delete|extend|modify)\b/i

// ── Public API ────────────────────────────────────────────────────────────

/** Classifies a query into a QueryIntent using deterministic pattern matching. */
export function detectIntent(query: string): QueryIntent {
  const q = query.trim()
  if (!q) return 'general'

  // Order matters: more specific signals checked before generic "modify".
  if (BUGFIX_PATTERNS.test(q)) return 'bug_fix'
  if (FIND_PATTERNS.test(q)) return 'find_implementation'
  if (ARCH_PATTERNS.test(q)) return 'architecture'
  if (FRONTEND_PATTERNS.test(q)) return 'frontend'
  if (EXPLAIN_PATTERNS.test(q)) return 'explain'
  if (MODIFY_PATTERNS.test(q)) return 'modify'
  return 'general'
}

/**
 * Returns the retrieval-stage weight bias for a given intent.
 *
 * Baseline ordering always holds (symbol > path > import/keyword > vector);
 * biases only shift weight *within* that envelope, they never invert it,
 * so embedding similarity never becomes primary even for "explain"/
 * "architecture" intents.
 */
export function getIntentBias(intent: QueryIntent): IntentBias {
  switch (intent) {
    case 'bug_fix':
      // Bugs are usually found via references + callers, so push graph
      // expansion (imports/callers) and keyword/error-text matches hard.
      return {
        intent, symbolWeight: 1.0, pathWeight: 0.9, importWeight: 1.5,
        keywordWeight: 1.2, vectorWeight: 0.5, graphHops: 2,
        preferredExtensions: [],
      }
    case 'find_implementation':
      // Looking for a definition — exact symbol matches dominate.
      return {
        intent, symbolWeight: 1.6, pathWeight: 1.1, importWeight: 0.6,
        keywordWeight: 0.8, vectorWeight: 0.4, graphHops: 1,
        preferredExtensions: [],
      }
    case 'architecture':
      // Wants the shape of the system — spread across multiple related
      // files via wider graph expansion, keyword/path matches over single
      // exact symbols.
      return {
        intent, symbolWeight: 0.8, pathWeight: 1.0, importWeight: 1.3,
        keywordWeight: 1.1, vectorWeight: 0.6, graphHops: 2,
        preferredExtensions: [],
      }
    case 'frontend':
      // Bias toward markup/style files specifically.
      return {
        intent, symbolWeight: 0.9, pathWeight: 1.2, importWeight: 0.8,
        keywordWeight: 1.1, vectorWeight: 0.4, graphHops: 1,
        preferredExtensions: ['html', 'css', 'scss', 'less', 'jsx', 'tsx', 'vue'],
      }
    case 'modify':
      return {
        intent, symbolWeight: 1.3, pathWeight: 1.0, importWeight: 1.0,
        keywordWeight: 0.9, vectorWeight: 0.4, graphHops: 1,
        preferredExtensions: [],
      }
    case 'explain':
      return {
        intent, symbolWeight: 1.1, pathWeight: 1.0, importWeight: 1.0,
        keywordWeight: 1.0, vectorWeight: 0.5, graphHops: 1,
        preferredExtensions: [],
      }
    case 'general':
    default:
      return {
        intent, symbolWeight: 1.0, pathWeight: 1.0, importWeight: 1.0,
        keywordWeight: 1.0, vectorWeight: 0.4, graphHops: 1,
        preferredExtensions: [],
      }
  }
}
