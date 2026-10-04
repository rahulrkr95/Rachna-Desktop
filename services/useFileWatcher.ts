/**
 * useFileWatcher
 *
 * Mounts / unmounts the Tauri `watch_project` command whenever the open
 * project root changes.  Listens for `file-watcher://changed` events emitted
 * by the Rust watcher and splits each batch of changed paths into:
 *
 *   - self-writes:  paths this app itself just wrote (Ctrl+S, AI edit
 *                    merges, reverts — see selfWriteTracker.ts). These are
 *                    dropped silently; the call site that wrote them already
 *                    triggered its own reindex.
 *   - external:      everything else — changes made outside the IDE (another
 *                    editor, a CLI tool, `git checkout`, a build script,
 *                    etc). These are handed to `useExternalChangesStore`,
 *                    which surfaces a top-bar notification rather than
 *                    silently reindexing, so the user knows why the index
 *                    might be stale and can choose when to pay the reindex
 *                    cost.
 *
 * Design notes
 * ────────────
 * • A 200 ms client-side debounce is applied on top of the Rust-side 300 ms
 *   debounce.  This prevents a burst of rapid saves (e.g. "save all" in the
 *   IDE) from queuing up multiple concurrent scan_repo_files calls.
 *
 * • The hook is intentionally side-effect-only: it returns nothing.  Wire it
 *   in once near the top of IDELayout (or another singleton component).
 *
 * • If the Tauri `watch_project` command rejects (e.g. path not found), the
 *   error is logged to console but the rest of the IDE is unaffected.
 *
 * • The hook is a no-op in a browser / non-Tauri environment (where
 *   `isTauri()` from `@tauri-apps/api/core` returns false) so unit tests
 *   and Storybook remain clean.
 */

import { useEffect, useRef } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useRepoIndex } from '../store/useRepoIndex'
import { useGitStore } from '../store/useGitStore'
import { useExternalChangesStore } from './externalChanges/ExternalChangesStore'
import { isSelfWrite, pruneSelfWrites } from './selfWriteTracker'

/** Payload shape emitted by the Rust watcher. */
interface WatcherEvent {
  paths: string[]
}

/**
 * True when running inside a Tauri WebView.
 *
 * `window.__TAURI__` is only injected when `app.withGlobalTauri` is set in
 * tauri.conf.json — it isn't here — so checking for it was always false,
 * even inside the built desktop app, which made this whole hook a silent
 * permanent no-op (no file watching, no external-change detection, ever).
 * `isTauri()` from `@tauri-apps/api/core` reads `globalThis.isTauri`, which
 * the Tauri runtime always sets regardless of `withGlobalTauri`.
 */
const isRunningInTauri = (): boolean =>
  typeof window !== 'undefined' && isTauri()

export function useFileWatcher(): void {
  const projectRoot          = useRepoIndex(s => s.projectRoot)
  const gitRefreshStatus     = useGitStore(s => s.refreshStatus)
  const reportExternalChanges = useExternalChangesStore(s => s.reportExternalChanges)

  // Pending paths accumulated during the client-side debounce window.
  const pendingPaths  = useRef<string[]>([])
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isRunningInTauri() || !projectRoot) {
      useExternalChangesStore.getState().reset()
      return
    }

    let unlisten: UnlistenFn | null = null
    let mounted = true

    /**
     * Flush the accumulated paths, splitting out this app's own writes
     * (silently dropped — already reindexed at the point of writing) from
     * genuinely external changes (surfaced via the notification banner).
     */
    const flush = () => {
      if (pendingPaths.current.length === 0) return
      const batch = [...pendingPaths.current]
      pendingPaths.current = []

      pruneSelfWrites()
      const external = batch.filter(p => !isSelfWrite(p))
      if (external.length > 0) {
        reportExternalChanges(external)
      }
    }

    /** Schedule a flush after the quiet window. */
    const schedule = (paths: string[]) => {
      pendingPaths.current.push(...paths)
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current)
      }
      debounceTimer.current = setTimeout(flush, 200)
    }

    ;(async () => {
      try {
        // Start the Rust watcher for this project root.
        await invoke('watch_project', { root: projectRoot })

        if (!mounted) {
          // Component unmounted while we were awaiting — clean up immediately.
          await invoke('unwatch_project').catch(() => {})
          return
        }

        // Subscribe to watcher events.
        unlisten = await listen<WatcherEvent>(
          'file-watcher://changed',
          (event) => {
            if (mounted && event.payload?.paths?.length) {
              schedule(event.payload.paths)
              // Also refresh git status so source control reflects file changes
              // made by the agent or external tools without an explicit Ctrl+S.
              gitRefreshStatus().catch(() => { /* non-fatal */ })
            }
          },
        )
      } catch (err) {
        console.error('[useFileWatcher] failed to start watcher:', err)
      }
    })()

    // Cleanup: cancel debounce, unsubscribe event listener, stop Rust watcher.
    return () => {
      mounted = false

      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current)
        debounceTimer.current = null
      }
      pendingPaths.current = []

      if (unlisten) {
        unlisten()
        unlisten = null
      }

      invoke('unwatch_project').catch(() => {})
      useExternalChangesStore.getState().reset()
    }
  }, [projectRoot]) // Re-run whenever the user opens a different project.
}
