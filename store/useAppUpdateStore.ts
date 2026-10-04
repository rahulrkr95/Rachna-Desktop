// store/useAppUpdateStore.ts
//
// Wires up Tauri's real auto-updater (@tauri-apps/plugin-updater). This
// store asks the updater plugin directly (GET /api/app/update/
//     :target/:version — see tauri.conf.json) whether a newer *signed*
// build exists, and can download + install it in place, then relaunch.
//
// checkForUpdate() is called once, a few seconds after launch, from
// App.tsx — deliberately not blocking startup and not gating anything.
// If nothing is signed/published yet (see backend migration
// 003_release_signature.sql), the endpoint just 204s and this quietly
// stays `status: 'up-to-date'`.

import { create } from 'zustand'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

interface AppUpdateState {
  status: AppUpdateStatus
  version: string | null
  notes: string | null
  progressPercent: number | null
  error: string | null

  checkForUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
}

// The Update handle itself isn't serializable/state-friendly (it carries
// its own download/install methods), so it's kept out-of-band here rather
// than in the zustand store, keyed by nothing since only one check is ever
// in flight at a time.
let pendingUpdate: Update | null = null

export const useAppUpdateStore = create<AppUpdateState>((set) => ({
  status: 'idle',
  version: null,
  notes: null,
  progressPercent: null,
  error: null,

  checkForUpdate: async () => {
    set({ status: 'checking', error: null })
    try {
      const update = await check()
      if (!update) {
        pendingUpdate = null
        set({ status: 'up-to-date' })
        return
      }
      pendingUpdate = update
      set({
        status: 'available',
        version: update.version,
        notes: update.body ?? null,
      })
    } catch (e) {
      console.warn('[useAppUpdateStore] update check failed:', e)
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  installUpdate: async () => {
    if (!pendingUpdate) return
    set({ status: 'downloading', progressPercent: 0, error: null })

    let totalBytes = 0
    let downloadedBytes = 0

    try {
      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            totalBytes = event.data.contentLength ?? 0
            break
          case 'Progress':
            downloadedBytes += event.data.chunkLength
            set({
              progressPercent: totalBytes > 0
                ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
                : null,
            })
            break
          case 'Finished':
            set({ progressPercent: 100 })
            break
        }
      })
      set({ status: 'ready' })
    } catch (e) {
      console.error('[useAppUpdateStore] download/install failed:', e)
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },
}))

// Restarts into the newly-installed version. Kept as a standalone export
// (rather than folded into installUpdate) so the UI can show a "Restart
// now" button and let the person save work first instead of relaunching
// out from under them immediately after the install finishes.
export async function restartToApplyUpdate(): Promise<void> {
  await relaunch()
}
