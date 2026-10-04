// services/windowRegistry/matching.ts
//
// Ranks Running Window Registry entries (services/windowRegistry/
// windowRegistryService.ts) against a free-text app name, executable, or
// window title — the running-window counterpart of services/appRegistry/
// matching.ts, and deliberately built the same way: this is exactly the
// "Rust returns a full raw scan, TS layer ranks it" split app_registry.rs
// documents for Part 1, applied to windows instead of installed apps.
//
// Reuses the same signals appRegistry/matching.ts already combines
// (substring/prefix, word-token overlap, fuzzyMatch's subsequence
// scorer) rather than inventing a second scorer — see that file's doc
// comment for why each one is there. The one addition here: a window has
// two name-like fields (`title` and `exeName`) worth matching against
// instead of one, e.g. "notepad" should find a window titled
// "Untitled - Notepad" via its exe name even if the title alone scores
// weakly, and an exact PID always wins outright since it's unambiguous.

import { fuzzyMatch } from '../../lib/fuzzyMatch'
import type { RunningWindow } from './types'

export interface ScoredWindow {
  window: RunningWindow
  score: number
}

const EXACT_BONUS = 1000
const PID_MATCH_BONUS = 2000
const PREFIX_BONUS = 200
const CONTAINS_BONUS = 100
const TOKEN_OVERLAP_BONUS = 40

/** Minimum score for a top match to be treated as confident without
 *  disambiguation. */
const CONFIDENT_THRESHOLD = 60
/** How much clearer the top match needs to be than the runner-up to count
 *  as unambiguous — mirrors appRegistry/matching.ts's CONFIDENT_MARGIN,
 *  so e.g. two similarly-titled Chrome windows don't silently auto-pick
 *  one over the other. */
const CONFIDENT_MARGIN = 30
/** Cap on how many candidates a disambiguation list surfaces. */
const MAX_AMBIGUOUS_CANDIDATES = 8

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s/_.,\-()]+/).filter(Boolean)
}

/** Strips a trailing ".exe" so "chrome" scores the same against
 *  "chrome.exe" as it would against a bare "chrome". */
function stripExeSuffix(name: string): string {
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name
}

function scoreAgainst(query: string, candidate: string): number {
  const q = query.trim().toLowerCase()
  const n = candidate.trim().toLowerCase()
  if (!q || !n) return 0
  if (q === n) return EXACT_BONUS

  let score = 0
  if (n.startsWith(q)) score += PREFIX_BONUS
  else if (n.includes(q)) score += CONTAINS_BONUS

  const qTokens = tokenize(query)
  const nTokens = tokenize(candidate)
  const overlap = qTokens.filter((t) => nTokens.includes(t)).length
  score += overlap * TOKEN_OVERLAP_BONUS

  const fm = fuzzyMatch(q, n)
  if (fm) score += fm.score

  return score
}

function scoreOne(query: string, window: RunningWindow): number {
  const trimmed = query.trim()

  // An exact numeric pid match is unambiguous by construction — no other
  // signal can outrank it.
  if (trimmed !== '' && /^\d+$/.test(trimmed) && Number(trimmed) === window.pid) {
    return PID_MATCH_BONUS
  }

  const titleScore = scoreAgainst(query, window.title)
  const exeScore = scoreAgainst(query, stripExeSuffix(window.exeName))
  return Math.max(titleScore, exeScore)
}

/** Scores every window against `query` (app name, executable, title, or
 *  numeric pid), highest first. Zero-score (no signal at all) candidates
 *  are dropped. */
export function rankRunningWindows(query: string, windows: RunningWindow[]): ScoredWindow[] {
  return windows
    .map((window) => ({ window, score: scoreOne(query, window) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
}

export type WindowMatchDecision =
  | { kind: 'none' }
  | { kind: 'confident'; window: RunningWindow }
  | { kind: 'ambiguous'; candidates: RunningWindow[] }

/**
 * Picks a single confident window match, a short disambiguation list, or
 * 'none' for `query` (app name, executable, title, or numeric pid)
 * against the given windows — mirrors services/appRegistry/matching.ts's
 * `pickAppMatch` decision shape, so callers that already handle that
 * shape (e.g. a future open_app/focus_app integration) can handle this
 * one the same way.
 */
export function findWindowMatch(query: string, windows: RunningWindow[]): WindowMatchDecision {
  const ranked = rankRunningWindows(query, windows)
  if (ranked.length === 0) return { kind: 'none' }

  const [best, runnerUp] = ranked
  if (
    best.score >= PID_MATCH_BONUS ||
    (best.score >= CONFIDENT_THRESHOLD && (!runnerUp || best.score - runnerUp.score >= CONFIDENT_MARGIN))
  ) {
    return { kind: 'confident', window: best.window }
  }

  const candidates = ranked
    .filter((r) => r.score >= CONTAINS_BONUS || r.score === best.score)
    .slice(0, MAX_AMBIGUOUS_CANDIDATES)
    .map((r) => r.window)

  return candidates.length > 0 ? { kind: 'ambiguous', candidates } : { kind: 'none' }
}
