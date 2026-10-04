// services/appRegistry/types.ts
//
// Shared types for the Installed App Registry (Part 1 of the desktop
// app-control work — see services/appRegistry/appRegistryService.ts for
// the session cache and services/appRegistry/openApp.ts for how open_app
// consumes it). The Running Window Registry (Part 2 — PID/HWND tracking
// of *currently open* windows) is a separate, sibling concern living in
// services/windowRegistry/ and does not belong in this file.

/** Matches the Rust `AppKind` enum in src-tauri/src/app_registry.rs. */
export type AppKind = 'win32' | 'packaged'

/** An installed application, as surfaced to the rest of the app (camelCase). */
export interface InstalledApp {
  /** Display name, e.g. "Google Chrome", "Calculator". */
  name: string
  kind: AppKind
  /**
   * What to hand to `launchInstalledApp()` to start this app: a .lnk/.exe
   * path for `kind: 'win32'`, or a `shell:AppsFolder\<AppUserModelID>`
   * moniker for `kind: 'packaged'`.
   */
  launchTarget: string
  /**
   * The packaged app's AppUserModelID (`PackageFamilyName!AppId`) — the
   * identifier Windows needs to relaunch a Store/packaged app reliably,
   * since it has no single "exe path" the way a Win32 app does. Present
   * only when `kind === 'packaged'`.
   */
  appUserModelId?: string
  /** Where this entry was found: "start_apps" | "start_menu" | "app_paths". */
  source: string
}

/** Raw shape returned by the Rust `scan_installed_apps` command
 *  (snake_case, as Tauri serializes Rust struct fields verbatim). */
export interface TauriInstalledApp {
  name: string
  kind: AppKind
  launch_target: string
  app_user_model_id?: string | null
  source: string
}
