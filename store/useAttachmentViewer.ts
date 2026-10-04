// store/useAttachmentViewer.ts
//
// Tiny global store backing the "code attachment" viewer panel. Long code
// blocks in AI chat responses (see MarkdownRenderer's CodeBlock) render as
// a compact file-attachment chip instead of being dumped inline — clicking
// one opens its content here, in a slide-over panel, mirroring how
// Claude/ChatGPT surface long generated files as attachments rather than
// cluttering the message stream.
//
// Deliberately global (not component state) because the panel itself is
// mounted once at the AiChat root, while the chips that open it live deep
// inside individual messages.

import { create } from 'zustand'

export interface AttachmentPayload {
  id:      string   // stable id (content hash) — reused to re-focus the same attachment
  fileName: string
  lang:    string
  content: string
}

interface AttachmentViewerState {
  open:     boolean
  current:  AttachmentPayload | null

  openAttachment:  (payload: AttachmentPayload) => void
  closeAttachment: () => void
}

export const useAttachmentViewer = create<AttachmentViewerState>((set) => ({
  open:    false,
  current: null,

  openAttachment: (payload) => set({ open: true, current: payload }),
  closeAttachment: () => set({ open: false }),
}))

// ── Stable id helper ────────────────────────────────────────────────────
// Cheap non-cryptographic hash (djb2) so the same code block content always
// maps to the same attachment id — re-clicking a chip re-focuses the panel
// (and re-opening the same content in the editor reuses the same tab)
// instead of creating duplicates.
export function hashContent(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
