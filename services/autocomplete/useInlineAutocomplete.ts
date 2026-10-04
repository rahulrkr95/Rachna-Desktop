// services/autocomplete/useInlineAutocomplete.ts
//
// React hook — call once per MonacoEditor mount.
// Registers a Monaco InlineCompletionsProvider that:
//   • Debounces AI calls (300 ms default)
//   • Cancels in-flight requests on new keystrokes
//   • Reads the active provider + API key + model from the IDE stores
//   • Caches recent completions via AutocompleteService
//   • Cleans up the provider registration on unmount
//
// Usage:
//   const { setEditor } = useInlineAutocomplete()
//   // in handleMount:  setEditor(editorInstance, monacoInstance)

import { useRef, useCallback, useEffect } from 'react'
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor'
import type * as Monaco from 'monaco-editor'
import { AutocompleteService, buildContext } from './AutocompleteService'
import { useApiKeyStore, useSelectedModel } from '../../store/useApiKeyStore'
import { getProvider } from '../../lib/providers/registry'

// ── Constants ──────────────────────────────────────────────────────────────

/** Debounce delay in ms — balances latency vs unnecessary API calls. */
const DEBOUNCE_MS = 300

/** Languages where autocomplete should be active. */
const ENABLED_LANGUAGES = new Set([
  'typescript', 'javascript', 'python', 'go', 'rust',
  'css', 'scss', 'html', 'json', 'markdown', 'yaml',
  'shell', 'plaintext',
])

// ── Hook ───────────────────────────────────────────────────────────────────

export interface UseInlineAutocompleteReturn {
  /** Call this in your Monaco onMount handler. */
  setEditor: (
    editorInstance: MonacoEditor.IStandaloneCodeEditor,
    monacoInstance: typeof Monaco,
    filename?: string,
  ) => void
  /** Wipe the completion cache (e.g. after accepting a large AI edit). */
  invalidateCache: () => void
}

export function useInlineAutocomplete(): UseInlineAutocompleteReturn {
  const editorRef   = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef   = useRef<typeof Monaco | null>(null)
  const filenameRef = useRef<string>('untitled')
  const disposeRef  = useRef<IDisposable | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Read store state via refs so provider callbacks stay stable ──────────
  const storeRef = useRef({
    activeProviderId: '',
    getActiveKey: useApiKeyStore.getState().getActiveKey,
    selectedModel: '',
  })

  // Keep storeRef in sync without causing re-renders in the provider callback
  useEffect(() => {
    const unsub = useApiKeyStore.subscribe(state => {
      storeRef.current.activeProviderId = state.activeProviderId
      storeRef.current.getActiveKey     = state.getActiveKey
    })
    return unsub
  }, [])

  // selectedModel is a derived value — we read it from the store directly
  const selectedModel = useSelectedModel()
  useEffect(() => {
    storeRef.current.selectedModel = selectedModel
  }, [selectedModel])

  // ── Build the autocomplete service (stable across renders) ───────────────
  const serviceRef = useRef<AutocompleteService>(
    new AutocompleteService(
      () => {
        const id = storeRef.current.activeProviderId
        return getProvider(id)
      },
      () => {
        const { activeProviderId, getActiveKey } = storeRef.current
        return getActiveKey(activeProviderId)?.value ?? ''
      },
      () => storeRef.current.selectedModel,
    )
  )

  // ── Register the provider whenever editor + monaco are set ───────────────
  const registerProvider = useCallback((
    editorInstance: MonacoEditor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
    filename: string,
  ) => {
    // Dispose previous registration
    disposeRef.current?.dispose()
    disposeRef.current = null

    const service = serviceRef.current

    const provider: Monaco.languages.InlineCompletionsProvider = {
      // Called by Monaco when it wants inline suggestions
      provideInlineCompletions(
        model: Monaco.editor.ITextModel,
        position: Monaco.Position,
        _context: Monaco.languages.InlineCompletionContext,
        token: Monaco.CancellationToken,
      ): Promise<Monaco.languages.InlineCompletions | null> {
        const lang = model.getLanguageId()
        if (!ENABLED_LANGUAGES.has(lang)) return Promise.resolve(null)

        return new Promise(resolve => {
          // Clear any pending debounced call
          if (debounceRef.current) {
            clearTimeout(debounceRef.current)
            service.cancel()
          }

          debounceRef.current = setTimeout(async () => {
            // If Monaco already cancelled (user typed again), bail out
            if (token.isCancellationRequested) {
              resolve(null)
              return
            }

            const ctx = buildContext(model, position, filename)

            // Don't trigger on empty prefix or pure whitespace lines
            const currentLine = model.getLineContent(position.lineNumber)
            const textBeforeCursor = currentLine.slice(0, position.column - 1)
            if (!textBeforeCursor.trim() && ctx.prefix.trimEnd().endsWith('\n')) {
              resolve(null)
              return
            }

            try {
              const result = await service.complete(ctx)

              if (!result || !result.text || token.isCancellationRequested) {
                resolve(null)
                return
              }

              resolve({
                items: [
                  {
                    insertText: result.text,
                    // Range defaults to cursor insertion point
                  },
                ],
              })
            } catch {
              resolve(null)
            }
          }, DEBOUNCE_MS)
        })
      },

      // Called when a completion is accepted or dismissed — required by interface
      freeInlineCompletions(_completions: Monaco.languages.InlineCompletions): void {
        // Nothing to free for our string-based completions
      },

      // Called when the user accepts a completion (Tab)
      handleItemDidShow(
        _completions: Monaco.languages.InlineCompletions,
        _item: Monaco.languages.InlineCompletion,
      ): void {
        // Could add telemetry here
      },
    }

    // Register for every language (we filter inside provideInlineCompletions)
    disposeRef.current = monaco.languages.registerInlineCompletionsProvider(
      { pattern: '**' },
      provider,
    )

    // Ensure inline suggestions are enabled in the editor options
    editorInstance.updateOptions({
      inlineSuggest: {
        enabled: true,
        mode: 'prefix',       // show ghost text as prefix of the typed word
        showToolbar: 'always', // small accept/dismiss toolbar on hover
      },
    })
  }, [])

  // ── Public API ────────────────────────────────────────────────────────────

  const setEditor = useCallback((
    editorInstance: MonacoEditor.IStandaloneCodeEditor,
    monacoInstance: typeof Monaco,
    filename = 'untitled',
  ) => {
    editorRef.current   = editorInstance
    monacoRef.current   = monacoInstance
    filenameRef.current = filename
    registerProvider(editorInstance, monacoInstance, filename)
  }, [registerProvider])

  const invalidateCache = useCallback(() => {
    serviceRef.current.invalidateCache()
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disposeRef.current?.dispose()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      serviceRef.current.cancel()
    }
  }, [])

  return { setEditor, invalidateCache }
}
