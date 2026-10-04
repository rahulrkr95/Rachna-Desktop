// lib/designCanvas/content.ts
//
// A Design Canvas node's underlying file can live in two places depending
// on whether the Design Project has been saved yet:
//   - on disk (real absolute path)               → read via lib/tauriFs
//   - only in memory (an `unsaved://...` path)    → read from
//     store/useUnsavedProjectStore.ts, the same source EditorPane and
//     FileExplorer already use for unsaved projects.
//
// This is the one place that branches on that, so DesignCanvasView's
// render pipeline (renderHtmlDesignPreview) doesn't need to know which
// source a given node came from.

import { readFile } from '../tauriFs'
import { isUnsavedProjectPath, useUnsavedProjectStore } from '../../store/useUnsavedProjectStore'

export interface ResolvedNodeContent {
  content: string
  /** Directory the file lives in, for resolving co-located relative
   *  assets — null for unsaved (in-memory) files, matching
   *  HtmlDesignView's dirnameOrNull convention (falls back to the OS temp
   *  dir inside render_html_design_preview). */
  baseDir: string | null
}

export async function resolveDesignNodeContent(filePath: string): Promise<ResolvedNodeContent> {
  if (isUnsavedProjectPath(filePath)) {
    const file = useUnsavedProjectStore.getState().files[filePath]
    return { content: file?.content ?? '', baseDir: null }
  }
  const read = await readFile(filePath)
  const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  return { content: read.content, baseDir: dir || null }
}
