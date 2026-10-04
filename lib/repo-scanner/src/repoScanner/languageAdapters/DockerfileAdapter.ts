// lib/repoScanner/languageAdapters/DockerfileAdapter.ts
//
// LanguageAdapter for Dockerfiles and docker-compose variants.
//
// Recognised filenames / extensions:
//   Dockerfile, Dockerfile.* (e.g. Dockerfile.dev, Dockerfile.prod)
//   docker-compose.yml / docker-compose.yaml (treated via YamlAdapter for
//   full YAML awareness; this adapter handles raw Dockerfiles only)
//
// Extracted symbols — each Dockerfile instruction becomes a "symbol":
//   FROM   <image>[:<tag>][@<digest>] [AS <stage>]  → kind: 'class'   (build stage)
//   RUN    <command>                                 → kind: 'function' (shell step)
//   CMD    <command>                                 → kind: 'function' (default cmd)
//   ENTRYPOINT <command>                             → kind: 'function'
//   EXPOSE <port>[/<proto>]                          → kind: 'variable' (port declaration)
//   ENV    <key>=<value> | <key> <value>             → kind: 'variable' (env var)
//   ARG    <name>[=<default>]                        → kind: 'variable' (build arg)
//   LABEL  <key>=<value>                             → kind: 'variable' (metadata)
//   COPY   --from=<stage> <src> <dst>                → kind: 'variable'
//   ADD    <src> <dst>                               → kind: 'variable'
//   WORKDIR <path>                                   → kind: 'variable'
//   VOLUME  <path>                                   → kind: 'variable'
//   USER    <user>                                   → kind: 'variable'
//
// Each `FROM` starts a new build stage; subsequent instructions until the
// next FROM are considered part of that stage. Stage name comes from the
// optional `AS <name>` clause and is prepended to RUN/COPY/etc. symbols to
// make them identifiable in multi-stage builds.

import type {
  LanguageAdapter,
  Symbol,
  Import,
  Export,
  Reference,
  SymbolKind,
  ExportKind,
} from './types'

// Instructions that become searchable symbols
const INSTRUCTION_KINDS: Record<string, SymbolKind> = {
  FROM:       'class',    // build stage boundary
  RUN:        'function', // shell command
  CMD:        'function', // default container command
  ENTRYPOINT: 'function', // container entrypoint
  EXPOSE:     'variable', // exposed port
  ENV:        'variable', // env var
  ARG:        'variable', // build argument
  LABEL:      'variable', // image label
  COPY:       'variable', // file copy
  ADD:        'variable', // file add
  WORKDIR:    'variable', // working directory
  VOLUME:     'variable', // volume mount point
  USER:       'variable', // user switch
}

/** Strip shell-style comments (#) and trim */
function stripComment(line: string): string {
  const idx = line.indexOf('#')
  return (idx >= 0 ? line.slice(0, idx) : line).trim()
}

