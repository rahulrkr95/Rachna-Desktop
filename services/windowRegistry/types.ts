// services/windowRegistry/types.ts
//
// Shared types for the Running Window Registry (Part 2 of the desktop
// app-control work — see services/appRegistry/types.ts for Part 1, the
// Installed App Registry, which this is a sibling of, not a replacement
// for). Backs services/windowRegistry/windowRegistryService.ts (the scan
// + cache layer) and services/windowRegistry/matching.ts (ranking a
// free-text app name/executable/title query against a scan result).

/** Matches the Rust `WindowState` enum in src-tauri/src/window_registry.rs. */
export type WindowState = 'normal' | 'minimized' | 'maximized'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A currently visible, top-level application window, as surfaced to the
 *  rest of the app (camelCase). The `pid` here is the pid Windows reports
 *  as actually owning the window — not necessarily the pid a caller
 *  originally launched (see the module doc comment in window_registry.rs
 *  for why those two can differ). */
export interface RunningWindow {
  /** Opaque, stable-for-this-scan window identifier (stringified HWND). */
  hwnd: string
  pid: number
  title: string
  /** Executable/process name, e.g. "notepad.exe". */
  exeName: string
  bounds: WindowBounds
  visible: boolean
  state: WindowState
}

/** Raw shape returned by the Rust `list_visible_windows` /
 *  `find_windows_by_pid` commands (snake_case, as Tauri serializes Rust
 *  struct fields verbatim). */
export interface TauriRunningWindow {
  hwnd: string
  pid: number
  title: string
  exe_name: string
  bounds: WindowBounds
  visible: boolean
  state: WindowState
}
