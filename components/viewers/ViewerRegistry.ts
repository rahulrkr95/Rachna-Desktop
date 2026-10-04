// components/viewers/ViewerRegistry.ts
//
// Central registry that decides which viewer component should render a
// given file, based on its extension and/or the MIME type / `kind`
// returned by the Tauri `read_file` command.
//
// This is the single source of truth for "what kind of file is this" so
// EditorPane doesn't need to duplicate extension lists.

import { isDesignCanvasTabId } from '../../lib/designCanvasTab'

export type ViewerKind = 'text' | 'html' | 'image' | 'pdf' | 'audio' | 'video' | 'binary' | 'design'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const PDF_EXTS   = new Set(['pdf'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])
const HTML_EXTS  = new Set(['html', 'htm'])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

/**
 * Determine which viewer should be used for a file.
 *
 * Priority:
 * 1. Extension-based match (images/pdf/audio/video) — fast, deterministic.
 * 2. MIME-based match — covers files whose extension we don't recognise
 *    but the backend identified as image/audio/video/pdf.
 * 3. `kind` from the backend:
 *    - "text"   → Monaco text/code editor
 *    - "base64" → previewable binary that didn't match 1/2 (shouldn't
 *                  normally happen, but fall back to binary info panel)
 *    - "binary" → file-info panel (size, type, modified date)
 * 4. Default → text editor (covers files with no extension and no
 *    backend info, e.g. brand-new untitled tabs).
 *
 * The Design Canvas is a virtual tab (id === DESIGN_CANVAS_TAB_ID), so it
 * short-circuits every other check — it has no extension/mime worth
 * inspecting.
 */
export function resolveViewer(opts: {
  id?: string
  name: string
  mime?: string
  kind?: 'text' | 'base64' | 'binary' | 'design'
}): ViewerKind {
  const { id, name, mime = '', kind } = opts

  if (kind === 'design' || isDesignCanvasTabId(id)) return 'design'

  const ext = extOf(name)

  if (IMAGE_EXTS.has(ext) || mime.startsWith('image/')) return 'image'
  if (PDF_EXTS.has(ext) || mime === 'application/pdf')  return 'pdf'
  if (AUDIO_EXTS.has(ext) || mime.startsWith('audio/')) return 'audio'
  if (VIDEO_EXTS.has(ext) || mime.startsWith('video/')) return 'video'
  if (HTML_EXTS.has(ext) || mime === 'text/html')       return 'html'

  if (kind === 'text') return 'text'
  if (kind === 'binary') return 'binary'
  if (kind === 'base64') return 'binary' // previewable type we didn't recognise above

  // No backend info at all (e.g. a brand-new file not yet saved) — edit as text.
  return 'text'
}

/** Build a `data:` URL for base64 content given a MIME type. */
export function toDataUrl(mime: string, base64: string): string {
  const safeMime = mime || 'application/octet-stream'
  return `data:${safeMime};base64,${base64}`
}
