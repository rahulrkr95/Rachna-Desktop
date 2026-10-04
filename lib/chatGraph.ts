// lib/chatGraph.ts
//
// CHAT-004: Versioned Chat Response Branches.
//
// Pure, framework-free helpers for treating a conversation's flat list of
// `DbMessage` rows (see lib/conversationMemory.ts) as a message TREE:
//   - Every message has a `parent_id` (null only for the root).
//   - Multiple messages may share a `parent_id` — that's a "version"
//     (an edited user message, or a regenerated assistant reply).
//   - The conversation's `current_leaf_id` marks the tip of whichever
//     branch is currently being displayed. The displayed transcript is
//     just the chain of `parent_id` pointers from that leaf back to the
//     root, reversed.
//
// useChat.ts owns a live `GraphNode[]` array (kept in sync as messages are
// persisted) and calls these helpers to derive the displayed path and the
// prev/next version info shown in the UI.

export interface GraphNode {
  id: string
  parent_id: string | null
  /** "user" | "assistant" | "tool" */
  role: string
  content: string
  created_at: string
  /**
   * CHAT-005: opaque JSON blob of non-text ChatMessage fields (plan,
   * step statuses, agent activity chips, images, etc.) — see
   * DbMessage.metadata in lib/conversationMemory.ts. Passed through
   * unmodified by every helper in this file; only useChat.ts's
   * pathToChatMessages actually parses it.
   */
  metadata?: string | null
}

/** Sentinel key used for the top level of `childrenMap` (nodes with no parent). */
const ROOT_KEY = '__root__'

/**
 * Groups every node by its parent, preserving creation order within each
 * sibling group — sibling order IS version order (`1 / 3`, `2 / 3`, ...).
 */
export function buildChildrenMap(nodes: GraphNode[]): Map<string, string[]> {
  const sorted = [...nodes].sort((a, b) => {
    if (a.created_at === b.created_at) return 0
    return a.created_at < b.created_at ? -1 : 1
  })
  const map = new Map<string, string[]>()
  for (const n of sorted) {
    const key = n.parent_id ?? ROOT_KEY
    const arr = map.get(key)
    if (arr) arr.push(n.id)
    else map.set(key, [n.id])
  }
  return map
}

/**
 * Walks `parent_id` pointers from `leafId` back to the root and returns the
 * chain in chronological (root-first) order — i.e. the transcript that
 * should be displayed for that branch. Returns `[]` if `leafId` is null or
 * not found (e.g. a brand-new, still-empty conversation).
 */
export function buildPathToLeaf(nodes: GraphNode[], leafId: string | null): GraphNode[] {
  if (!leafId) return []
  const byId = new Map(nodes.map(n => [n.id, n]))
  const path: GraphNode[] = []
  const visited = new Set<string>() // cycle guard — should never trigger, but never trust stored data blindly
  let cur: string | null = leafId
  while (cur) {
    if (visited.has(cur)) break
    visited.add(cur)
    const node: GraphNode | undefined = byId.get(cur)
    if (!node) break
    path.push(node)
    cur = node.parent_id
  }
  return path.reverse()
}

/**
 * Follows the MOST RECENT child at each level (last sibling = most
 * recently created branch) starting from `startId`, until reaching a node
 * with no children. Used when switching to a different version of a
 * message that already has its own downstream history recorded — we want
 * to land on whatever was last actively being viewed/authored under it,
 * not just the bare node with no reply shown yet.
 */
export function deepestDescendant(childrenMap: Map<string, string[]>, startId: string): string {
  let cur = startId
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const kids = childrenMap.get(cur)
    if (!kids || kids.length === 0) return cur
    cur = kids[kids.length - 1]
  }
}

export interface VersionInfo {
  /** 0-based position of this node among its siblings. */
  index: number
  /** Total number of sibling versions (including this one). */
  count: number
  /** Sibling ids in version order, oldest first. */
  siblingIds: string[]
}

/**
 * Returns version info (`{ index, count, siblingIds }`) for `nodeId` if it
 * has sibling versions (a parent with more than one child), else `null` —
 * callers use `null` to mean "don't show prev/next nav for this message".
 */
export function getVersionInfo(
  childrenMap: Map<string, string[]>,
  nodes: GraphNode[],
  nodeId: string
): VersionInfo | null {
  const node = nodes.find(n => n.id === nodeId)
  if (!node) return null
  const key = node.parent_id ?? ROOT_KEY
  const siblingIds = childrenMap.get(key) ?? [nodeId]
  if (siblingIds.length <= 1) return null
  const index = siblingIds.indexOf(nodeId)
  return { index: index === -1 ? 0 : index, count: siblingIds.length, siblingIds }
}

/**
 * Computes the new `current_leaf_id` that results from moving to the
 * `direction` (-1 = prev, +1 = next) sibling version of `nodeId`. Returns
 * `null` if there's nowhere to move (no siblings, or already at the edge).
 */
export function switchVersion(
  childrenMap: Map<string, string[]>,
  nodes: GraphNode[],
  nodeId: string,
  direction: -1 | 1
): string | null {
  const info = getVersionInfo(childrenMap, nodes, nodeId)
  if (!info) return null
  const newIndex = info.index + direction
  if (newIndex < 0 || newIndex >= info.count) return null
  const targetSibling = info.siblingIds[newIndex]
  return deepestDescendant(childrenMap, targetSibling)
}
