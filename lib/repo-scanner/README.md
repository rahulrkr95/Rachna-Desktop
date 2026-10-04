# @rachna-ai-studio/reposcanner

Private TypeScript library powering repo understanding in [Rachna IDE](https://github.com/Rachna-AI-Studio/rachna-ide).

## What's inside

- **repoScanner** — incremental file watcher, language adapters (20+ languages), BM25 + semantic hybrid retrieval, symbol search, context builder
- **dependencyGraph** — import graph engine, cycle detection, topological sort algorithms
- **repoAnalysis** — high-level analysis utilities
- **run** — standalone CLI entry for scanning a repo from the command line

## Usage in Rachna IDE

This repo is consumed as a **git submodule** inside `rachna-ide` at `lib/repo-scanner`.

### Clone with submodule
```bash
git clone --recurse-submodules git@github.com:Rachna-AI-Studio/rachna-ide.git
```

### Update submodule (from rachna-ide root)
```bash
git submodule update --remote lib/repo-scanner
```

### Build
```bash
npm install
npm run build
```

## Development

When making changes:
1. Commit & push in this repo first
2. In `rachna-ide`, run `git submodule update --remote lib/repo-scanner` and commit the updated submodule pointer

## Structure

```
src/
  repoScanner/
    languageAdapters/    # Per-language AST/regex adapters
    languageDetection.ts # Classifies files by language/pipeline before any parsing
    scanner.ts           # Core incremental scanner (routes to per-language pipelines;
                         #   ts-morph is lazy-loaded and only initialized for TS/JS files)
    hybridRetrieval.ts   # BM25 + vector retrieval
    contextBuilder.ts    # Prompt context assembly
    ...
  dependencyGraph/
    graphEngine.ts      # Import graph construction
    algorithms.ts       # Cycle detection, topo sort
    ...
  repoAnalysis.ts       # High-level analysis
  run.ts                # CLI entry point
```
