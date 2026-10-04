// services/lsp/languageMap.ts
//
// Maps a file path to the LSP language id we should talk to.
// Extended to cover all common frontend, backend, and config languages.

import { defaultRegistry } from '../../lib/repo-scanner/src/repoScanner/languageAdapters/AdapterRegistry'

export type LspLanguage =
  // Frontend
  | 'typescript' | 'javascript'
  | 'css' | 'scss' | 'less'
  | 'html'
  | 'vue'
  | 'svelte'
  | 'graphql'
  // Backend
  | 'python' | 'go' | 'rust'
  | 'java' | 'csharp'
  | 'php' | 'ruby' | 'kotlin' | 'swift' | 'dart'
  | 'c' | 'cpp'
  // Config / DevOps
  | 'json' | 'jsonc'
  | 'yaml'
  | 'toml'
  | 'bash' | 'shellscript'
  | 'dockerfile'
  | 'lua'
  | 'sql'

const ADAPTER_NAME_TO_LSP: Record<string, LspLanguage> = {
  TypeScript: 'typescript',
  Python:     'python',
  Go:         'go',
  Java:       'java',
  'C#':       'csharp',
  Ruby:       'ruby',
  PHP:        'php',
  Kotlin:     'kotlin',
  Swift:      'swift',
  Dart:       'dart',
  Rust:       'rust',
  Lua:        'lua',
}

// Extension → LSP language. Covers all languages that don't have a
// registered LanguageAdapter, plus overrides for edge cases.
const EXTENSION_TO_LSP: Record<string, LspLanguage> = {
  // C / C++
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  // CSS variants
  css: 'css', scss: 'scss', less: 'less',
  // Markup
  html: 'html', htm: 'html',
  // Component frameworks
  vue: 'vue',
  svelte: 'svelte',
  // GraphQL
  graphql: 'graphql', gql: 'graphql',
  // Config
  json: 'json', jsonc: 'jsonc',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  // Shell
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  // DevOps (no real extension for Dockerfile — handled below)
  lua: 'lua',
  sql: 'sql',
  // Dart / Swift / Kotlin / Ruby / PHP (adapters may not be registered yet)
  dart: 'dart',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  php: 'php', phtml: 'php',
}

export function getLspLanguageForPath(filePath: string): LspLanguage | null {
  const basename = filePath.split('/').pop() ?? filePath
  // Dockerfile has no extension
  if (basename === 'Dockerfile' || basename.startsWith('Dockerfile.')) return 'dockerfile'

  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const byExtension = EXTENSION_TO_LSP[ext]
  if (byExtension) return byExtension

  const adapter = defaultRegistry.getForPath(filePath)
  return (ADAPTER_NAME_TO_LSP[adapter.name] ?? null) as LspLanguage | null
}
