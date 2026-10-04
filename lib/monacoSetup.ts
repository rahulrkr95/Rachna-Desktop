// lib/monacoSetup.ts
//
// BUG FIX: "files never open in the editor — Monaco spins on 'Loading
// editor…' forever."
//
// Root cause: @monaco-editor/react's default loader fetches the Monaco
// bundle from a public CDN (jsdelivr) at runtime via a dynamically-injected
// <script> tag. This app's Tauri CSP (see src-tauri/tauri.conf.json) is
// `default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'
// ipc: asset: https://api.anthropic.com ...` — jsdelivr is on neither
// allow-list, so the browser silently blocks the request. The loader's
// promise never resolves or rejects (it just hangs), so every <Editor>
// stays stuck on its `loading` fallback indefinitely. No console-visible
// crash, no network tab entry past the blocked request — just an infinite
// spinner, exactly matching the reported symptom.
//
// Fix: self-host Monaco instead of fetching it from a CDN. `monaco-editor`
// is already a direct dependency (package.json) — we just need to point
// @monaco-editor/react's loader at that local module instead of the CDN,
// and give Monaco its own web workers (also same-origin/blob:, which the
// CSP's `worker-src 'self' blob:'` already permits).
//
// This module has side effects (sets `self.MonacoEnvironment` and calls
// `loader.config`) and must be imported ONCE, before the first <Editor>
// ever mounts — see the import at the top of main.tsx.

import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'

// Vite's `?worker` suffix bundles each of these as a separate same-origin
// worker chunk instead of resolving them through Monaco's normal AMD/CDN
// loader path.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

// Tell @monaco-editor/react to use this locally-bundled `monaco` instance
// instead of dynamically injecting a CDN <script> tag.
loader.config({ monaco })
