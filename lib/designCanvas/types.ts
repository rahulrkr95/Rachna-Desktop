// lib/designCanvas/types.ts
//
// Shared, serializable data model for the Design Canvas — the infinite
// board that is the primary artifact of a Design Project. Kept in its own
// module (rather than inline in the store or the view) so three things
// stay in lockstep without duplicating shape definitions:
//
//   1. store/useDesignCanvasStore.ts    (live in-app state)
//   2. lib/designCanvas/projectFile.ts  (the on-disk .rachna_design manifest)
//   3. components/viewers/DesignCanvasView.tsx (rendering)
//
// `DesignCanvasNode` is deliberately a discriminated-union-ready shape
// (`kind` today is always 'file') so future node kinds — comments,
// connections between pages, AI-generated additions — can be added later
// without changing the manifest format or breaking existing saved
// projects; a reader that only understands 'file' nodes can safely ignore
// node kinds it doesn't recognize.

/** Node kinds that exist today. Reserved for the future (not implemented
 *  yet, but the manifest's `edges`/`comments` arrays below already carve
 *  out space for them without a version bump): 'comment' | 'group'. */
export type DesignCanvasNodeKind = 'file'

export interface DesignCanvasNode {
  /** Stable identifier for this node. For a 'file' node this is always
   *  equal to `filePath`, so looking a node up by path is just an id
   *  lookup — but kept as a separate field so future non-file node kinds
   *  (which have no natural file path) don't need to fake one. */
  id: string
  kind: DesignCanvasNodeKind
  /** Absolute on-disk path once the project is saved, or an
   *  `unsaved://...` virtual path (see store/useUnsavedProjectStore.ts)
   *  while the project only exists in memory. */
  filePath: string
  name: string
  /** Lowercased extension without the dot, e.g. "html". */
  fileType: string
  x: number
  y: number
  width: number
  height: number
  status: 'pending' | 'ready' | 'error'
}

export interface DesignCanvasTransform {
  x: number
  y: number
  scale: number
}

/** Reserved for future "connections between pages" — not created or read
 *  anywhere yet, but included in the manifest shape now so adding the
 *  feature later doesn't require a manifest version bump. */
export interface DesignCanvasEdge {
  id: string
  fromNodeId: string
  toNodeId: string
}

/** Reserved for future per-node comments — same rationale as
 *  DesignCanvasEdge above. */
export interface DesignCanvasComment {
  id: string
  nodeId: string
  text: string
  createdAt: number
}

export const DESIGN_PROJECT_FILE_EXT = 'rachna_design'
export const DESIGN_PROJECT_MANIFEST_NAME = `design.${DESIGN_PROJECT_FILE_EXT}`
export const DESIGN_PROJECT_FORMAT = 'rachna-design-project' as const

/**
 * The `.rachna_design` project file. This IS the Design Project as far as
 * the user is concerned (they open/save "the canvas"); the HTML/CSS/JS
 * pages it references remain ordinary files on disk underneath it,
 * unlocked by every existing file/project tool (file tree, git, editor).
 */
export interface DesignProjectManifest {
  format: typeof DESIGN_PROJECT_FORMAT
  /** Bump only on a breaking shape change. New optional fields (like the
   *  edges/comments arrays above) don't require a bump. */
  version: 1
  projectName: string
  createdAt: number
  updatedAt: number
  canvas: {
    transform: DesignCanvasTransform
    nodes: DesignCanvasNode[]
    edges: DesignCanvasEdge[]
    comments: DesignCanvasComment[]
  }
}
