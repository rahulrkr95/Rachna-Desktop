import { useEffect, useRef, useState } from 'react'
import Editor, { OnMount, OnChange } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { setDiagnosticsProvider } from '../services/agent/tools/diagnosticsTool'
import { createMonacoDiagnosticsProvider, notifyDiagnosticsChanged } from '../services/diagnostics/MonacoDiagnosticsProvider'
import { createLspDiagnosticsProvider } from '../services/diagnostics/LspDiagnosticsProvider'
import { createCompositeDiagnosticsProvider } from '../services/diagnostics/CompositeDiagnosticsProvider'
import { useInlineAutocomplete } from '../services/autocomplete'
import { useRepoIndex } from '../store/useRepoIndex'
import { getLspLanguageForPath } from '../services/lsp/languageMap'
import { registerLspProviders } from '../services/lsp/MonacoLspProviders'
import { ensureLspStarted } from '../services/lsp/LspClient'
import { syncDocumentOpen, syncDocumentChange, syncDocumentClose } from '../services/lsp/LspDocumentSync'
import { filePathToUri } from '../services/lsp/lspTranslate'
import type { LspLanguage } from '../services/lsp/languageMap'

// ── Rachna dark theme definition ────────────────────────────────────────────
const RACHNA_THEME: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment',                  foreground: '4d6a8a', fontStyle: 'italic' },
    { token: 'keyword',                  foreground: '00d4ff' },
    { token: 'keyword.control',          foreground: '00d4ff' },
    { token: 'string',                   foreground: 'a3e635' },
    { token: 'string.template',          foreground: 'a3e635' },
    { token: 'number',                   foreground: 'fb923c' },
    { token: 'type',                     foreground: 'a78bfa' },
    { token: 'type.identifier',          foreground: 'a78bfa' },
    { token: 'variable',                 foreground: 'e2e8f0' },
    { token: 'variable.predefined',      foreground: '00d4ff' },
    { token: 'function',                 foreground: '38bdf8' },
    { token: 'identifier',               foreground: 'e2e8f0' },
    { token: 'delimiter',                foreground: '94a3b8' },
    { token: 'tag',                      foreground: '00d4ff' },
    { token: 'attribute.name',           foreground: 'a78bfa' },
    { token: 'attribute.value',          foreground: 'a3e635' },
    { token: 'operator',                 foreground: '94a3b8' },
  ],
  colors: {
    'editor.background':            '#0d1117',
    'editor.foreground':            '#e2e8f0',
    'editor.lineHighlightBackground': '#1a2332',
    'editor.selectionBackground':   '#1e3250',
    'editor.inactiveSelectionBackground': '#162540',
    'editorCursor.foreground':      '#00d4ff',
    'editorLineNumber.foreground':  '#3d5268',
    'editorLineNumber.activeForeground': '#7a95b0',
    'editorIndentGuide.background': '#1e2d3d',
    'editorIndentGuide.activeBackground': '#2a3d52',
    'editorBracketMatch.background': '#1e3250',
    'editorBracketMatch.border':    '#00d4ff44',
    'editorGutter.background':      '#0d1117',
    'editor.wordHighlightBackground': '#1e3250aa',
    'editorWidget.background':      '#111827',
    'editorWidget.border':          '#1e2d3d',
    'editorSuggestWidget.background': '#111827',
    'editorSuggestWidget.border':   '#1e2d3d',
    'editorSuggestWidget.selectedBackground': '#1e3250',
    'input.background':             '#0d1117',
    'input.border':                 '#1e2d3d',
    'focusBorder':                  '#00d4ff44',
    'scrollbar.shadow':             '#00000000',
    'scrollbarSlider.background':   '#1e2d3d88',
    'scrollbarSlider.hoverBackground': '#1e2d3dcc',
    // Ghost text (inline AI autocomplete) — dim cyan to differentiate from typed text
    'editorGhostText.foreground':   '#3d7a8a',
    'editorGhostText.background':   '#00000000',
  },
}

const BASE_MONACO_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  lineHeight:      22,
  fontFamily:      "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  fontLigatures:   true,
  minimap:         { enabled: true, scale: 1, showSlider: 'mouseover' },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking:  'smooth',
  cursorSmoothCaretAnimation: 'on',
  padding:         { top: 16, bottom: 16 },
  tabSize:         2,
  insertSpaces:    true,
  wordWrap:        'off',
  renderLineHighlight: 'line',
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  renderWhitespace: 'selection',
  bracketPairColorization: { enabled: true },
  guides: {
    bracketPairs: true,
    indentation: true,
  },
  suggest: {
    showKeywords: true,
    showSnippets: true,
  },
  quickSuggestions: {
    other:    true,
    comments: false,
    strings:  false,
  },
  // Inline ghost-text suggestions (AI autocomplete via InlineSuggest API)
  inlineSuggest: {
    enabled:     true,
    mode:        'prefix',
    showToolbar: 'always',
  },
}

