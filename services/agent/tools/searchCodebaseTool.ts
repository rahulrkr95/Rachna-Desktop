// services/agent/tools/searchCodebaseTool.ts
//
// Tool: search_codebase
// Wraps the existing FTS5 chunk-search + symbol-search infrastructure
// (lib/chunkSearch.ts) so the agent can look up relevant code by keyword
// or symbol name during its reasoning loop.
//
// Tool: semantic_search_codebase
// Wraps lib/semanticSearch.ts's Ollama + sqlite-vec retrieval path so the
// agent can find code by *meaning* rather than keyword overlap — useful
// for conceptual questions FTS5 can't match (e.g. "find all authentication
// flows" when the code never uses the literal word "authentication").

import {
  searchChunks,
  searchSymbols,
  extractSearchTerms,
  sanitizeFtsQuery,
  type ChunkSearchResult,
  type SymbolResult,
} from '../../../lib/chunkSearch'
import { semanticSearch, type SemanticChunk } from '../../../lib/semanticSearch'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

export interface SearchCodebaseArgs {
  query: string
}

export interface SearchCodebaseResult {
  query: string
  chunks: ChunkSearchResult[]
  symbols: SymbolResult[]
}

const MAX_CHUNKS = 8
const MAX_SYMBOLS = 8

export const searchCodebaseTool: AgentTool<SearchCodebaseArgs, SearchCodebaseResult> = {
  declaration: {
    name: 'search_codebase',
    description:
      'Search the indexed codebase for relevant code chunks and symbols ' +
      '(functions, classes, components, types) matching a query. ' +
      'Use this to find where something is implemented before reading files.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language or keyword query, e.g. "authentication flow" or "AuthProvider".',
        },
      },
      required: ['query'],
    },
  },

  describeCall: (args) => `Searching codebase for "${args.query}"…`,

  execute: async (args, ctx: ToolContext) => {
    const rawQuery = args.query?.trim()
    if (!rawQuery) return toolErr('Query must not be empty.')

    try {
      const extracted = extractSearchTerms(rawQuery)
      const sanitized = sanitizeFtsQuery(rawQuery)
      const ftsQuery = extracted || sanitized
      // Must pass projectRoot through — omitting it makes search_repo hash
      // an empty string into a per-project DB directory that was never
      // `init()`-ed, failing with "no such table: chunks_fts" (same root
      // cause as the Find in Files bug this was copy-pasted from).
      const projectRoot = ctx.projectRoot ?? undefined

      const [chunks, symbols] = await Promise.all([
        ftsQuery ? searchChunks(ftsQuery, MAX_CHUNKS, projectRoot) : Promise.resolve([] as ChunkSearchResult[]),
        searchSymbols(extracted || rawQuery, MAX_SYMBOLS, projectRoot),
      ])

      if (chunks.length === 0 && symbols.length === 0) {
        return toolErr(`No results found in the codebase index for "${rawQuery}".`)
      }

      return toolOk<SearchCodebaseResult>({ query: rawQuery, chunks, symbols })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Codebase search failed for "${rawQuery}".`
      )
    }
  },
}

// ── semantic_search_codebase ────────────────────────────────────────────

export interface SemanticSearchCodebaseArgs {
  query: string
}

export interface SemanticSearchCodebaseResult {
  query: string
  chunks: SemanticChunk[]
}

const MAX_SEMANTIC_CHUNKS = 10

export const semanticSearchCodebaseTool: AgentTool<
  SemanticSearchCodebaseArgs,
  SemanticSearchCodebaseResult
> = {
  declaration: {
    name: 'semantic_search_codebase',
    description:
      'Semantic similarity search across the codebase using local embeddings. ' +
      "Use this when the user asks conceptual questions like 'find all authentication flows' " +
      "or 'where is error handling done'.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language description of the concept or behavior to find, ' +
            'e.g. "authentication flow" or "where is error handling done".',
        },
      },
      required: ['query'],
    },
  },

  describeCall: (args) => `Semantically searching codebase for "${args.query}"…`,

  execute: async (args, _ctx: ToolContext) => {
    const rawQuery = args.query?.trim()
    if (!rawQuery) return toolErr('Query must not be empty.')

    try {
      const chunks = await semanticSearch(rawQuery, MAX_SEMANTIC_CHUNKS)

      if (chunks.length === 0) {
        return toolErr(
          `No semantic matches found for "${rawQuery}". The local embedding index may not be ` +
          'built yet — semantic search requires Ollama running locally with the ' +
          'nomic-embed-text model pulled.'
        )
      }

      return toolOk<SemanticSearchCodebaseResult>({ query: rawQuery, chunks })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Semantic codebase search failed for "${rawQuery}".`
      )
    }
  },
}
