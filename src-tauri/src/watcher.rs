// src-tauri/src/watcher.rs
//
// Incremental file-watcher commands.
//
// `watch_project(root)`
//   Starts a debounced recursive watcher on `root`.  Any file-system events
//   (create / modify / rename) that survive a 300 ms quiet window are batched
//   and emitted to the renderer as a `file-watcher://changed` event carrying
//   a JSON array of absolute paths:
//
//     payload: { paths: ["/abs/path/to/foo.ts", ...] }
//
//   Only paths whose extension the repo-scanner recognises are forwarded;
//   events on node_modules, .git, build artefacts, and binary files are
//   filtered out before the event reaches the renderer.
//
// `unwatch_project()`
//   Stops the active watcher (if any).  Safe to call when no watcher is
//   running — it is a no-op in that case.
//
// Architecture
// ────────────
// The watcher runs on its own Tokio task.  A `Mutex<Option<WatcherHandle>>`
// in Tauri's managed state stores the JoinHandle + a shutdown channel so
// `unwatch_project` can cleanly cancel it.
//
// We deliberately keep the debounce window short (300 ms) rather than
// waiting for a full save cycle because the user may save from an external
// editor.  The renderer de-duplicates repeated events itself through the
// debounce built into `useFileWatcher.ts`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use tauri::{AppHandle, Emitter, State};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Debounce quiet-period.  Events are batched and emitted once no new
/// event has arrived for this long.
const DEBOUNCE_MS: u64 = 300;

/// Directories that should never trigger a re-index.
const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    "target",
    ".cache",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "coverage",
];

/// Extensions the repo-scanner actually cares about (must stay in sync with
/// scanner's DEFAULT_EXTENSIONS + ADAPTER_EXTS sets).
const SCANNER_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mts", "mjs",
    "py", "pyi",
    "go",
    "java",
    "cs",
    "rs",
    "html", "htm",
    "css", "scss",
];

// ── Managed state ─────────────────────────────────────────────────────────────

/// Holds a shutdown sender so the watcher task can be cancelled.
pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

struct WatcherHandle {
    /// Sending on this channel signals the watcher task to stop.
    shutdown_tx: std::sync::mpsc::SyncSender<()>,
}

impl WatcherState {
    pub fn new() -> Self {
        WatcherState {
            inner: Mutex::new(None),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn path_is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        IGNORE_DIRS.iter().any(|ign| s == *ign)
    })
}

fn path_has_scanner_ext(path: &Path) -> bool {
    if let Some(filename) = path.file_name().and_then(|f| f.to_str()) {
        let lower = filename.to_lowercase();
        if lower == "dockerfile" || lower.starts_with("dockerfile.") {
            return true;
        }
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SCANNER_EXTS.iter().any(|se| *se == e))
        .unwrap_or(false)
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Start watching `root` for file-system changes.
/// Replaces any previously active watcher (idempotent).
#[tauri::command]
pub fn watch_project(
    app: AppHandle,
    root: String,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    // Stop any existing watcher first.
    stop_watcher(&state);

    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err(format!("watch_project: path does not exist: {root}"));
    }

    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::sync_channel::<()>(1);

    let app_clone = app.clone();

    std::thread::spawn(move || {
        // The debouncer lives on this thread.  It calls our closure from its
        // internal thread so we use a channel to forward events back here
        // (avoids moving AppHandle into the closure, which isn't Send on all
        // platforms before Tauri 2.1).
        let (event_tx, event_rx) =
            std::sync::mpsc::sync_channel::<Vec<PathBuf>>(64);

        let mut debouncer = match new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            move |result: DebounceEventResult| {
                let events = match result {
                    Ok(events) => events,
                    Err(errs) => {
                        eprintln!("[watcher] debounce error: {errs:?}");
                        return;
                    }
                };

                let paths: Vec<PathBuf> = events
                    .into_iter()
                    .map(|e| e.path)
                    .filter(|p| p.is_file())
                    .filter(|p| !path_is_ignored(p))
                    .filter(|p| path_has_scanner_ext(p))
                    .collect::<HashSet<_>>() // de-dup within a batch
                    .into_iter()
                    .collect();

                if !paths.is_empty() {
                    let _ = event_tx.try_send(paths);
                }
            },
        ) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[watcher] failed to create debouncer: {e}");
                return;
            }
        };

        if let Err(e) = debouncer
            .watcher()
            .watch(&root_path, RecursiveMode::Recursive)
        {
            eprintln!("[watcher] watch failed: {e}");
            return;
        }

        println!("[watcher] watching: {}", root_path.display());

        // Forward batched events to the renderer until shutdown.
        loop {
            // Non-blocking check for shutdown first.
            if shutdown_rx.try_recv().is_ok() {
                break;
            }

            // Wait up to 100 ms for a batch of changed paths.
            match event_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(paths) => {
                    let str_paths: Vec<String> = paths
                        .iter()
                        .filter_map(|p| p.to_str().map(str::to_owned))
                        .collect();

                    if str_paths.is_empty() {
                        continue;
                    }

                    // Emit to all renderer windows.
                    if let Err(e) = app_clone.emit(
                        "file-watcher://changed",
                        serde_json::json!({ "paths": str_paths }),
                    ) {
                        eprintln!("[watcher] emit error: {e}");
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // No events — loop and check shutdown again.
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // Event sender dropped — watcher went away unexpectedly.
                    break;
                }
            }
        }

        println!("[watcher] stopped watching: {}", root_path.display());
        // `debouncer` is dropped here which stops the underlying watcher.
    });

    *state.inner.lock().unwrap() = Some(WatcherHandle { shutdown_tx });
    Ok(())
}

/// Stop the active file watcher (no-op if none is running).
#[tauri::command]
pub fn unwatch_project(state: State<'_, WatcherState>) -> Result<(), String> {
    stop_watcher(&state);
    Ok(())
}

fn stop_watcher(state: &State<'_, WatcherState>) {
    let mut guard = state.inner.lock().unwrap();
    if let Some(handle) = guard.take() {
        // Best-effort: the thread exits cleanly on next loop iteration.
        let _ = handle.shutdown_tx.try_send(());
    }
}