// ── LANG_MAP: file extension → Monaco language id ───────────────────────────
const LANG_MAP: Record<string, string> = {
  ts:   'typescript',
  tsx:  'typescript',
  js:   'javascript',
  jsx:  'javascript',
  css:  'css',
  scss: 'scss',
  json: 'json',
  md:   'markdown',
  html: 'html',
  yaml: 'yaml',
  yml:  'yaml',
  go:   'go',
  py:   'python',
  sh:   'shell',
  txt:  'plaintext',
  java: 'java',
  cs:   'csharp',
  c:    'c',
  h:    'c',
  cpp:  'cpp',
  cc:   'cpp',
  cxx:  'cpp',
  hpp:  'cpp',
  hh:   'cpp',
  rs:   'rust',
  rb:   'ruby',
  php:  'php',
  kt:   'kotlin',
  kts:  'kotlin',
  swift: 'swift',
  sql:  'sql',
  xml:  'xml',
  m:    'objective-c',
  scala: 'scala',
  dart: 'dart',
  lua:  'lua',
  r:    'r',
  pl:   'perl',
  vb:   'vb',
  toml: 'ini',
  dockerfile: 'dockerfile',
  ini:  'ini',
  cfg:  'ini',
  conf: 'ini',
  bat:  'bat',
  cmd:  'bat',
  ps1:  'powershell',
  graphql: 'graphql',
  gql:  'graphql',
  proto: 'protobuf',
}

export function extToLang(ext: string): string {
  return LANG_MAP[ext.toLowerCase()] ?? 'plaintext'
}

// ── Global editor instance ref (for menu bar Edit actions) ───────────────────
// IDELayout reads this to trigger undo/redo/cut/copy/paste/find on the active
// Monaco editor without needing prop drilling through the full component tree.
export const globalEditorRef: { current: editor.IStandaloneCodeEditor | null } = { current: null }

// ── Props ────────────────────────────────────────────────────────────────────
interface MonacoEditorProps {
  /** Controlled value — the text content displayed in the editor */
  value: string
  /** Called on every keystroke with the updated content */
  onChange?: (value: string) => void
  /** Monaco language id (e.g. 'typescript', 'css'). Defaults to 'typescript' */
  language?: string
  /** File path used to display in the editor title bar (optional) */
  filePath?: string
  /** Font size in px. Defaults to 13. Changing this live-updates the editor. */
  fontSize?: number
  /** Theme */
  theme?: 'dark' | 'light'
  /** Enable AI inline ghost-text autocomplete (Cursor-style). Default: true */
  autocompleteEnabled?: boolean
}

