// services/appRegistry/matching.ts
//
// Ranks Installed App Registry entries against a free-text app name typed
// (or spoken) by the agent/user for open_app.
//
// Reuses the matching primitives that already exist elsewhere in the
// codebase rather than inventing a new one:
//   - keyword/substring matching — the same case-insensitive `contains`
//     check the Rust `resolve_app` command already uses to filter Start
//     Menu / App Paths results (see search_start_menu / search_app_paths
//     in src-tauri/src/desktop_task.rs).
//   - fuzzy subsequence matching — the character-subsequence scorer that
//     already powers CommandPalette's Ctrl+Shift+P search, extracted to
//     lib/fuzzyMatch.ts so it can be shared instead of duplicated. This is
//     what tolerates missing/out-of-order "syllables" — "vsc" still finds
//     "VS Code", "phocs" still finds "Photos".
//   - word/keyword-token overlap — splitting both the query and the
//     candidate name into words and counting shared tokens, which is the
//     same "does this contain the words the user said" idea as the
//     substring check above, just tolerant of word order and extra words
//     (e.g. "code" matching "Visual Studio Code").
//
// These three combine into a single confidence score per candidate, which
// `pickAppMatch` then uses to decide between auto-launching a single
// confident match and surfacing a short disambiguation list — mirroring
// the "single match launches, multiple surfaces a list" behavior open_app
// already had via `resolve_app`.

import { fuzzyMatch } from '../../lib/fuzzyMatch'
import type { InstalledApp } from './types'

export interface ScoredApp {
  app: InstalledApp
  score: number
}

const EXACT_BONUS = 1000
const PREFIX_BONUS = 200
const CONTAINS_BONUS = 100
const TOKEN_OVERLAP_BONUS = 40

/** Minimum score for a top match to be treated as launchable without
 *  disambiguation. */
const CONFIDENT_THRESHOLD = 60
/** How much clearer the top match needs to be than the runner-up to count
 *  as unambiguous, even when both individually clear the confidence bar
 *  above (e.g. "chrome" shouldn't silently auto-pick between two
 *  similarly-named Chrome channel installs). */
const CONFIDENT_MARGIN = 30
/** Cap on how many candidates a disambiguation list surfaces. */
const MAX_AMBIGUOUS_CANDIDATES = 8

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s/_.,\-()]+/).filter(Boolean)
}

function scoreOne(query: string, name: string): number {
  const q = query.trim().toLowerCase()
  const n = name.trim().toLowerCase()
  if (!q) return 0
  if (q === n) return EXACT_BONUS

  let score = 0

  // Keyword/substring signal — same semantics as resolve_app's `.contains(needle)`.
  if (n.startsWith(q)) score += PREFIX_BONUS
  else if (n.includes(q)) score += CONTAINS_BONUS

  // Keyword-token overlap — order/extra-word tolerant version of the above.
  const qTokens = tokenize(query)
  const nTokens = tokenize(name)
  const overlap = qTokens.filter((t) => nTokens.includes(t)).length
  score += overlap * TOKEN_OVERLAP_BONUS

  // Fuzzy/syllable-tolerant signal — reused CommandPalette scorer.
  const fm = fuzzyMatch(q, n)
  if (fm) score += fm.score

  return score
}

/** Scores every candidate against `query`, highest first. Zero-score
 *  (no signal at all) candidates are dropped. */
export function rankInstalledApps(query: string, apps: InstalledApp[]): ScoredApp[] {
  return apps
    .map((app) => ({ app, score: scoreOne(query, app.name) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
}

export type AppMatchDecision =
  | { kind: 'none' }
  | { kind: 'confident'; app: InstalledApp }
  | { kind: 'ambiguous'; candidates: InstalledApp[] }

/**
 * Picks a single confident match, a short disambiguation list, or 'none'
 * (→ caller should fall back to the legacy `resolve_app` search) for
 * `query` against the registry.
 */
export function pickAppMatch(query: string, apps: InstalledApp[]): AppMatchDecision {
  const ranked = rankInstalledApps(query, apps)
  if (ranked.length === 0) return { kind: 'none' }

  const [best, runnerUp] = ranked
  if (best.score >= CONFIDENT_THRESHOLD && (!runnerUp || best.score - runnerUp.score >= CONFIDENT_MARGIN)) {
    return { kind: 'confident', app: best.app }
  }

  const candidates = ranked
    .filter((r) => r.score >= CONTAINS_BONUS || r.score === best.score)
    .slice(0, MAX_AMBIGUOUS_CANDIDATES)
    .map((r) => r.app)

  return candidates.length > 0 ? { kind: 'ambiguous', candidates } : { kind: 'none' }
}
