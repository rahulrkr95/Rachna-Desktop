// lib/designCanvasTab.ts
//
// The Design Canvas now opens as a normal editor tab — a *virtual* file
// living at the well-known id `design://canvas` — instead of taking over
// the left sidebar. It's rendered by EditorPane the same way Monaco/PDF/
// Image/etc. viewers are: ViewerRegistry recognises this id and routes it
// to DesignCanvasView (see components/viewers/ViewerRegistry.ts and
// components/EditorPane.tsx).
//
// This file is the single source of truth for that virtual id/descriptor
// so useDesignCanvasStore, EditorPane, and ViewerRegistry never drift out
// of sync on what "the Design Canvas tab" actually is.

import type { OpenFile } from '../types'

/** Virtual id for the Design Canvas tab — never a real path on disk. */
export const DESIGN_CANVAS_TAB_ID = 'design://canvas'

/** Tab bar label for the Design Canvas tab. */
export const DESIGN_CANVAS_TAB_NAME = 'Design Canvas'

/** True if `id` refers to the virtual Design Canvas tab. */
export function isDesignCanvasTabId(id: string | null | undefined): boolean {
  return id === DESIGN_CANVAS_TAB_ID
}

/**
 * Builds the OpenFile descriptor for the Design Canvas tab, ready to hand
 * to useEditorStore's `openTab`. Content is empty — DesignCanvasView reads
 * all of its actual data (nodes/transform/projectRoot) from
 * useDesignCanvasStore, not from the tab's `content` field.
 */
export function designCanvasTabDescriptor(): Omit<OpenFile, 'active'> {
  return {
    id:       DESIGN_CANVAS_TAB_ID,
    name:     DESIGN_CANVAS_TAB_NAME,
    lang:     'design',
    content:  '',
    modified: false,
    kind:     'design',
    mime:     'application/x-rachna-design-canvas',
  }
}