// ── Component ────────────────────────────────────────────────────────────────
export default function MonacoEditor({
  value,
  onChange,
  language = 'typescript',
  filePath,
  fontSize = 13,
  theme = 'dark',
  autocompleteEnabled = true,
}: MonacoEditorProps) {
  // Keep a stable ref to the editor instance so we can update options live
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  // Ref to the marker-change subscription so we can dispose on unmount
  const markerSubRef = useRef<{ dispose(): void } | null>(null)
  // True once handleMount has run — used to (re-)trigger LSP wiring effects
  // for files opened/switched before the editor finished mounting.
  const [mounted, setMounted] = useState(false)
  // Tracks the document currently synced to an LSP server, so handleChange
  // and the unmount/file-switch cleanup know what to send didChange/didClose for.
  const lspStateRef = useRef<{ language?: LspLanguage; uri?: string }>({})
  const lspChangeTimerRef = useRef<number | null>(null)

  // Project root drives which workspace an LSP server is spawned for.
  const projectRoot = useRepoIndex(s => s.projectRoot)

  // ── Inline AI autocomplete (Cursor-style ghost text) ─────────────────
  const { setEditor: setAutocompleteEditor } = useInlineAutocomplete()

  // Clean up marker subscription when component unmounts
  useEffect(() => {
    return () => {
      markerSubRef.current?.dispose()
      markerSubRef.current = null
      if (globalEditorRef.current === editorRef.current) {
        globalEditorRef.current = null
      }
    }
  }, [])

  // Live-update font size without remounting the editor
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize })
  }, [fontSize])

  // Live-update theme
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(theme === 'dark' ? 'rachnaTheme' : 'vs')
    }
  }, [theme])

  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance
    monacoRef.current = monaco
    globalEditorRef.current = editorInstance

    // Register the Rachna dark theme once per session
    monaco.editor.defineTheme('rachnaTheme', RACHNA_THEME)
    monaco.editor.setTheme(theme === 'dark' ? 'rachnaTheme' : 'vs')

    // Apply initial font size
    editorInstance.updateOptions({ fontSize })

    // TypeScript compiler options — strict mode, modern target
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target:        monaco.languages.typescript.ScriptTarget.ESNext,
      module:        monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx:           monaco.languages.typescript.JsxEmit.ReactJSX,
      strict:        true,
      esModuleInterop: true,
    })

    // Suppress overly-noisy diagnostics for in-browser use
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation:   false,
    })

    // ── Wire up real diagnostics provider ──────────────────────────────
    // Done once at mount time — subsequent get_diagnostics tool calls will
    // use the Monaco marker API + TS worker (+ LSP, for Python/Go) rather
    // than returning empty data.
    setDiagnosticsProvider(
      createCompositeDiagnosticsProvider([
        createMonacoDiagnosticsProvider(monaco),
        createLspDiagnosticsProvider(),
      ])
    )

    // ── Subscribe to marker changes for reactive diagnostics ───────────
    // Monaco fires onDidChangeMarkers whenever TS worker or any language
    // service updates squiggles — we forward this as a signal so that any
    // pending get_diagnostics call sees fresh data after an edit settles.
    const markerSub = monaco.editor.onDidChangeMarkers(() => {
      notifyDiagnosticsChanged()
    })
    markerSubRef.current = markerSub

    // ── Register inline AI autocomplete provider ──────────────────────
    // Only wire up when enabled (default: true). The hook handles
    // debouncing, cancellation, caching, and Tab/Esc keybindings
    // via Monaco's native InlineSuggest API.
    if (autocompleteEnabled) {
      const filename = filePath
        ? filePath.split('/').pop() ?? filePath
        : 'untitled'
      setAutocompleteEditor(editorInstance, monaco, filename)
    }

    // Give focus so the user can type immediately
    editorInstance.focus()

    // Unblocks the [filePath, projectRoot, mounted] LSP wiring effect below,
    // which can't run meaningfully until monacoRef is populated.
    setMounted(true)
  }

  const handleChange: OnChange = (val) => {
    if (onChange && val !== undefined) onChange(val)

    // Forward edits to the LSP server (Python/Go only — no-op otherwise
    // since lspStateRef stays empty for other languages).
    const { language, uri } = lspStateRef.current
    if (language && uri && val !== undefined) {
      if (lspChangeTimerRef.current !== null) window.clearTimeout(lspChangeTimerRef.current)
      lspChangeTimerRef.current = window.setTimeout(() => {
        syncDocumentChange(language, uri, val).catch(() => {
          // LSP sync is advisory — a dropped didChange must never block typing.
        })
      }, 300)
    }
  }

  // ── LSP wiring: register providers once per language, sync document
  //    open/close as the active file changes ────────────────────────────
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco || !mounted || !filePath || !projectRoot) return undefined

    const lspLanguage = getLspLanguageForPath(filePath)
    if (!lspLanguage) {
      lspStateRef.current = {}
      return undefined
    }

    registerLspProviders(monaco, lspLanguage, projectRoot)

    const uri = filePathToUri(filePath)
    lspStateRef.current = { language: lspLanguage, uri }

    ensureLspStarted(lspLanguage, projectRoot)
      .then(() => {
        if ((lspLanguage === 'typescript' || lspLanguage === 'javascript') && monacoRef.current) {
          // The real LSP (typescript-language-server) now owns diagnostics
          // for this language — turn off Monaco's built-in TS worker
          // diagnostics so we don't get duplicate/conflicting squiggles.
          // (Worker-based hover/completion/etc. are untouched; only the
          // diagnostics options are affected.)
          monacoRef.current.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation:   true,
          })
        }
        return syncDocumentOpen(lspLanguage, projectRoot, uri, value)
      })
      .catch(() => {
        // Server failed to start (missing binary, etc.) — hover/definition/
        // references will just degrade silently; nothing further to do here.
        // Monaco's built-in TS worker diagnostics stay enabled in this case
        // (set at mount time) so TS/JS files still get basic syntax checking.
      })

    return () => {
      if (lspChangeTimerRef.current !== null) window.clearTimeout(lspChangeTimerRef.current)
      syncDocumentClose(lspLanguage, uri).catch(() => {})
    }
    // `value` intentionally excluded — only used for the one-shot didOpen
    // snapshot when switching files; live edits flow through handleChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, projectRoot, mounted])

  // Derive a stable Monaco model URI from the file path.
  // Monaco's `path` prop accepts either a URI string or a plain path; using
  // `file://` prefix ensures model.uri.fsPath works correctly on all platforms.
  const monacoPath = filePath
    ? /^file:\/\//i.test(filePath)
      ? filePath                            // already a URI
      : `file://${filePath.startsWith('/') ? '' : '/'}${filePath.replace(/\\/g, '/')}`
    : undefined

  return (
    <Editor
      height="100%"
      width="100%"
      language={language}
      value={value}
      path={monacoPath}        // Canonical file:// URI — drives model identity + undo stacks
      theme={theme === 'dark' ? 'rachnaTheme' : 'vs'}
      options={{ ...BASE_MONACO_OPTIONS, fontSize }}
      onMount={handleMount}
      onChange={handleChange}
      loading={
        <div style={{
          display:    'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height:     '100%',
          fontFamily: 'var(--font-code)',
          fontSize:   12,
          color:      '#3d5268',
          background: '#0d1117',
        }}>
          Loading editor…
        </div>
      }
    />
  )
}