/** Extract the meaningful "name" from an instruction argument */
function instructionName(instruction: string, rest: string): string {
  const arg = rest.trim()

  switch (instruction) {
    case 'FROM': {
      // FROM ubuntu:22.04 AS builder  →  "ubuntu:22.04 (builder)"
      const asMatch = arg.match(/^(\S+)(?:\s+AS\s+(\S+))?/i)
      if (!asMatch) return arg
      const image = asMatch[1]
      const stage = asMatch[2]
      return stage ? `${image} (${stage})` : image
    }

    case 'ENV': {
      // ENV KEY=VALUE  or  ENV KEY VALUE  →  "KEY"
      const m = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
      return m ? m[1] : arg
    }

    case 'ARG': {
      // ARG NAME or ARG NAME=default  →  "NAME"
      const m = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
      return m ? m[1] : arg
    }

    case 'EXPOSE': {
      // EXPOSE 8080/tcp  →  "8080/tcp"
      return arg.split(/\s+/)[0]
    }

    case 'WORKDIR': {
      return arg
    }

    case 'USER': {
      return arg.split(/\s+/)[0]
    }

    case 'VOLUME': {
      // VOLUME /data or VOLUME ["/data"]
      return arg.replace(/[[\]"]/g, '').split(/[\s,]+/)[0] ?? arg
    }

    case 'LABEL': {
      // LABEL key=value  →  "key"
      const m = arg.match(/^([A-Za-z_][A-Za-z0-9_.-]*)/)
      return m ? m[1] : arg
    }

    case 'RUN':
    case 'CMD':
    case 'ENTRYPOINT': {
      // Keep the first token of the shell command (up to 40 chars)
      const cmd = arg
        .replace(/^\[|]$/g, '')    // strip JSON-array brackets
        .replace(/"/g, '')
        .trim()
      return cmd.length > 40 ? cmd.slice(0, 37) + '…' : cmd
    }

    case 'COPY':
    case 'ADD': {
      // COPY --from=stage src dst  →  "src → dst"
      const parts = arg.replace(/--\S+\s*/g, '').trim().split(/\s+/)
      if (parts.length >= 2) return `${parts[0]} → ${parts[parts.length - 1]}`
      return arg
    }

    default:
      return arg.length > 40 ? arg.slice(0, 37) + '…' : arg
  }
}

export class DockerfileAdapter implements LanguageAdapter {
  readonly name = 'Dockerfile'

  // Match: `Dockerfile`, `Dockerfile.dev`, `Dockerfile.prod`, etc.
  // The AdapterRegistry matches by extension; for extensionless files like
  // plain "Dockerfile" we register the pseudo-extension 'dockerfile' and
  // rely on the scanner's filename→extension mapping (see scanner.ts:extOf).
  readonly extensions = ['dockerfile'] as const

  // ── extractSymbols ──────────────────────────────────────────────────────

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    let currentStage = ''  // name of the current FROM stage

    // Handle line continuation: Dockerfile lines ending with `\` continue
    // on the next line. We resolve them before symbol extraction.
    const resolvedLines: Array<{ text: string; origIdx: number }> = []
    let i = 0
    while (i < lines.length) {
      let text = lines[i]
      const origIdx = i
      while (text.endsWith('\\') && i + 1 < lines.length) {
        text = text.slice(0, -1) + ' ' + lines[i + 1].trim()
        i++
      }
      resolvedLines.push({ text, origIdx })
      i++
    }

    for (const { text, origIdx } of resolvedLines) {
      const stripped = stripComment(text)
      if (!stripped) continue

      // Match: INSTRUCTION rest
      const match = stripped.match(/^([A-Z]+)\s+(.*)$/)
      if (!match) continue

      const [, instruction, rest] = match
      const kind = INSTRUCTION_KINDS[instruction]
      if (!kind) continue

      // Track stage name from FROM … AS <name>
      if (instruction === 'FROM') {
        const asMatch = rest.match(/AS\s+(\S+)/i)
        currentStage = asMatch ? asMatch[1] : ''
      }

      const rawName = instructionName(instruction, rest)

      // Prefix with stage name for multi-stage builds (except FROM itself)
      const name = (currentStage && instruction !== 'FROM')
        ? `[${currentStage}] ${instruction} ${rawName}`
        : `${instruction} ${rawName}`

      symbols.push({
        name,
        kind,
        startLine: origIdx + 1,
        endLine:   origIdx + 1,
      })
    }

    return symbols
  }

  // ── extractImports ──────────────────────────────────────────────────────
  // COPY --from=<stage|image> is the closest Dockerfile has to an "import"

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const copyFromRe = /^COPY\s+--from=(\S+)/gim
    let m: RegExpExecArray | null
    while ((m = copyFromRe.exec(content)) !== null) {
      const specifier = m[1]
      imports.push({
        specifier,
        namedImports: [],
        defaultImport: null,
        namespaceImport: null,
        isRelative: false,
      })
    }

    // Base images as implicit dependencies (FROM <image>)
    const fromRe = /^FROM\s+(\S+)/gim
    while ((m = fromRe.exec(content)) !== null) {
      const image = m[1].toLowerCase()
      if (image === 'scratch') continue  // no-op base
      imports.push({
        specifier: m[1],
        namedImports: [],
        defaultImport: null,
        namespaceImport: null,
        isRelative: false,
      })
    }

    return imports
  }

  // ── extractExports ──────────────────────────────────────────────────────
  // Named build stages (FROM … AS <name>) are the exported artifacts

  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const fromRe = /^FROM\s+\S+\s+AS\s+(\S+)/gim
    let m: RegExpExecArray | null
    while ((m = fromRe.exec(content)) !== null) {
      exports.push({ name: m[1], kind: 'class' as ExportKind })
    }

    // If no named stages, export the image name heuristic (filename)
    if (exports.length === 0) {
      exports.push({ name: 'dockerfile', kind: 'default' as ExportKind })
    }
    return exports
  }

  // ── extractReferences ────────────────────────────────────────────────────
  // ENV vars used in RUN / CMD / COPY via ${VAR} or $VAR

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const lines = content.split('\n')
    const varRe = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g

    for (let i = 0; i < lines.length; i++) {
      let m: RegExpExecArray | null
      varRe.lastIndex = 0
      while ((m = varRe.exec(lines[i])) !== null) {
        refs.push({ symbolName: m[1], line: i + 1, fromSpecifier: null })
      }
    }
    return refs
  }
}
