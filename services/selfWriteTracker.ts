// services/selfWriteTracker.ts
//
// The Rust file-watcher (watcher.rs) reports EVERY change under the project
// root — including the app's own writes (Ctrl+S, AI edit merges, batch
// merges, reverts). Those already trigger their own explicit re-index call
// at the point of writing (see store/useRepoIndex.ts's reindexFile /
// forceReindex), so re-indexing them AGAIN off the watcher event would be
// redundant, and — now that unrecognised watcher events surface an
// "external changes" notification (see ExternalChangesStore) — would also
// incorrectly prompt the user to reindex for a change *they* just made
// inside the IDE.
//
// This module is the choke point that lets the watcher tell the two apart:
// every in-app write registers its path here immediately before/after the
// `save_file` invoke; the watcher event handler checks (and consumes) that
// registration to decide whether a given path is "self" or "external".
//
// A short TTL is used rather than an exact one-shot correlation because the
// watcher event arrives asynchronously (debounced ~300ms on the Rust side,
// +200ms client debounce) after the write completes — there's no request id
// to join on, just "did we write this path ourselves a moment ago?".

const SELF_WRITE_TTL_MS = 4000

const recentSelfWrites = new Map<string, number>()

function normalize(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Call immediately after this app writes `path` to disk itself. */
export function registerSelfWrite(path: string): void {
  recentSelfWrites.set(normalize(path), Date.now())
}

/**
 * Returns true (and consumes the entry) if `path` was written by this app
 * within the last SELF_WRITE_TTL_MS. Consuming prevents a stale entry from
 * masking a *later*, genuinely external edit to the same file.
 */
export function isSelfWrite(path: string): boolean {
  const key = normalize(path)
  const at = recentSelfWrites.get(key)
  if (at === undefined) return false

  recentSelfWrites.delete(key)
  return Date.now() - at <= SELF_WRITE_TTL_MS
}

/** Housekeeping: drop stale entries so the map can't grow unbounded. */
export function pruneSelfWrites(): void {
  const cutoff = Date.now() - SELF_WRITE_TTL_MS
  for (const [key, at] of recentSelfWrites) {
    if (at < cutoff) recentSelfWrites.delete(key)
  }
}
