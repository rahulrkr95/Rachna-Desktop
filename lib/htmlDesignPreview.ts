// lib/htmlDesignPreview.ts
//
// Thin wrapper around the `render_html_design_preview` Tauri command that
// powers the HTML editor's Design view (components/viewers/HtmlDesignView.tsx).
// The current buffer is written to a temp file and rendered through the same
// Playwright sidecar the agent's `browser_check` tool uses
// (lib/browser-tool/run.js), headless this time so toggling to Design never
// pops up a visible OS browser window.

import { invoke } from '@tauri-apps/api/core'

export interface HtmlDesignPreviewResult {
  ok: boolean
  error?: string
  /** Base64-encoded PNG of the rendered page. */
  screenshotBase64?: string
  pageErrors?: string[]
  durationMs?: number
}

export async function renderHtmlDesignPreview(params: {
  content: string
  /** Directory the file lives in on disk, so relative sibling assets (co-located
   *  css/js) resolve. Omit for unsaved in-memory files — falls back to the OS temp dir. */
  baseDir?: string | null
  width?: number
  height?: number
}): Promise<HtmlDesignPreviewResult> {
  return invoke<HtmlDesignPreviewResult>('render_html_design_preview', {
    args: {
      content:  params.content,
      base_dir: params.baseDir ?? null,
      width:    params.width,
      height:   params.height,
    },
  })
}
