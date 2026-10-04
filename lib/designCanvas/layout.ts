// lib/designCanvas/layout.ts
//
// Pure layout math for auto-arranging Design Canvas nodes into a grid —
// used both when a brand-new node needs a default position (a file just
// got generated and has no saved position yet) and by the explicit
// "Arrange" toolbar action that re-flows every node. Extracted from
// DesignCanvasView so store/useDesignCanvasStore.ts can place new nodes
// at a sensible slot the moment they're created, without importing the view.

export const NODE_WIDTH = 320
/** Matches render_html_design_preview's default viewport aspect ratio. */
export const NODE_ASPECT = 1280 / 800
export const NODE_HEIGHT = Math.round(NODE_WIDTH / NODE_ASPECT)
export const NODE_GAP = 48
export const GRID_COLUMNS = 4

export interface GridPoint {
  x: number
  y: number
}

/** The default grid slot for the Nth node (0-indexed). */
export function gridPosition(index: number): GridPoint {
  return {
    x: (index % GRID_COLUMNS) * (NODE_WIDTH + NODE_GAP),
    y: Math.floor(index / GRID_COLUMNS) * (NODE_HEIGHT + NODE_GAP + 32),
  }
}
