use reqwest::header;
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::Emitter;

// Async process + buffered I/O for non-blocking scanner spawn
use tokio::io::{AsyncBufReadExt, BufReader as AsyncBufReader};
use tokio::process::Command as AsyncCommand;

use crate::db;
use crate::process_ext::NoWindow;
use crate::process_utils::{managed_node_bin, managed_node_path_entry, resolve_executable, with_managed_node_path};

// ── Scan event payload types ───────────────────────────────────────────────────
//
// Emitted by scan_repo / scan_repo_files while the scanner subprocess is running.
// Frontend subscribers (IndexingOverlay) listen for these to drive the live
// progress bar and file counter.

/// Emitted every N files (or as heartbeat ticks when the sidecar emits no
/// structured progress).  `total == 0` means the total file count is not
/// yet known.
#[derive(serde::Serialize, Clone)]
pub struct ScanProgressPayload {
    pub scanned: u32,
    pub total:   u32,
    pub file:    String,
}

/// Emitted once when the scanner subprocess exits successfully and all chunks
/// have been persisted to SQLite.
#[derive(serde::Serialize, Clone)]
pub struct ScanCompletePayload {
    pub ok: bool,
}

/// Emitted when the scanner subprocess exits with a non-zero code or the
/// output cannot be parsed as valid JSON.
#[derive(serde::Serialize, Clone)]
pub struct ScanErrorPayload {
    pub message: String,
}

// ── Error type ────────────────────────────────────────────────────────────────
// We return a plain String on error so Tauri can serialise it to JS cleanly.
type CmdResult<T> = Result<T, String>;

fn io_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ── local_data_dir ───────────────────────────────────────────────────────────
//
// Resolves the directory used for all IDE-local data (SQLite chunk/embedding
// database, chat history, managed Node runtime, etc).
//
// Historically this used Tauri's `app_data_dir()`, which resolves to the OS
// "roaming app data" convention — e.g. `%APPDATA%\com.rachnaai.ide` on
// Windows, which always lives on the system drive regardless of where the
// app itself is installed. For a portable/self-contained install (e.g.
// installed to a D: drive or a USB/external drive), that split is
// unexpected: users want the app's data to travel with the install, not be
// silently written to the system drive.
//
// Instead, we store everything in a `data` folder next to the running
// executable — i.e. inside the install location itself. This makes the
// install fully self-contained and portable: copying/moving the install
// folder brings its data with it.
pub(crate) fn local_data_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve executable path: {e}"))?;
    let install_dir = exe_path
        .parent()
        .ok_or_else(|| "Cannot resolve install directory from executable path".to_string())?;
    let dir = install_dir.join("data");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create local data directory at {}: {e}", dir.display()))?;
    Ok(dir)
}

// ── resolve_scanner_js ───────────────────────────────────────────────────────
//
// Locates lib/repo-scanner/dist/run.js. Tries, in order: cwd-relative (dev
// mode), the Tauri resource dir (packaged app), and the dir next to the
// running executable (fallback for bundle layouts where resource_dir isn't
// where resources actually landed).
//
// On failure the error lists every full path that was actually checked and
// whether resource_dir() itself resolved — this used to just say "Scanner
// not found", which was useless for diagnosing *why* a packaged Windows
// build couldn't find it (wrong resource_dir? file genuinely missing from
// the installer? a Windows MAX_PATH truncation inside node_modules?). With
// the full candidate list in the error, that's now visible directly in the
// chat/error toast instead of requiring a debug build to investigate.
fn resolve_scanner_js(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    let scanner_suffix = ["lib", "repo-scanner", "dist", "run.js"];

    let resource_dir_result = app.path().resource_dir();
    let candidate_resource = resource_dir_result
        .as_ref()
        .ok()
        .map(|d| scanner_suffix.iter().fold(d.clone(), |p, s| p.join(s)));

    let project_root = std::env::current_dir()
        .unwrap_or_default()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let candidate_cwd = scanner_suffix
        .iter()
        .fold(project_root, |p, s| p.join(s));

    let candidate_exe = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| {
            scanner_suffix.iter().fold(p.to_path_buf(), |acc, s| acc.join(s))
        }));

    let candidates: Vec<PathBuf> = [
        Some(candidate_cwd),
        candidate_resource,
        candidate_exe,
    ]
    .into_iter()
    .flatten()
    .collect();

    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| {
            let tried = candidates
                .iter()
                .map(|p| format!("  - {}", p.display()))
                .collect::<Vec<_>>()
                .join("\n");
            let resource_dir_note = match &resource_dir_result {
                Ok(d) => format!("resource_dir() = {}", d.display()),
                Err(e) => format!("resource_dir() failed: {e}"),
            };
            format!(
                "Scanner not found (lib/repo-scanner/dist/run.js).\n\
                 {resource_dir_note}\n\
                 Paths checked:\n{tried}\n\
                 If this is a packaged build, the resource likely wasn't bundled \
                 (check tauri.conf.json → bundle.resources) or a Windows path-length \
                 limit truncated files under lib/repo-scanner/node_modules during install. \
                 In dev, run: npm run scanner:build (from the project root)"
            )
        })
}

fn project_db_path_for_scanner(app: &tauri::AppHandle, root: &str) -> CmdResult<String> {
    let base_data_dir = local_data_dir(app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    let project_dir = db::project_data_dir(&base_data_dir, root);
    db::init_project_db(&project_dir)
        .map_err(|e| format!("Failed to initialise project database: {e}"))?;
    Ok(project_dir.join("project.db").to_string_lossy().into_owned())
}

// ── scan_repo ─────────────────────────────────────────────────────────────────
//
// Runs the repo-scanner CLI (`node dist/run.js <root> --json`) as a
// subprocess, returns the raw ScanResult JSON string to the renderer, AND
// persists chunks into SQLite so the IDE can later retrieve them for AI chat.
//
// New behaviour (compared with the original):
//   After the scanner subprocess succeeds, we:
//     1. Parse the JSON ScanResult.
//     2. For each FileNode that has `rawContent` (embedded inline), split into
//        overlapping 100-line chunks with a 20-line overlap.
//     3. Delete existing chunks for that file path (idempotent re-index).
//     4. Insert fresh chunks into `chunks` + `chunks_fts`.
//
// The raw JSON is still returned unchanged so the renderer's existing
// DependencyGraphEngine / Zustand store continue to work exactly as before.
#[tauri::command]
pub async fn scan_repo(app: tauri::AppHandle, root: String) -> CmdResult<String> {
    // ── 1. Locate dist/run.js ─────────────────────────────────────────────
    let scanner_js = resolve_scanner_js(&app)?;

    let scanner_js = scanner_js
        .to_string_lossy()
        .replace(r"\\?\", "");


    println!("Scanning repo: {}", root);

    // ── 2. Validate project root ──────────────────────────────────────────
    let root_path = PathBuf::from(&root);
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!("Project root does not exist or is not a directory: {root}"));
    }

    let root = root_path
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .map(|s| s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned())
        .unwrap_or(root);

    // ── 3. Resolve `node` ─────────────────────────────────────────────────
    let node_exe = find_node()?;
    println!("NODE EXE = {:?}", node_exe);
    println!("SCANNER JS = {:?}", scanner_js);
    println!("ROOT ARG = {:?}", root);

    // ── 4. Spawn scanner (non-blocking) ───────────────────────────────────
    //
    // We use tokio::process::Command so the async runtime is never blocked
    // while waiting on the node subprocess.  stdout / stderr are streamed
    // line-by-line so we can:
    //   a) Forward structured progress lines emitted by the sidecar as
    //      `scan-progress` events (future-proof: current sidecar emits none).
    //   b) Run a 400 ms heartbeat task that emits synthetic progress ticks
    //      so IndexingOverlay has live feedback even today.
    let mut child = AsyncCommand::new(&node_exe)
        .arg(scanner_js.as_str())
        .arg(&root)
        .arg("--json")
        .arg("--sqlite-db")
        .arg(project_db_path_for_scanner(&app, &root)?)
        .no_window()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn node ({node_exe:?}): {e}"))?;

    let child_stdout = child.stdout.take().expect("stdout was piped");
    let child_stderr = child.stderr.take().expect("stderr was piped");

    // ── 4a. Heartbeat progress task ───────────────────────────────────────
    // Sends `scan-progress` every 400 ms with a synthetic counter so the
    // overlay has live updates before real progress lines (if any) arrive.
    let (hb_tx, hb_rx) = tokio::sync::watch::channel(false);
    {
        let app_hb = app.clone();
        let mut hb_rx = hb_rx;
        tokio::spawn(async move {
            let mut tick = 0u32;
            let mut iv = tokio::time::interval(std::time::Duration::from_millis(400));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Mark the initial false as "seen" so changed() only fires on cancel.
            hb_rx.borrow_and_update();
            loop {
                tokio::select! {
                    biased;
                    Ok(_) = hb_rx.changed() => break,
                    _ = iv.tick() => {
                        tick += 1;
                        let _ = app_hb.emit("scan-progress", ScanProgressPayload {
                            scanned: tick,
                            total:   0,
                            file:    String::new(),
                        });
                    }
                }
            }
        });
    }

    // ── 4b. Read stdout line-by-line ──────────────────────────────────────
    // Lines that parse as `{"type":"progress",...}` are forwarded as real
    // scan-progress events (emitted every EMIT_EVERY files to cap IPC).
    // All other lines are accumulated into stdout_accum for JSON extraction.
    const EMIT_EVERY: u32 = 5;
    let mut lines = AsyncBufReader::new(child_stdout).lines();
    let mut stdout_accum = String::new();
    let mut scanned_real: u32 = 0;

    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("progress") {
                scanned_real += 1;
                if scanned_real % EMIT_EVERY == 0 {
                    let _ = app.emit("scan-progress", ScanProgressPayload {
                        scanned: scanned_real,
                        total:   v["total"].as_u64().unwrap_or(0) as u32,
                        file:    v["file"].as_str().unwrap_or("").to_string(),
                    });
                }
                // Do NOT accumulate progress lines — they're not part of the JSON result.
                continue;
            }
        }
        stdout_accum.push_str(&line);
        stdout_accum.push('\n');
    }

    // Drain stderr
    let mut err_lines = AsyncBufReader::new(child_stderr).lines();
    let mut stderr_accum = String::new();
    while let Ok(Some(line)) = err_lines.next_line().await {
        stderr_accum.push_str(&line);
        stderr_accum.push('\n');
    }

    // Wait for the process to exit (already finished since stdout EOF)
    let exit_status = child.wait().await
        .map_err(|e| format!("Failed to wait on scanner process: {e}"))?;

    // Stop the heartbeat
    let _ = hb_tx.send(true);

    // ── 5. Check exit status ──────────────────────────────────────────────
    if !exit_status.success() {
        let msg = format!(
            "Scanner exited with code {:?}\nstderr: {stderr_accum}\nstdout: {stdout_accum}",
            exit_status.code()
        );
        let _ = app.emit("scan-error", ScanErrorPayload { message: msg.clone() });
        return Err(msg);
    }

    // ── 6. Extract JSON from accumulated stdout ───────────────────────────
    let json_start = stdout_accum
        .find('{')
        .ok_or_else(|| format!("No JSON found in scanner output:\n{stdout_accum}"))?;

    let json_str_owned = stdout_accum[json_start..].to_owned();

    // ── 6a. Patch projectRoot in the JSON to match the canonicalized root ─
    // The Rust side canonicalized `root` above (resolves symlinks, strips
    // the \\?\ UNC prefix on Windows).  Chunks are stored under this path.
    // The scanner subprocess may have resolved the path differently, so we
    // overwrite projectRoot in the returned JSON so the renderer's store
    // always holds the same value the SQLite file_path column uses.
    let json_str_owned = {
        match serde_json::from_str::<serde_json::Value>(&json_str_owned) {
            Ok(mut v) => {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "projectRoot".to_string(),
                        serde_json::Value::String(root.clone()),
                    );
                }
                serde_json::to_string(&v).unwrap_or(json_str_owned)
            }
            Err(_) => json_str_owned,
        }
    };

    // Chunks and symbols were streamed directly into SQLite by the scanner.

    // ── 8. Emit scan-complete and return patched JSON to renderer ─────────
    let _ = app.emit("scan-complete", ScanCompletePayload { ok: true });

    Ok(json_str_owned)
}

// ── scan_repo_files ───────────────────────────────────────────────────────────
//
// Incremental variant of scan_repo: runs the scanner scoped to a specific
// list of files rather than the entire project tree.  Used by the frontend's
// reindexChangedFiles action which is called from the file-watcher event
// handler.  Only the affected FileNodes are returned; the caller merges them
// into the existing ScanResult without a full re-scan.
//
// The scanner CLI is invoked with `--files <path1>,<path2>,...` (a flag that
// must be supported by lib/repo-scanner/dist/run.js v2+).
// If the flag is not yet supported, the CLI exits with a non-zero code and
// the frontend falls back to a full refreshGraph().
#[tauri::command]
pub async fn scan_repo_files(
    app: tauri::AppHandle,
    root: String,
    files: Vec<String>,
) -> CmdResult<String> {
    if files.is_empty() {
        return Err("scan_repo_files: empty file list".to_string());
    }

    // ── 1. Locate dist/run.js (same logic as scan_repo) ──────────────────
    let scanner_js = resolve_scanner_js(&app)?;

    let scanner_js = scanner_js
        .to_string_lossy()
        .replace(r"\\?\", "");

    // ── 2. Validate root ──────────────────────────────────────────────────
    let root_path = PathBuf::from(&root);
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!("Project root does not exist or is not a directory: {root}"));
    }

    let root = root_path
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .map(|s| s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned())
        .unwrap_or(root);

    // ── 3. Build --files argument ─────────────────────────────────────────
    // Paths joined by the platform path-list separator (comma works on all
    // platforms for our CLI; the scanner splits on comma).
    let files_arg = files.join(",");

    // ── 4. Resolve node + spawn (non-blocking) ────────────────────────────
    let node_exe = find_node()?;

    let mut child = AsyncCommand::new(&node_exe)
        .arg(scanner_js.as_str())
        .arg(&root)
        .arg("--json")
        .arg("--sqlite-db")
        .arg(project_db_path_for_scanner(&app, &root)?)
        .arg("--files")
        .arg(&files_arg)
        .no_window()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn node ({node_exe:?}): {e}"))?;

    let child_stdout = child.stdout.take().expect("stdout was piped");
    let child_stderr = child.stderr.take().expect("stderr was piped");

    // Heartbeat — same pattern as scan_repo but lighter (incremental scan)
    let (hb_tx, hb_rx) = tokio::sync::watch::channel(false);
    {
        let app_hb = app.clone();
        let mut hb_rx = hb_rx;
        tokio::spawn(async move {
            let mut tick = 0u32;
            let mut iv = tokio::time::interval(std::time::Duration::from_millis(400));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            hb_rx.borrow_and_update();
            loop {
                tokio::select! {
                    biased;
                    Ok(_) = hb_rx.changed() => break,
                    _ = iv.tick() => {
                        tick += 1;
                        let _ = app_hb.emit("scan-progress", ScanProgressPayload {
                            scanned: tick,
                            total:   0,
                            file:    String::new(),
                        });
                    }
                }
            }
        });
    }

    let mut lines = AsyncBufReader::new(child_stdout).lines();
    let mut stdout_accum = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        stdout_accum.push_str(&line);
        stdout_accum.push('\n');
    }

    let mut err_lines = AsyncBufReader::new(child_stderr).lines();
    let mut stderr_accum = String::new();
    while let Ok(Some(line)) = err_lines.next_line().await {
        stderr_accum.push_str(&line);
        stderr_accum.push('\n');
    }

    let exit_status = child.wait().await
        .map_err(|e| format!("Failed to wait on scanner process: {e}"))?;

    let _ = hb_tx.send(true);

    // ── 5. Check exit status + extract JSON ───────────────────────────────
    if !exit_status.success() {
        let msg = format!(
            "scan_repo_files exited with {:?}\nstderr: {stderr_accum}\nstdout: {stdout_accum}",
            exit_status.code()
        );
        let _ = app.emit("scan-error", ScanErrorPayload { message: msg.clone() });
        return Err(msg);
    }

    let json_start = stdout_accum
        .find('{')
        .ok_or_else(|| format!("No JSON found in scanner output:\n{stdout_accum}"))?;

    let json_str_owned = stdout_accum[json_start..].to_owned();

    // Patch projectRoot to the canonicalized value so the renderer store
    // stays in sync with what SQLite file_path columns contain.
    let json_str_owned = {
        match serde_json::from_str::<serde_json::Value>(&json_str_owned) {
            Ok(mut v) => {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "projectRoot".to_string(),
                        serde_json::Value::String(root.clone()),
                    );
                }
                serde_json::to_string(&v).unwrap_or(json_str_owned)
            }
            Err(_) => json_str_owned,
        }
    };

    // ── 6. Upsert only the changed chunks into SQLite ─────────────────────
    // BUG FIX: this used to resolve `local_data_dir(&app)` — the global,
    // un-scoped app-data dir — instead of the per-project dir `scan_repo`
    // writes the initial full index into. Every incremental re-scan (this
    // command, triggered by the file-watcher on save) was therefore
    // upserting chunks into the wrong, empty database: the per-project
    // index used for retrieval never got updated after a file changed, and
    // over a session would silently drift further out of date with every
    // edit. Same root cause as the search_repo_by_file / search_symbols fix
    // above — a project database dereferenced through the wrong helper.
    let base_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    let project_dir = db::project_data_dir(&base_data_dir, &root);
    db::init_project_db(&project_dir).map_err(|e| format!("Failed to initialise project database: {e}"))?;
    // Chunks and symbols were streamed directly into SQLite by the scanner.

    let _ = app.emit("scan-complete", ScanCompletePayload { ok: true });

    Ok(json_str_owned)
}

// ── fast_reindex_files ────────────────────────────────────────────────────────
//
// Pure-Rust incremental chunk refresh — no Node.js subprocess, no ts-morph.
//
// For each changed file path the command:
//   1. Loads existing symbol ranges from the `symbols` SQLite table so the
//      pure-Rust chunker can emit symbol-aligned chunks (same logic as the
//      full scan path — functions are never split mid-body).
//   2. Reads the file content from disk.
//   3. Produces new chunks via `db::make_chunks_symbol_aware`.
//   4. Loads stored chunk content hashes for that file.
//   5. Diffs new chunks against stored ones:
//        • unchanged (same id + same FNV hash) → skipped
//        • stale (id no longer in new set)      → deleted
//        • new / modified                        → upserted
//   6. Runs the whole delete+insert inside a single SQLite transaction.
//
// Returns JSON `{ updated, skipped, deleted }` for debug logging.
// On any error the frontend falls back to the full `scan_repo_files` path.
#[tauri::command]
pub async fn fast_reindex_files(
    app: tauri::AppHandle,
    files: Vec<String>,
    root: String,
) -> CmdResult<serde_json::Value> {
    if files.is_empty() {
        return Ok(serde_json::json!({ "updated": 0, "skipped": 0, "deleted": 0 }));
    }

    let base_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    let project_dir = db::project_data_dir(&base_data_dir, &root);
    let mut total_updated = 0usize;
    let mut total_skipped = 0usize;
    let mut total_deleted = 0usize;

    for file_path in &files {
        // ── Deleted files: purge all their chunks ─────────────────────────
        if !std::path::Path::new(file_path).exists() {
            match db::delete_file_chunks(&project_dir, file_path) {
                Ok(n) => { total_deleted += n; }
                Err(e) => eprintln!("fast_reindex: delete_file_chunks failed for {file_path}: {e}"),
            }
            continue;
        }

        // ── 1. Existing symbol ranges (for symbol-aware rechunking) ───────
        let symbol_ranges = db::get_file_symbol_ranges(&project_dir, file_path)
            .unwrap_or_default();

        // ── 2. Read file from disk ────────────────────────────────────────
        let content = match std::fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("fast_reindex: cannot read {file_path}: {e}");
                continue;
            }
        };

        // ── 3. Produce new chunks (pure Rust, no subprocess) ─────────────
        let new_chunks = db::make_chunks_symbol_aware(file_path, &content, &symbol_ranges);

        // ── 4. Load stored chunk hashes for this file ─────────────────────
        let stored_hashes = db::get_file_chunk_hashes(&project_dir, file_path)
            .unwrap_or_default();

        let unchanged = new_chunks
            .iter()
            .filter(|c| {
                stored_hashes
                    .get(&c.id)
                    .map(|h| {
                        // recompute hash the same way db does
                        const BASIS: u64 = 0xcbf2_9ce4_8422_2325;
                        const PRIME: u64 = 0x0000_0100_0000_01b3;
                        let hash = c.content.bytes().fold(BASIS, |acc, b| {
                            (acc ^ b as u64).wrapping_mul(PRIME)
                        });
                        format!("{hash:016x}") == *h
                    })
                    .unwrap_or(false)
            })
            .count();

        // ── 5. Diff + update in one transaction ───────────────────────────
        match db::diff_update_chunks(&project_dir, &stored_hashes, &new_chunks) {
            Ok((deleted, inserted)) => {
                total_deleted += deleted;
                total_updated += inserted;
                total_skipped += unchanged;
                println!(
                    "fast_reindex: {file_path} — {inserted} updated, {unchanged} skipped, {deleted} stale deleted"
                );
            }
            Err(e) => {
                eprintln!("fast_reindex: diff_update_chunks failed for {file_path}: {e}");
                // Surface the error so the frontend can fall back to scan_repo_files.
                return Err(format!("fast_reindex_files: {e}"));
            }
        }
    }

    Ok(serde_json::json!({
        "updated": total_updated,
        "skipped": total_skipped,
        "deleted": total_deleted,
    }))
}

// ── search_repo ───────────────────────────────────────────────────────────────
//
// Exposes the SQLite FTS5 search to the renderer.
//
// Parameters:
//   query  — FTS5 query string (porter-stemmed, prefix-search supported)
//   limit  — maximum results to return (default 20 if not supplied; capped at 50)
//
// Returns a JSON array of ChunkSearchResult objects.
// Does NOT call Gemini — retrieval only.
#[tauri::command]
pub async fn search_repo(
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
    project_root: Option<String>,
) -> CmdResult<Vec<db::ChunkSearchResult>> {
    let base_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    let effective_limit = (limit.unwrap_or(20) as usize).min(50);

    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let root = project_root.as_deref().unwrap_or("").trim_end_matches('/');
    // Each project has its own project.db now — the `root` LIKE-filtering
    // below becomes a harmless extra safety net rather than the only
    // thing preventing cross-project bleed.
    let project_dir = db::project_data_dir(&base_data_dir, root);

    // Pull a wider FTS5 candidate pool than `effective_limit` so the hybrid
    // re-rank below has something to work with beyond the raw bm25 order.
    let candidate_pool = (effective_limit * 3).max(30);

    let fts_scored = db::search_chunks_scored(&project_dir, &query, candidate_pool, root)
        .map_err(|e| format!("FTS search failed: {e}"))?;

    // ── Try semantic re-ranking ─────────────────────────────────────────
    // 1. Embed the query via Ollama. If that fails (server not running),
    //    fall straight back to FTS5-only results — no error surfaced.
    let query_vec = db::embed_chunk(&query, db::DEFAULT_OLLAMA_URL, db::DEFAULT_EMBED_MODEL).await;

    let Some(query_vec) = query_vec else {
        let results: Vec<db::ChunkSearchResult> = fts_scored
            .into_iter()
            .take(effective_limit)
            .map(|(mut c, _)| { c.search_mode = "fts5_only".to_string(); c })
            .collect();
        return Ok(results);
    };

    let all_embeddings = db::ann_search_chunks(&project_dir, &query_vec, candidate_pool, root)
        .map_err(|e| format!("ANN search failed: {e}"))?;

    if all_embeddings.is_empty() {
        // Nothing embedded yet (repo not re-indexed since enabling
        // semantic search, or Ollama was down during scan_repo) — fall
        // back to FTS5-only.
        let results: Vec<db::ChunkSearchResult> = fts_scored
            .into_iter()
            .take(effective_limit)
            .map(|(mut c, _)| { c.search_mode = "fts5_only".to_string(); c })
            .collect();
        return Ok(results);
    }

    // 2. ANN search via sqlite-vec already gave us the top `candidate_pool`
    //    chunks by cosine similarity in a single `vec0` KNN query — no
    //    more loading every stored embedding into memory and scoring it
    //    against the query by hand (that used to be 30 chunks × 1000
    //    files = 30,000 comparisons per search; see db::ann_search_chunks).
    let mut cosine_by_id: std::collections::HashMap<String, f32> =
        std::collections::HashMap::with_capacity(all_embeddings.len());
    let mut chunk_by_id: std::collections::HashMap<String, db::ChunkSearchResult> =
        std::collections::HashMap::with_capacity(all_embeddings.len());
    for (chunk, similarity) in all_embeddings {
        cosine_by_id.insert(chunk.id.clone(), similarity);
        chunk_by_id.insert(chunk.id.clone(), chunk);
    }

    // 3. Candidate set = FTS top-K ∪ ANN top-K, so a chunk that's a strong
    //    semantic match but a weak keyword match still surfaces.
    let fts_ids: std::collections::HashSet<String> =
        fts_scored.iter().map(|(c, _)| c.id.clone()).collect();

    let extra_chunks: Vec<db::ChunkSearchResult> = chunk_by_id
        .iter()
        .filter(|(id, _)| !fts_ids.contains(*id))
        .map(|(_, chunk)| chunk.clone())
        .collect();

    // 4. Normalise FTS bm25 scores (lower=better → invert) and merge.
    let fts_min = fts_scored.iter().map(|(_, s)| *s).fold(f64::INFINITY, f64::min);
    let fts_max = fts_scored.iter().map(|(_, s)| *s).fold(f64::NEG_INFINITY, f64::max);
    let fts_norm = |score: f64| -> f64 {
        if !fts_max.is_finite() || (fts_max - fts_min).abs() < 1e-9 {
            return 0.5;
        }
        // bm25() is more negative = better, so invert before normalising.
        1.0 - ((score - fts_min) / (fts_max - fts_min))
    };

    let mut merged: Vec<(db::ChunkSearchResult, f64)> = Vec::new();

    for (chunk, fts_score) in fts_scored {
        let cosine = *cosine_by_id.get(&chunk.id).unwrap_or(&0.0) as f64;
        let rank = 0.6 * cosine + 0.4 * fts_norm(fts_score);
        merged.push((chunk, rank));
    }

    for chunk in extra_chunks {
        let cosine = *cosine_by_id.get(&chunk.id).unwrap_or(&0.0) as f64;
        // No FTS match for this chunk — treat its keyword relevance as 0.
        let rank = 0.6 * cosine + 0.4 * 0.0;
        merged.push((chunk, rank));
    }

    merged.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let results: Vec<db::ChunkSearchResult> = merged
        .into_iter()
        .take(effective_limit)
        .map(|(mut c, _)| { c.search_mode = "hybrid".to_string(); c })
        .collect();

    Ok(results)
}

// ── search_repo_by_file ───────────────────────────────────────────────────
//
// File-aware retrieval: given a filename or path fragment (e.g. "App.tsx",
// "services/index.html", "auth.ts"), finds all indexed files whose path
// ends with that fragment and returns ALL their chunks (ordered by line).
//
// Returns an empty Vec if no indexed file matches — callers should fall
// back to `search_repo` (FTS) in that case.
#[derive(serde::Serialize)]
pub struct FileChunkResult {
    pub matched_files: Vec<String>,
    pub chunks: Vec<db::ChunkSearchResult>,
}

#[tauri::command]
pub async fn search_repo_by_file(
    app: tauri::AppHandle,
    path_fragment: String,
    project_root: Option<String>,
) -> CmdResult<FileChunkResult> {
    let base_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    let fragment = path_fragment.trim();
    if fragment.is_empty() {
        return Ok(FileChunkResult { matched_files: vec![], chunks: vec![] });
    }

    let root = project_root.as_deref().unwrap_or("").trim_end_matches('/');
    // BUG FIX: this used to read `local_data_dir(&app)` directly — the
    // global, un-scoped app-data dir. `scan_repo` only ever writes chunks
    // into the PER-PROJECT dir (`db::project_data_dir`), so this was always
    // querying a different (empty) database and silently returning zero
    // matches no matter what was indexed. File-aware retrieval (and the
    // filename-fallback path that also calls this) was therefore dead on
    // arrival — every query fell through to the FTS path in search_repo,
    // and any query where that came up short surfaced as a false
    // "No repository context found".
    let project_dir = db::project_data_dir(&base_data_dir, root);

    println!("FILE-AWARE RETRIEVAL: path_fragment = {:?}", fragment);

    let matched_files = db::find_files_by_suffix(&project_dir, fragment, root)
        .map_err(|e| format!("find_files_by_suffix failed: {e}"))?;

    println!("FILE-AWARE RETRIEVAL: matched_files = {:?}", matched_files);

    if matched_files.is_empty() {
        println!("FILE-AWARE RETRIEVAL: no matching files, caller should fall back to FTS");
        return Ok(FileChunkResult { matched_files: vec![], chunks: vec![] });
    }

    let chunks = db::get_chunks_for_files(&project_dir, &matched_files)
        .map_err(|e| format!("get_chunks_for_files failed: {e}"))?;

    println!(
        "FILE-AWARE RETRIEVAL: retrieved {} chunks from {} file(s)",
        chunks.len(),
        matched_files.len()
    );

    Ok(FileChunkResult { matched_files, chunks })
}

// ── search_symbols ────────────────────────────────────────────────────────
//
// Symbol-aware retrieval: searches the `symbols` table for functions,
// classes, interfaces, types, enums, React components, and exported
// declarations whose name matches `query` (case-insensitive substring).
//
// Intended to run BEFORE chunk search for queries like:
//   "Where is login implemented?"
//   "Find AuthProvider"
//   "Show UserService"
#[tauri::command]
pub async fn search_symbols(
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
    project_root: Option<String>,
) -> CmdResult<Vec<db::Symbol>> {
    let base_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    let effective_limit = (limit.unwrap_or(10) as usize).min(50);

    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let root = project_root.as_deref().unwrap_or("").trim_end_matches('/');
    // Same bug/fix as search_repo_by_file above: this was reading the
    // global app-data dir instead of the per-project one `scan_repo`
    // actually writes symbols into, so symbol search always returned zero
    // results regardless of what was indexed.
    let project_dir = db::project_data_dir(&base_data_dir, root);

    println!("SYMBOL SEARCH: query = {:?}", query);

    let results = db::search_symbols(&project_dir, query.trim(), effective_limit, root)
        .map_err(|e| format!("Symbol search failed: {e}"))?;

    println!("SYMBOL SEARCH: {} results", results.len());

    Ok(results)
}

// ── store_embedding / embedding_stats / reembed_repo ────────────────────────
//
// Raw-BLOB + cosine-similarity backed embedding storage (see db.rs). The
// actual hybrid search ranking lives inline in `search_repo` above;
// `semantic_search_repo` is no longer needed as a separate command.

#[tauri::command]
pub async fn store_embedding(
    app: tauri::AppHandle,
    chunk_id: String,
    embedding: Vec<f32>,
    root: String,
) -> CmdResult<()> {
    let base_data_dir  = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    let project_dir = db::project_data_dir(&base_data_dir, &root);

    db::store_embedding(&project_dir, &chunk_id, &embedding)
        .map_err(|e| format!("Failed to store embedding: {e}"))
}

/// Stats surfaced in Settings → Embeddings: how many chunks have an
/// embedding vs. the total chunk count.
#[derive(serde::Serialize)]
pub struct EmbeddingStats {
    pub embedded_chunks: i64,
    pub total_chunks: i64,
    pub ollama_reachable: bool,
}

#[tauri::command]
pub async fn get_embedding_stats(app: tauri::AppHandle, root: String) -> CmdResult<EmbeddingStats> {
    let base_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    
    let project_dir = db::project_data_dir(&base_data_dir, &root);

    let (embedded_chunks, total_chunks) = db::embedding_stats(&project_dir)
        .map_err(|e| format!("Failed to read embedding stats: {e}"))?;

    let ollama_reachable = db::embed_chunk("ping", db::DEFAULT_OLLAMA_URL, db::DEFAULT_EMBED_MODEL)
        .await
        .is_some();

    Ok(EmbeddingStats { embedded_chunks, total_chunks, ollama_reachable })
}

/// "Re-embed entire repo" — re-runs embedding generation for every chunk
/// currently in the `chunks` table. Runs as a Tauri async command so it
/// never blocks the UI thread; the renderer can poll `get_embedding_stats`
/// for progress.
#[tauri::command]
pub async fn reembed_repo(app: tauri::AppHandle, root: String) -> CmdResult<usize> {
    let base_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    
    let project_dir = db::project_data_dir(&base_data_dir, &root);

    let all_chunks = db::get_all_chunks(&project_dir)
        .map_err(|e| format!("Failed to load chunks: {e}"))?;

    // embed concurrently in batches
    // instead of one sequential await per chunk, and write each batch in a
    // single transaction on one reused connection instead of a fresh
    // connection + 3 fsync'd writes per chunk.
    let mut conn = db::open_project_db(&project_dir)
        .map_err(|e| format!("Failed to open embeddings connection: {e}"))?;

    let mut embedded = 0usize;
    const REEMBED_BATCH: usize = 64;
    for batch in all_chunks.chunks(REEMBED_BATCH) {
        let embed_inputs: Vec<(String, String)> = batch
            .iter()
            .map(|c| (c.id.clone(), c.content.clone()))
            .collect();

        let results = db::embed_chunks_concurrent(
            &embed_inputs,
            db::DEFAULT_OLLAMA_URL,
            db::DEFAULT_EMBED_MODEL,
        )
        .await;

        if results.is_empty() {
            // Ollama unreachable (or every chunk in this batch failed) —
            // stop rather than spinning through the rest of the repo.
            break;
        }

        embedded += results.len();
        if let Err(e) = db::store_embeddings_batch(&mut conn, &results) {
            eprintln!("reembed_repo: batch store failed: {e}");
        }
    }

    Ok(embedded)
}

// ── get_vector_index_path ─────────────────────────────────────────────────
//
// Returns the path to the vector-index.json file so the renderer can pass
// it to the Node-side vector search via a Tauri command.
// The path mirrors the cache directory used by run.ts: ~/.rachna-ide/vector-cache/<slug>/
//
// `slug` is a hash of the (normalized) project root, so each opened repo
// gets its own isolated index instead of every project sharing one file.
// IMPORTANT: this must use the exact same hash algorithm and normalization
// as `vectorCacheDir()` in lib/repo-scanner/src/run.ts (the process that
// actually WRITES the index) — otherwise the reader and writer disagree on
// where the file lives and semantic search silently finds nothing. We use
// plain FNV-1a 64 (not std's DefaultHasher) specifically because it's a
// tiny, fully-specified algorithm that's trivial to reproduce identically
// in TypeScript; DefaultHasher's internals are a Rust-version implementation
// detail and aren't meant to be reimplemented elsewhere.
fn fnv1a64(s: &str) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET_BASIS;
    for byte in s.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

#[tauri::command]
pub async fn get_vector_index_path(root: String) -> CmdResult<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());

    let normalized = root.replace('\\', "/");
    #[cfg(target_os = "windows")]
    let normalized = normalized.to_lowercase();
    let slug = format!("{:016x}", fnv1a64(&normalized));

    let cache_dir = std::path::Path::new(&home)
        .join(".rachna-ide")
        .join("vector-cache")
        .join(&slug);

    Ok(cache_dir.join("vector-index.json").to_string_lossy().into_owned())
}

// ── System info (OS + shell detection) ─────────────────────────────────────
//
// Used to give the AI agent OS/shell awareness so it generates appropriate
// terminal commands (e.g. `Get-ChildItem` on PowerShell vs `ls` on Bash).

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemOsInfo { pub family: String, pub label: String, pub version: Option<String>, pub architecture: String }
#[derive(serde::Serialize, Clone)]
pub struct SystemShellInfo { pub id: String, pub label: String }
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemCpuInfo { pub brand: String, pub logical_cores: usize, pub physical_cores: Option<usize> }
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemoryInfo { pub total_bytes: u64, pub available_bytes: u64 }
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiskInfo { pub name: String, pub mount_point: String, pub total_bytes: u64, pub available_bytes: u64, pub file_system: String }
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemNetworkInfo { pub name: String, pub received_bytes: u64, pub transmitted_bytes: u64 }

#[derive(serde::Serialize, Clone)]
pub struct SystemInfoResult {
    // Legacy fields remain for the renderer's shell-detection consumer.
    pub os: String, pub os_label: String, pub shell: String, pub shell_label: String,
    #[serde(rename = "osInfo")]
    pub os_info: SystemOsInfo,
    #[serde(rename = "shellInfo")]
    pub shell_info: SystemShellInfo,
    pub cpu: SystemCpuInfo, pub memory: SystemMemoryInfo,
    pub disks: Vec<SystemDiskInfo>, pub network: Vec<SystemNetworkInfo>,
    pub displays: Vec<serde_json::Value>, pub battery: Option<serde_json::Value>,
    #[serde(rename = "installedApplications")]
    pub installed_applications: Vec<serde_json::Value>,
    #[serde(rename = "unsupportedSections")]
    pub unsupported_sections: Vec<String>,
}

#[tauri::command]
pub async fn get_system_info() -> CmdResult<SystemInfoResult> {
    let os = std::env::consts::OS;
    let os_label = detect_os_label(os);
    let (shell, shell_label) = detect_shell(os);
    let mut system = sysinfo::System::new_all();
    system.refresh_all();
    let disks = sysinfo::Disks::new_with_refreshed_list().iter().map(|disk| SystemDiskInfo {
        name: disk.name().to_string_lossy().into_owned(), mount_point: disk.mount_point().to_string_lossy().into_owned(),
        total_bytes: disk.total_space(), available_bytes: disk.available_space(), file_system: disk.file_system().to_string_lossy().into_owned(),
    }).collect();
    let network = sysinfo::Networks::new_with_refreshed_list().iter().map(|(name, data)| SystemNetworkInfo {
        name: name.clone(), received_bytes: data.total_received(), transmitted_bytes: data.total_transmitted(),
    }).collect();
    let brand = system.cpus().first().map(|cpu| cpu.brand().to_string()).unwrap_or_default();
    Ok(SystemInfoResult {
        os: os.into(), os_label: os_label.clone(), shell: shell.clone(), shell_label: shell_label.clone(),
        os_info: SystemOsInfo { family: os.into(), label: os_label, version: sysinfo::System::os_version(), architecture: std::env::consts::ARCH.into() },
        shell_info: SystemShellInfo { id: shell, label: shell_label },
        cpu: SystemCpuInfo { brand, logical_cores: system.cpus().len(), physical_cores: system.physical_core_count() },
        memory: SystemMemoryInfo { total_bytes: system.total_memory(), available_bytes: system.available_memory() },
        disks, network, displays: Vec::new(), battery: None, installed_applications: Vec::new(),
        unsupported_sections: vec!["displays".into(), "battery".into(), "installedApplications".into()],
    })
}

#[derive(serde::Serialize)]
pub struct FileSearchMatch { path: String, kind: String, line: Option<usize>, excerpt: Option<String> }
#[derive(serde::Serialize)]
pub struct FileSearchResult { root: String, matches: Vec<FileSearchMatch>, truncated: bool }

#[tauri::command]
pub async fn search_files(path: String, name: Option<String>, content: Option<String>, max_results: usize) -> CmdResult<FileSearchResult> {
    let root = PathBuf::from(&path);
    if !root.is_dir() { return Err(format!("Search path is not a directory: {path}")); }
    let name_query = name.map(|value| value.to_lowercase());
    let content_query = content.map(|value| value.to_lowercase());
    if name_query.is_none() && content_query.is_none() { return Err("Provide a name and/or content query.".into()); }
    let limit = max_results.clamp(1, 500);
    tokio::task::spawn_blocking(move || {
        let mut matches = Vec::new(); let mut truncated = false;
        for entry in walkdir::WalkDir::new(&root).follow_links(false).into_iter().filter_map(Result::ok).skip(1) {
            if matches.len() >= limit { truncated = true; break; }
            if name_query.as_ref().is_some_and(|query| entry.file_name().to_string_lossy().to_lowercase().contains(query)) {
                matches.push(FileSearchMatch { path: entry.path().to_string_lossy().into_owned(), kind: if entry.file_type().is_dir() { "directory" } else { "file" }.into(), line: None, excerpt: None });
            }
            if entry.file_type().is_file() && matches.len() < limit {
                if let Some(query) = &content_query {
                    if entry.metadata().map(|m| m.len() <= 2_000_000).unwrap_or(false) {
                        if let Ok(text) = fs::read_to_string(entry.path()) {
                            for (index, line) in text.lines().enumerate().filter(|(_, line)| line.to_lowercase().contains(query)) {
                                matches.push(FileSearchMatch { path: entry.path().to_string_lossy().into_owned(), kind: "file".into(), line: Some(index + 1), excerpt: Some(line.chars().take(300).collect()) });
                                if matches.len() >= limit { truncated = true; break; }
                            }
                        }
                    }
                }
            }
        }
        FileSearchResult { root: root.to_string_lossy().into_owned(), matches, truncated }
    }).await.map_err(|error| format!("File search failed: {error}"))
}

fn detect_os_label(os: &str) -> String {
    match os {
        "windows" => detect_windows_label(),
        "macos" => detect_macos_label(),
        "linux" => detect_linux_label(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => "Unknown OS".to_string(),
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_label() -> String {
    // `cmd /C ver` prints something like:
    //   Microsoft Windows [Version 10.0.22631.3527]
    // Build >= 22000 corresponds to Windows 11.
    let output = Command::new("cmd").args(["/C", "ver"]).no_window().output();

    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(start) = text.find("Version ") {
            let version_part = &text[start + "Version ".len()..];
            let version = version_part
                .trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.')
                .trim_end_matches(']')
                .trim();

            if let Some(build_str) = version.split('.').nth(2) {
                if let Ok(build) = build_str.parse::<u32>() {
                    return if build >= 22000 {
                        "Windows 11".to_string()
                    } else {
                        "Windows 10".to_string()
                    };
                }
            }
        }
    }

    "Windows".to_string()
}

#[cfg(not(target_os = "windows"))]
fn detect_windows_label() -> String {
    "Windows".to_string()
}

#[cfg(target_os = "macos")]
fn detect_macos_label() -> String {
    let output = Command::new("sw_vers").arg("-productVersion").output();
    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if version.is_empty() {
                "macOS".to_string()
            } else {
                format!("macOS {version}")
            }
        }
        _ => "macOS".to_string(),
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_macos_label() -> String {
    "macOS".to_string()
}

#[cfg(target_os = "linux")]
fn detect_linux_label() -> String {
    // Try /etc/os-release first (PRETTY_NAME="Ubuntu 22.04.3 LTS")
    if let Ok(contents) = fs::read_to_string("/etc/os-release") {
        for line in contents.lines() {
            if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
                let trimmed = value.trim().trim_matches('"');
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    "Linux".to_string()
}

#[cfg(not(target_os = "linux"))]
fn detect_linux_label() -> String {
    "Linux".to_string()
}

/// Returns (shell_id, shell_label) where shell_id is one of
/// "powershell" | "cmd" | "bash" | "zsh" | "sh".
fn detect_shell(os: &str) -> (String, String) {
    match os {
        "windows" => detect_windows_shell(),
        _ => detect_unix_shell(),
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_shell() -> (String, String) {
    // `PSModulePath` is set in any process launched from (or descended from)
    // PowerShell — a reasonable signal that PowerShell is the active shell.
    // PowerShell has also been the default interactive shell on Windows
    // since Windows 10, so we prefer it when it's available at all and only
    // fall back to cmd.exe if `powershell.exe` can't be found/run.
    if std::env::var("PSModulePath").is_ok() {
        return ("powershell".to_string(), "PowerShell".to_string());
    }

    let powershell_available = Command::new("powershell")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$null"])
        .no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if powershell_available {
        ("powershell".to_string(), "PowerShell".to_string())
    } else {
        ("cmd".to_string(), "Command Prompt".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_windows_shell() -> (String, String) {
    ("cmd".to_string(), "Command Prompt".to_string())
}

fn detect_unix_shell() -> (String, String) {
    let shell_path = std::env::var("SHELL").unwrap_or_default();
    let shell_name = shell_path
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase();

    match shell_name.as_str() {
        "zsh" => ("zsh".to_string(), "Zsh".to_string()),
        "bash" => ("bash".to_string(), "Bash".to_string()),
        "sh" | "dash" => ("sh".to_string(), "sh".to_string()),
        // macOS has shipped zsh as the default login shell since Catalina;
        // most Linux distros default to bash.
        _ => {
            if cfg!(target_os = "macos") {
                ("zsh".to_string(), "Zsh".to_string())
            } else {
                ("bash".to_string(), "Bash".to_string())
            }
        }
    }
}



pub(crate) fn find_node() -> CmdResult<PathBuf> {
    if let Some(node) = managed_node_bin("node") {
        return Ok(node);
    }

    if let Ok(out) = Command::new("node").arg("--version").no_window().output() {
        if out.status.success() {
            return Ok(PathBuf::from("node"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let candidates: Vec<PathBuf> = [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
            r"C:\Users\Default\.volta\bin\node.exe",
        ]
        .iter()
        .map(PathBuf::from)
        .chain(
            std::env::var("APPDATA").ok().into_iter().flat_map(|appdata| {
                let nvm_dir = PathBuf::from(&appdata).join("nvm");
                std::fs::read_dir(&nvm_dir)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok())
                    .map(|e| e.path().join("node.exe"))
                    .collect::<Vec<_>>()
            }),
        )
        .chain(
            std::env::var("LOCALAPPDATA").ok().into_iter().flat_map(|local| {
                let fnm_dir = PathBuf::from(&local).join("fnm").join("node-versions");
                std::fs::read_dir(&fnm_dir)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok())
                    .map(|e| e.path().join("installation").join("node.exe"))
                    .collect::<Vec<_>>()
            }),
        )
        .collect();

        for candidate in candidates {
            if candidate.exists() {
                return Ok(candidate);
            }
        }

        return Err(
            "Node.js not found. Install Node.js and ensure it is on your PATH, \
             or restart the app after installing."
                .to_string(),
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            format!("{home}/.nvm/versions/node/current/bin/node"),
            format!("{home}/.volta/bin/node"),
            format!("{home}/.fnm/current/bin/node"),
            "/usr/local/bin/node".to_string(),
            "/usr/bin/node".to_string(),
            "/opt/homebrew/bin/node".to_string(),
        ];
        for c in &candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                return Ok(p);
            }
        }
        Err("Node.js not found on PATH or common install locations.".to_string())
    }
}

// ── Folder picker ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct FolderEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub children: Vec<FolderEntry>,
}

#[tauri::command]
pub async fn open_folder(app: tauri::AppHandle) -> CmdResult<Option<FolderEntry>> {
    use tauri_plugin_dialog::DialogExt;

    let folder: Option<PathBuf> = app
        .dialog()
        .file()
        .set_title("Open Folder")
        .blocking_pick_folder()
        .and_then(|p| p.as_path().map(PathBuf::from));

    match folder {
        None => Ok(None),
        Some(path) => read_dir_recursive(&path).map(Some),
    }
}

/// Read a directory tree from a known path without opening a dialog.
/// Used to refresh the file explorer after indexing completes.
#[tauri::command]
pub async fn read_folder(path: String) -> CmdResult<FolderEntry> {
    let p = std::path::PathBuf::from(&path);
    read_dir_recursive(&p)
}

/// Opens a native folder-picker dialog and returns just the chosen path
/// (no recursive read). Used by the "Build New Project" flow to let the
/// user pick *where* a new project folder should be created, without the
/// cost of walking a directory tree that may contain thousands of unrelated
/// files (e.g. the user's home folder or Desktop).
#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle, title: Option<String>) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let folder: Option<PathBuf> = app
        .dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "Choose Project Location".to_string()))
        .blocking_pick_folder()
        .and_then(|p| p.as_path().map(PathBuf::from));

    Ok(folder.map(|p| p.to_string_lossy().into_owned()))
}

/// Opens a native "Open File" dialog for a single file, optionally
/// filtered to a set of extensions, and returns the chosen path (or
/// `None` if cancelled). Generic — unlike `open_folder`/`pick_directory`,
/// this doesn't assume anything about the file's contents; callers (e.g.
/// the Design Canvas's ".rachna_design" project file picker) read and
/// parse it themselves.
#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    title: Option<String>,
    filter_name: Option<String>,
    filter_extensions: Option<Vec<String>>,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app
        .dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "Open File".to_string()));

    if let Some(exts) = filter_extensions {
        if !exts.is_empty() {
            let name = filter_name.unwrap_or_else(|| "Files".to_string());
            let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(&name, &ext_refs);
        }
    }

    let file: Option<PathBuf> = builder
        .blocking_pick_file()
        .and_then(|p| p.as_path().map(PathBuf::from));

    Ok(file.map(|p| p.to_string_lossy().into_owned()))
}

/// Resolves (and creates, if missing) the default parent folder offered by
/// the "Build New Project" dialog (intent classification → BUILD_NEW_PROJECT)
/// when the user hasn't picked a location of their own:
/// `{install_dir}/data/projects`. Keeping generated projects under the same
/// portable data root as the rest of the application makes the default
/// consistent across installed and portable builds. The user can always still
/// override it via Browse…
#[tauri::command]
pub async fn get_default_projects_dir(app: tauri::AppHandle) -> CmdResult<String> {
    let dir = local_data_dir(&app)?.join("projects");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create default projects directory at {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Stable, portable-install-friendly directory for locally-spawned (stdio)
/// MCP servers that need a persistent file of their own on disk — e.g. the
/// Gmail / Google Calendar MCP servers, which cache the OAuth token they
/// obtain from their own first-run browser sign-in at a path *we* tell them
/// to use (see lib/mcp/googleStdioCredentials.ts). Deliberately generic
/// (not Google-specific) — any future stdio MCP quickstart that needs a
/// stable on-disk credential/cache path can share this same root, each
/// under its own subdirectory.
///
/// Lives under `local_data_dir` (next to the executable, not the OS
/// roaming-appdata folder) for the same portability reason every other use
/// of `local_data_dir` in this file does: it survives moving/copying the
/// whole install, and — just as importantly here — it's stable across
/// which project happens to be open, unlike the per-server `cwd` MCP
/// servers otherwise spawn with.
#[tauri::command]
pub async fn get_mcp_credentials_dir(app: tauri::AppHandle) -> CmdResult<String> {
    let dir = local_data_dir(&app)?.join("mcp-credentials");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create MCP credentials directory at {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Creates a new project folder `{parent_path}/{project_name}` and returns
/// its (empty) directory tree. Used by the "Build New Project" flow once the
/// user has confirmed a location + name in the dialog.
///
/// - Sanitises `project_name` to a filesystem-safe slug (no path separators,
///   no leading/trailing whitespace).
/// - Fails if the resolved path already exists as a *file*.
/// - If the resolved path already exists as a directory, it is reused as-is
///   (no error) so re-running a build into the same name is non-destructive.
#[tauri::command]
pub async fn create_project(parent_path: String, project_name: String) -> CmdResult<FolderEntry> {
    let sanitized = sanitize_project_name(&project_name);
    if sanitized.is_empty() {
        return Err("Project name must contain at least one letter, number, dash, or underscore.".to_string());
    }

    let parent = PathBuf::from(&parent_path);
    if !parent.is_dir() {
        return Err(format!("Location does not exist or is not a folder: \"{parent_path}\""));
    }

    let project_path = parent.join(&sanitized);

    if project_path.is_file() {
        return Err(format!(
            "\"{}\" already exists as a file at this location.",
            sanitized
        ));
    }
    if !project_path.exists() {
        fs::create_dir_all(&project_path).map_err(io_err)?;
    }

    read_dir_recursive(&project_path)
}

/// Strips characters that aren't safe across Windows/macOS/Linux filenames
/// and collapses whitespace, so user-entered project names can't escape the
/// chosen parent directory (e.g. via "..", "/", "\").
fn sanitize_project_name(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | ' ' => c,
            _ => '-',
        })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .trim_matches(|c: char| c == '.' || c == '-')
        .to_string()
}

fn read_dir_recursive(path: &PathBuf) -> CmdResult<FolderEntry> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    let is_dir = path.is_dir();

    let children = if is_dir {
        let mut entries: Vec<FolderEntry> = fs::read_dir(path)
            .map_err(io_err)?
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name();
                let s = n.to_string_lossy();
                !s.starts_with('.')
                    && s != "node_modules"
                    && s != "target"
                    && s != "dist"
            })
            .filter_map(|e| read_dir_recursive(&e.path()).ok())
            .collect();

        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        entries
    } else {
        vec![]
    };

    Ok(FolderEntry {
        path: path.to_string_lossy().into_owned(),
        name,
        is_dir,
        children,
    })
}

// ── Read file ─────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ReadResult {
    pub path: String,
    /// For `kind == "text"`: raw UTF-8 text.
    /// For `kind == "base64"`: base64-encoded bytes (images, audio, video, pdf, etc).
    /// For `kind == "binary"`: empty string (file too large / not previewable — use file-info panel).
    pub content: String,
    /// Size of the file on disk, in bytes.
    pub size: u64,
    /// "text" | "base64" | "binary"
    pub kind: String,
    /// Best-guess MIME type, e.g. "image/png", "text/plain", "application/octet-stream"
    pub mime: String,
    /// Last-modified time as a unix timestamp (seconds), if available.
    pub modified: Option<u64>,
}

/// Files larger than this are never read into memory for preview purposes;
/// they're reported as "binary" so the UI can show a file-info panel only.
const MAX_PREVIEW_BYTES: u64 = 25 * 1024 * 1024; // 25 MB

/// Best-effort MIME type guess based on file extension.
fn guess_mime(path: &PathBuf) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "png"  => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif"  => "image/gif",
        "webp" => "image/webp",
        "svg"  => "image/svg+xml",
        "bmp"  => "image/bmp",
        "ico"  => "image/x-icon",
        "pdf"  => "application/pdf",
        "mp3"  => "audio/mpeg",
        "wav"  => "audio/wav",
        "ogg"  => "audio/ogg",
        "m4a"  => "audio/mp4",
        "flac" => "audio/flac",
        "aac"  => "audio/aac",
        "mp4"  => "video/mp4",
        "webm" => "video/webm",
        "mov"  => "video/quicktime",
        "mkv"  => "video/x-matroska",
        "avi"  => "video/x-msvideo",
        "zip" | "exe" | "dll" | "db" | "sqlite" | "so" | "dylib" | "bin" | "node" | "wasm"
            => "application/octet-stream",
        _ => "",
    }
    .to_string()
}

/// True if this MIME type should be previewed as base64 (image/audio/video/pdf).
fn is_binary_preview_mime(mime: &str) -> bool {
    mime.starts_with("image/")
        || mime.starts_with("audio/")
        || mime.starts_with("video/")
        || mime == "application/pdf"
}

/// Heuristic: does this byte slice look like text (valid UTF-8, no NUL
/// bytes in the sampled prefix)?
fn looks_like_text(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return false;
    }
    std::str::from_utf8(sample).is_ok()
}

// ── Path info (existence check) ───────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct PathInfo {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
}

/// Lightweight existence probe used by agent tools before read/edit/delete/rename.
#[tauri::command]
pub async fn path_info(path: String) -> CmdResult<PathInfo> {
    let p = PathBuf::from(&path);

    if !p.exists() {
        return Ok(PathInfo {
            exists: false,
            is_file: false,
            is_dir: false,
        });
    }

    let meta = fs::metadata(&p).map_err(io_err)?;
    Ok(PathInfo {
        exists: true,
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
    })
}

#[tauri::command]
pub async fn read_file(path: String) -> CmdResult<ReadResult> {
    let p = PathBuf::from(&path);

    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    if p.is_dir() {
        return Err(format!("Path is a directory: {path}"));
    }

    let metadata = fs::metadata(&p).map_err(io_err)?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    let mut mime = guess_mime(&p);

    // Too large to preview at all → file-info panel only, no error.
    if size > MAX_PREVIEW_BYTES {
        if mime.is_empty() {
            mime = "application/octet-stream".to_string();
        }
        return Ok(ReadResult {
            path,
            content: String::new(),
            size,
            kind: "binary".to_string(),
            mime,
            modified,
        });
    }

    let bytes = fs::read(&p).map_err(io_err)?;

    // Known image/audio/video/pdf types render as base64 previews.
    if is_binary_preview_mime(&mime) {
        return Ok(ReadResult {
            path,
            content: base64_encode(&bytes),
            size,
            kind: "base64".to_string(),
            mime,
            modified,
        });
    }

    // Try to decode as UTF-8 text. Never fail — fall back to binary info.
    match String::from_utf8(bytes.clone()) {
        Ok(content) => Ok(ReadResult {
            path,
            content,
            size,
            kind: "text".to_string(),
            mime: if mime.is_empty() { "text/plain".to_string() } else { mime },
            modified,
        }),
        Err(_) => {
            if mime.is_empty() {
                mime = if looks_like_text(&bytes) {
                    "text/plain; charset=unknown".to_string()
                } else {
                    "application/octet-stream".to_string()
                };
            }
            Ok(ReadResult {
                path,
                content: String::new(),
                size,
                kind: "binary".to_string(),
                mime,
                modified,
            })
        }
    }
}

/// Minimal base64 encoder (no external dependency needed).
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;

        out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 { CHARS[((n >> 6) & 0x3F) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[(n & 0x3F) as usize] as char } else { '=' });
    }
    out
}

// ── List directory (shallow, single level) ──────────────────────────────────

#[derive(serde::Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Returns the immediate children of `path` (non-recursive), sorted with
/// directories first, then alphabetically. Used by the agent's
/// `list_directory` tool.
#[tauri::command]
pub async fn list_directory(path: String) -> CmdResult<Vec<DirEntryInfo>> {
    let p = PathBuf::from(&path);

    if !p.exists() {
        return Err(format!("Directory not found: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    let mut entries: Vec<DirEntryInfo> = fs::read_dir(&p)
        .map_err(io_err)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let n = e.file_name();
            let s = n.to_string_lossy();
            !s.starts_with('.')
                && s != "node_modules"
                && s != "target"
                && s != "dist"
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(DirEntryInfo {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                is_dir: meta.is_dir(),
            })
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

// ── Rename file ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn rename_file(old_path: String, new_path: String) -> CmdResult<()> {
    let old = PathBuf::from(&old_path);
    let new = PathBuf::from(&new_path);

    if !old.exists() {
        return Err(format!("Source not found: {old_path}"));
    }

    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }

    fs::rename(&old, &new).map_err(|e| format!("Failed to rename {old_path} → {new_path}: {e}"))
}

// ── Delete file ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn delete_file(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);

    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    if p.is_dir() {
        return Err(format!("Path is a directory (use delete_folder): {path}"));
    }

    fs::remove_file(&p).map_err(|e| format!("Failed to delete {path}: {e}"))
}

// ── Copy file ──────────────────────────────────────────────────────────────────
//
// Duplicates a single file (templates, assets, configs, …). Unlike
// rename_file, the source is left untouched. Creates the destination's
// parent directories as needed; refuses to overwrite an existing file at
// the destination so a careless copy can't silently clobber something.

#[tauri::command]
pub async fn copy_file(source_path: String, destination_path: String) -> CmdResult<()> {
    let src = PathBuf::from(&source_path);
    let dst = PathBuf::from(&destination_path);

    if !src.exists() {
        return Err(format!("Source not found: {source_path}"));
    }
    if src.is_dir() {
        return Err(format!("Source is a directory (use copy_folder): {source_path}"));
    }
    if dst.exists() {
        return Err(format!("Destination already exists: {destination_path}"));
    }

    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }

    fs::copy(&src, &dst)
        .map(|_| ())
        .map_err(|e| format!("Failed to copy {source_path} → {destination_path}: {e}"))
}

// ── Copy folder ────────────────────────────────────────────────────────────────
//
// Recursively clones an entire directory tree (project folders/features).
// Refuses to overwrite an existing destination directory or file.

fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let target = dst.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            fs::copy(&entry_path, &target)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn copy_folder(source_path: String, destination_path: String) -> CmdResult<()> {
    let src = PathBuf::from(&source_path);
    let dst = PathBuf::from(&destination_path);

    if !src.exists() {
        return Err(format!("Source not found: {source_path}"));
    }
    if !src.is_dir() {
        return Err(format!("Source is not a directory (use copy_file): {source_path}"));
    }
    if dst.exists() {
        return Err(format!("Destination already exists: {destination_path}"));
    }
    if dst.starts_with(&src) {
        return Err("Cannot copy a folder into itself".to_string());
    }

    copy_dir_recursive(&src, &dst)
        .map_err(|e| format!("Failed to copy folder {source_path} → {destination_path}: {e}"))
}

// ── Move folder ────────────────────────────────────────────────────────────────
//
// Moves/renames an entire directory. Tries a plain rename first (fast,
// same-volume case); falls back to recursive copy + delete for cross-volume
// moves, where fs::rename would otherwise fail.

#[tauri::command]
pub async fn move_folder(old_path: String, new_path: String) -> CmdResult<()> {
    let old = PathBuf::from(&old_path);
    let new = PathBuf::from(&new_path);

    if !old.exists() {
        return Err(format!("Source not found: {old_path}"));
    }
    if !old.is_dir() {
        return Err(format!("Source is not a directory (use rename_file): {old_path}"));
    }
    if new.exists() {
        return Err(format!("Destination already exists: {new_path}"));
    }
    if new.starts_with(&old) {
        return Err("Cannot move a folder into itself".to_string());
    }

    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }

    if fs::rename(&old, &new).is_ok() {
        return Ok(());
    }

    // Cross-volume fallback: copy the whole tree, then remove the source.
    copy_dir_recursive(&old, &new)
        .map_err(|e| format!("Failed to move folder {old_path} → {new_path}: {e}"))?;
    fs::remove_dir_all(&old)
        .map_err(|e| format!("Copied {old_path} → {new_path}, but failed to remove the original: {e}"))
}

// ── Delete folder ──────────────────────────────────────────────────────────────
//
// Recursively deletes a directory and everything in it. IRREVERSIBLE.

#[tauri::command]
pub async fn delete_folder(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);

    if !p.exists() {
        return Err(format!("Folder not found: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("Path is a file, not a directory (use delete_file): {path}"));
    }

    fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete folder {path}: {e}"))
}

// ── Create folder ──────────────────────────────────────────────────────────────
//
// Creates a new directory (and any missing parent directories). Errors if
// the path already exists as a file; succeeds (no-op) if it already exists
// as a directory, matching `mkdir -p` semantics.

#[tauri::command]
pub async fn create_folder(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);

    if p.exists() && !p.is_dir() {
        return Err(format!("Path already exists and is a file, not a directory: {path}"));
    }

    fs::create_dir_all(&p).map_err(|e| format!("Failed to create folder {path}: {e}"))
}

// ── Save file ─────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SaveResult {
    pub path: String,
    pub written: usize,
}

#[tauri::command]
pub async fn save_file(
    app: tauri::AppHandle,
    path: Option<String>,
    content: String,
    default_name: Option<String>,
) -> CmdResult<SaveResult> {
    use tauri_plugin_dialog::DialogExt;

    let resolved_path: PathBuf = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let mut builder = app.dialog().file().set_title("Save File");

            if let Some(name) = default_name {
                builder = builder.set_file_name(&name);
            }

            builder
                .blocking_save_file()
                .and_then(|p| p.as_path().map(PathBuf::from))
                .ok_or_else(|| "Save cancelled".to_string())?
        }
    };

    if let Some(parent) = resolved_path.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }

    let bytes = content.as_bytes();
    fs::write(&resolved_path, bytes).map_err(io_err)?;

    Ok(SaveResult {
        path: resolved_path.to_string_lossy().into_owned(),
        written: bytes.len(),
    })
}

// ── Write base64 (binary) file ───────────────────────────────────────────────
//
// Companion to `save_file`, which only handles UTF-8 text content. Used by
// the `media_generation` desktop_task action to persist model-generated
// images, video, PDFs, and PPTX files (all binary) straight to disk without
// round-tripping through a text encoding.

/// Minimal base64 decoder matching `base64_encode` above (standard alphabet,
/// '=' padding). Ignores whitespace/newlines some APIs wrap responses in.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let clean: Vec<u8> = input
        .bytes()
        .filter(|&b| !b.is_ascii_whitespace())
        .collect();

    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in clean.chunks(4) {
        if chunk.len() < 2 {
            return Err("Invalid base64 input".to_string());
        }
        let c0 = val(chunk[0]).ok_or("Invalid base64 character")?;
        let c1 = val(chunk[1]).ok_or("Invalid base64 character")?;
        let c2 = if chunk.len() > 2 && chunk[2] != b'=' { val(chunk[2]) } else { None };
        let c3 = if chunk.len() > 3 && chunk[3] != b'=' { val(chunk[3]) } else { None };

        let n = (c0 << 18) | (c1 << 12) | (c2.unwrap_or(0) << 6) | c3.unwrap_or(0);
        out.push(((n >> 16) & 0xFF) as u8);
        if c2.is_some() {
            out.push(((n >> 8) & 0xFF) as u8);
        }
        if c3.is_some() {
            out.push((n & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn write_base64_file(path: String, data: String) -> CmdResult<SaveResult> {
    let resolved_path = PathBuf::from(&path);

    if let Some(parent) = resolved_path.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }

    let bytes = base64_decode(&data)?;
    fs::write(&resolved_path, &bytes).map_err(io_err)?;

    Ok(SaveResult {
        path: resolved_path.to_string_lossy().into_owned(),
        written: bytes.len(),
    })
}

// ── run_terminal_command ──────────────────────────────────────────────────────
//
// Executes an arbitrary shell command in `cwd` with a timeout.
// Used by the agent's `run_terminal_command` tool AND the build verification
// service for post-edit build checks.
//
// Security: The TypeScript layer enforces an allowlist of permitted command
// prefixes before calling this. Rust does not re-validate — it trusts the
// renderer to have already filtered. (Tauri's threat model: renderer ≈ app code,
// not an untrusted web origin.)
//
// Returns:
//   stdout / stderr as UTF-8 strings (non-UTF-8 bytes are replaced with U+FFFD)
//   exit_code: i32 | null (null when killed by timeout or by signal)
//   timed_out: bool
//   duration_ms: u64

#[derive(serde::Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn run_terminal_command(
    command: String,
    cwd: String,
    timeout_seconds: Option<u64>,
    shell: Option<String>,
) -> CmdResult<CommandOutput> {
    let timeout_secs = timeout_seconds.unwrap_or(60).min(300);
    let timeout = Duration::from_secs(timeout_secs);

    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.exists() {
        return Err(format!("Working directory does not exist: {cwd}"));
    }
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }

    let start = Instant::now();

    // ── Build the program + args to spawn ───────────────────────────────────
    //
    // When `shell` is provided (the normal case — see terminalTool.ts, which
    // threads the detected OS/shell through from ToolContext), we execute the
    // command via that shell. This is required for shell builtins / cmdlets
    // that aren't standalone executables (PowerShell's `Get-ChildItem`,
    // `Select-String`, etc., or cmd's `dir`, `type`, `findstr`).
    //
    // When `shell` is absent (older callers), fall back to the previous
    // behaviour: split the command ourselves and spawn it directly with no
    // shell — no pipes/redirection/glob expansion, but also no shell-specific
    // syntax support.
    let (program, args): (String, Vec<String>) = match shell.as_deref() {
        Some(s) => build_shell_invocation(s, &command),
        None => {
            let parts = shell_split(&command);
            if parts.is_empty() {
                return Err("Empty command".to_string());
            }
            // `parts[0]` is resolved with the same Windows-shim awareness as
            // the Doctor version checks (see `run_version_command` above).
            // Without this, Command::new("npx") fails with "program not
            // found" on Windows even though `npx` works fine in a real
            // terminal — npm/npx ship as `.cmd` shims there, and
            // CreateProcess (unlike a shell) does not do PATHEXT resolution.
            // Callers that omit `shell` (e.g. DoctorPanel's "Run Fix" /
            // "Install All" buttons, which call this with only
            // command/cwd/timeoutSeconds) hit this path directly.
            let resolved = resolve_executable(&parts[0]);
            (resolved, parts[1..].to_vec())
        }
    };

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd_path)
        .no_window()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    with_managed_node_path(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn `{program}`: {e}"))?;

    // Poll until the process exits or we hit the timeout.
    // We use a spin-wait with a short sleep to avoid blocking the async runtime.
    let output = loop {
        match child.try_wait().map_err(|e| format!("Process wait error: {e}"))? {
            Some(_status) => {
                // Process exited — collect full output
                break child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to collect output: {e}"))?;
            }
            None => {
                if start.elapsed() >= timeout {
                    // Kill the process
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie

                    return Ok(CommandOutput {
                        stdout: String::new(),
                        stderr: format!("Process killed after {timeout_secs}s timeout."),
                        exit_code: None,
                        timed_out: true,
                        duration_ms: start.elapsed().as_millis() as u64,
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code(),
        timed_out: false,
        duration_ms,
    })
}

// ── run_http_request ────────────────────────────────────────────────────────
//
// Performs an arbitrary HTTP request ("curl from the chat"). Used by the
// agent's `curl_request` tool to talk to local/remote HTTP services — most
// importantly an LM Studio (or any OpenAI-compatible) server running on
// another machine on the network, but also any other API the user wants to
// poke at without leaving the IDE.
//
// This runs as a native Rust HTTP client (reqwest), NOT a browser fetch —
// so it is not subject to the webview's CORS restrictions. That's what makes
// "connect to any LM Studio, even outside my PC" actually work: a remote
// LM Studio server's CORS headers (or lack thereof) don't matter here.
//
// Security note: like run_terminal_command, the TypeScript layer is expected
// to be the place that decides whether/when to call this. There's no domain
// allowlist here by design — the whole point is generic HTTP access — but
// callers should still be thoughtful about what they ask the agent to hit.

#[derive(serde::Deserialize)]
pub struct HttpRequestArgs {
    pub url: String,
    /// HTTP method / "curl type" — GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.
    pub method: String,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
    pub timeout_seconds: Option<u64>,
}

#[derive(serde::Serialize)]
pub struct HttpResponseOutput {
    pub status: u16,
    pub status_text: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    pub ok: bool,
    pub duration_ms: u64,
    pub timed_out: bool,
}

#[tauri::command]
pub async fn run_http_request(args: HttpRequestArgs) -> CmdResult<HttpResponseOutput> {
    // Cap raised to 600s to match ZENMUX_MAX_TIMEOUT_SECONDS (see
    // lib/providers/ZenmuxProvider.ts) — this command backs Zenmux's
    // agentTurn (non-streaming) calls, which are user-configurable up to
    // 600s. Other callers (curl_request tool, model discovery, etc.) still
    // pass their own short timeouts explicitly, so this only widens the
    // ceiling — it doesn't change anyone's default.
    let timeout_secs = args.timeout_seconds.unwrap_or(30).min(600);

    let method = match args.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => return Err(format!("Unsupported HTTP method/curl type: {other}")),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut req = client.request(method, &args.url);

    if let Some(headers) = &args.headers {
        for (k, v) in headers {
            req = req.header(k, v);
        }
    }
    // Default to JSON content-type for requests with a body, unless the
    // caller already specified one explicitly.
    let has_explicit_content_type = args
        .headers
        .as_ref()
        .map(|h| h.keys().any(|k| k.eq_ignore_ascii_case("content-type")))
        .unwrap_or(false);
    if args.body.is_some() && !has_explicit_content_type {
        req = req.header("Content-Type", "application/json");
    }

    if let Some(body) = args.body.clone() {
        req = req.body(body);
    }

    let start = Instant::now();

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            if e.is_timeout() {
                return Ok(HttpResponseOutput {
                    status: 0,
                    status_text: "Timeout".to_string(),
                    headers: std::collections::HashMap::new(),
                    body: format!("Request timed out after {timeout_secs}s."),
                    ok: false,
                    duration_ms,
                    timed_out: true,
                });
            }
            return Err(format!("Request failed: {e}"));
        }
    };

    let status = res.status();
    let mut headers_out = std::collections::HashMap::new();
    for (k, v) in res.headers().iter() {
        headers_out.insert(k.to_string(), v.to_str().unwrap_or("").to_string());
    }

    let body_text = res.text().await.unwrap_or_default();
    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(HttpResponseOutput {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: headers_out,
        body: body_text,
        ok: status.is_success(),
        duration_ms,
        timed_out: false,
    })
}

// ── run_browser_check ───────────────────────────────────────────────────────
//
// Runs the Playwright sidecar (`node lib/browser-tool/run.js <json args>`) as
// a subprocess. This is what powers the agent's `browser_check` tool: it
// lets the agent navigate a real, VISIBLE Chromium window (brought to the
// foreground, same as the terminal's link-opener) to a URL (typically the
// user's localhost dev server), take a screenshot, and read back console
// errors / failed network requests — so it can confirm a frontend change
// actually rendered instead of just inspecting source, and the user can
// watch it happen. If Playwright can't launch at all, this command still
// returns `Ok` with `ok: false` + `error` in the payload (see run.js) so the
// TS-side tool can fall back to the OS default desktop browser.
//
// Resolution of run.js mirrors `scan_repo`'s resolution of the repo-scanner
// CLI: try relative to the current working directory (dev mode), the Tauri
// resource dir (bundled app), and the directory next to the executable.

#[derive(serde::Deserialize)]
pub struct BrowserCheckArgs {
    pub url: String,
    pub wait_ms: Option<u64>,
    pub full_page: Option<bool>,
    pub selector: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub timeout_ms: Option<u64>,
    /// If true, the visible Chromium window opened for the check is left
    /// open afterwards instead of being closed automatically.
    pub keep_open: Option<bool>,
    /// If true, launch headless instead of the usual visible foreground
    /// window. Used by the editor's HTML Design preview so toggling to it
    /// doesn't pop up an OS browser window every time.
    pub headless: Option<bool>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct ConsoleMessageOut {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    pub location: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct FailedRequestOut {
    pub url: String,
    pub method: String,
    pub failure: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct HttpErrorOut {
    pub url: String,
    pub status: u16,
    #[serde(rename = "statusText")]
    pub status_text: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct BrowserCheckOutput {
    pub ok: bool,
    pub error: Option<String>,
    pub url: Option<String>,
    #[serde(rename = "finalUrl")]
    pub final_url: Option<String>,
    pub title: Option<String>,
    pub status: Option<u16>,
    #[serde(rename = "navError")]
    pub nav_error: Option<String>,
    /// Base64-encoded PNG. None if the screenshot itself failed.
    #[serde(rename = "screenshotBase64")]
    pub screenshot_base64: Option<String>,
    #[serde(rename = "consoleMessages", default)]
    pub console_messages: Vec<ConsoleMessageOut>,
    #[serde(rename = "pageErrors", default)]
    pub page_errors: Vec<String>,
    #[serde(rename = "failedRequests", default)]
    pub failed_requests: Vec<FailedRequestOut>,
    #[serde(rename = "httpErrors", default)]
    pub http_errors: Vec<HttpErrorOut>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
}

/// Resolves a resource file by trying, in order: relative to cwd (dev mode),
/// the Tauri resource dir (bundled app), and the dir next to the exe.
/// Mirrors the equivalent inline logic in `scan_repo`.
fn resolve_resource_path(app: &tauri::AppHandle, suffix: &[&str]) -> CmdResult<PathBuf> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resource dir: {e}"))?;
    let candidate_resource = suffix.iter().fold(resource_dir, |p, s| p.join(s));

    let project_root = std::env::current_dir()
        .unwrap_or_default()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let candidate_cwd = suffix.iter().fold(project_root, |p, s| p.join(s));

    let candidate_exe = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| suffix.iter().fold(p.to_path_buf(), |acc, s| acc.join(s))));

    [Some(candidate_cwd), Some(candidate_resource), candidate_exe]
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .ok_or_else(|| {
            format!(
                "Resource not found: {}. Run: cd lib/browser-tool && npm install && npx playwright install chromium",
                suffix.join("/")
            )
        })
}

#[tauri::command]
pub async fn run_browser_check(
    app: tauri::AppHandle,
    args: BrowserCheckArgs,
) -> CmdResult<BrowserCheckOutput> {
    let runner_js = resolve_resource_path(&app, &["lib", "browser-tool", "run.js"])?;
    let runner_js = runner_js.to_string_lossy().replace(r"\\?\", "");

    let node_exe = find_node()?;

    let timeout_ms = args.timeout_ms.unwrap_or(30_000).clamp(1_000, 60_000);

    let payload = serde_json::json!({
        "url": args.url,
        "waitMs": args.wait_ms.unwrap_or(1000),
        "fullPage": args.full_page.unwrap_or(false),
        "selector": args.selector,
        "width": args.width.unwrap_or(1280),
        "height": args.height.unwrap_or(800),
        "timeoutMs": timeout_ms,
        "keepOpen": args.keep_open.unwrap_or(false),
        "headless": args.headless.unwrap_or(false),
    })
    .to_string();

    // The Playwright navigation has its own internal timeout; give the
    // overall subprocess a little extra headroom on top of that.
    let process_timeout = Duration::from_millis(timeout_ms) + Duration::from_secs(20);

    let mut child = Command::new(&node_exe)
        .arg(runner_js.as_str())
        .arg(&payload)
        .no_window()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn node ({node_exe:?}): {e}"))?;

    let start = Instant::now();
    let output = loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                break child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to read browser_check output: {e}"))?;
            }
            Ok(None) => {
                if start.elapsed() >= process_timeout {
                    let _ = child.kill();
                    return Err(format!(
                        "browser_check timed out after {}ms waiting on {}",
                        process_timeout.as_millis(),
                        args.url
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Failed to poll browser_check process: {e}")),
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    let json_start = stdout.find('{').ok_or_else(|| {
        format!("No JSON found in browser_check output.\nstdout: {stdout}\nstderr: {stderr}")
    })?;
    let json_str = &stdout[json_start..];

    serde_json::from_str::<BrowserCheckOutput>(json_str)
        .map_err(|e| format!("Failed to parse browser_check output: {e}\nraw: {json_str}"))
}

// ── render_html_design_preview ────────────────────────────────────────────────
//
// Powers the editor's HTML "Design" view (see EditorPane.tsx /
// components/viewers/HtmlDesignView.tsx): the current buffer content for an
// .html/.htm tab is written to a temp file and rendered through the same
// Playwright sidecar as `run_browser_check`, headless this time, so toggling
// Code/Design doesn't pop up a visible OS browser window. `base_dir`, when
// the tab has a real on-disk path, points the temp file at that file's own
// folder so relative sibling assets (co-located css/js) still resolve;
// unsaved in-memory files (see useUnsavedProjectStore) fall back to the OS
// temp dir since they have no real folder.

#[derive(serde::Deserialize)]
pub struct HtmlDesignPreviewArgs {
    pub content: String,
    pub base_dir: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[tauri::command]
pub async fn render_html_design_preview(
    app: tauri::AppHandle,
    args: HtmlDesignPreviewArgs,
) -> CmdResult<BrowserCheckOutput> {
    let dir = match args.base_dir.as_deref() {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => std::env::temp_dir(),
    };
    fs::create_dir_all(&dir).map_err(io_err)?;

    let temp_path = dir.join(".rachna-design-preview.html");
    fs::write(&temp_path, args.content.as_bytes()).map_err(io_err)?;

    let url = format!(
        "file://{}",
        temp_path.to_string_lossy().replace('\\', "/")
    );

    let result = run_browser_check(
        app,
        BrowserCheckArgs {
            url,
            wait_ms: Some(200),
            full_page: Some(true),
            selector: None,
            width: args.width,
            height: args.height,
            timeout_ms: Some(15_000),
            keep_open: Some(false),
            headless: Some(true),
        },
    )
    .await;

    let _ = fs::remove_file(&temp_path);

    result
}

// ── run_web_task ─────────────────────────────────────────────────────────────
//
// Runs the Playwright sidecar (`node lib/browser-tool/web-task.js <json args>`)
// as a subprocess. This is what powers the agent's `web_task` tool
// (services/agent/tools/webTaskTool.ts): given an ordered list of steps
// (goto/click/fill/press/waitFor/wait/extractText/extractAttr/screenshot),
// it drives a single headless-Chromium session through all of them and
// returns whatever text/attributes were extracted. Used for BROWSER_TASK-intent
// requests — public, unauthenticated web work (search results, public
// docs/forms, scraping a public page, polling a page for a change) — never
// for anything requiring the user's own logged-in session.
//
// Resolution of web-task.js mirrors run_browser_check's resolution of run.js.

#[derive(serde::Serialize, serde::Deserialize)]
pub struct WebTaskArgs {
    pub steps: Vec<serde_json::Value>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct WebTaskOutput {
    pub ok: bool,
    pub error: Option<String>,
    #[serde(rename = "finalUrl")]
    pub final_url: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub extracted: serde_json::Value,
    #[serde(rename = "screenshotBase64")]
    pub screenshot_base64: Option<String>,
    #[serde(rename = "stepLog", default)]
    pub step_log: Vec<serde_json::Value>,
    #[serde(rename = "consoleErrors", default)]
    pub console_errors: Vec<String>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
}

#[tauri::command]
pub async fn run_web_task(app: tauri::AppHandle, args: WebTaskArgs) -> CmdResult<WebTaskOutput> {
    let runner_js = resolve_resource_path(&app, &["lib", "browser-tool", "web-task.js"])?;
    let runner_js = runner_js.to_string_lossy().replace(r"\\?\", "");

    let node_exe = find_node()?;

    // Overall subprocess timeout: generous enough for a multi-step run
    // (up to 25 steps, each with its own bounded per-step timeout inside
    // web-task.js) plus headroom for browser launch/teardown.
    let process_timeout = Duration::from_secs(90);

    let payload = serde_json::json!({
        "steps": args.steps,
        "width": args.width.unwrap_or(1280),
        "height": args.height.unwrap_or(800),
    })
    .to_string();

    let mut child = Command::new(&node_exe)
        .arg(runner_js.as_str())
        .arg(&payload)
        .no_window()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn node ({node_exe:?}): {e}"))?;

    let start = Instant::now();
    let output = loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                break child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to read web_task output: {e}"))?;
            }
            Ok(None) => {
                if start.elapsed() >= process_timeout {
                    let _ = child.kill();
                    return Err(format!(
                        "web_task timed out after {}ms",
                        process_timeout.as_millis()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Failed to poll web_task process: {e}")),
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    let json_start = stdout.find('{').ok_or_else(|| {
        format!("No JSON found in web_task output.\nstdout: {stdout}\nstderr: {stderr}")
    })?;
    let json_str = &stdout[json_start..];

    serde_json::from_str::<WebTaskOutput>(json_str)
        .map_err(|e| format!("Failed to parse web_task output: {e}\nraw: {json_str}"))
}

/// Opens `url` in a Playwright-driven Chromium window. Used when the user
/// clicks a link inside the in-app terminal (see WebLinksAddon wiring in
/// TerminalPanel.tsx). The launched browser process is intentionally left
/// running (detached) after this command returns so the window stays open —
/// this command only waits long enough to know whether the launch itself
/// succeeded.
///
/// `background` mirrors the "Open links in the background" setting (Settings
/// > Terminal, see useTerminalSettingsStore.ts). When `false` (the default)
/// the window opens in the foreground, clearly visible and focused. When
/// `true` it's launched the same way but immediately minimized so it doesn't
/// steal focus from the IDE.
///
/// Returns `Ok(())` if a Playwright/Chromium window was launched. Returns
/// `Err(message)` if Playwright isn't installed (or fails to launch), so the
/// frontend can fall back to opening the link in the OS default browser.
#[tauri::command]
pub async fn open_terminal_link(app: tauri::AppHandle, url: String, background: Option<bool>) -> CmdResult<()> {
    let opener_js = resolve_resource_path(&app, &["lib", "browser-tool", "open-link.js"])?;
    let opener_js = opener_js.to_string_lossy().replace(r"\\?\", "");

    let node_exe = find_node()?;

    let mut child = Command::new(&node_exe)
        .arg(opener_js.as_str())
        .arg(&url)
        .arg(if background.unwrap_or(false) { "--background" } else { "--foreground" })
        .no_window()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn node ({node_exe:?}): {e}"))?;

    // We only need the FIRST line of stdout — { "ok": true } once the
    // Chromium window is up, or { "ok": false, "error": "..." } if
    // Playwright isn't installed / failed to launch. The process is then
    // left running (or, on failure, it has already exited on its own) —
    // we deliberately do not wait_with_output() here, since a successful
    // launch never exits on its own while the window stays open.
    let stdout = child.stdout.take().ok_or("Failed to capture opener stdout")?;
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();

    let start = Instant::now();
    let timeout = Duration::from_secs(20);
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                // EOF before any line — process exited without reporting.
                return Err("Playwright process exited without a response.".to_string());
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    if start.elapsed() >= timeout {
                        return Err("Timed out waiting for Playwright to launch.".to_string());
                    }
                    continue;
                }
                let parsed: serde_json::Value = serde_json::from_str(trimmed)
                    .map_err(|e| format!("Failed to parse opener output: {e} (raw: {trimmed})"))?;
                let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                if ok {
                    return Ok(());
                }
                let error = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Playwright is not installed.")
                    .to_string();
                return Err(error);
            }
            Err(e) => return Err(format!("Failed to read opener output: {e}")),
        }
    }
}

// ── Shell invocation builder ───────────────────────────────────────────────
//
// Maps a detected shell identifier to the (program, args) pair used to run
// a raw command string through that shell. Mirrors lib/systemInfo.ts /
// services/agent/types.ts `DetectedShell`.
fn build_shell_invocation(shell: &str, command: &str) -> (String, Vec<String>) {
    match shell {
        "powershell" => (
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        ),
        "cmd" => (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), command.to_string()],
        ),
        "zsh" => ("zsh".to_string(), vec!["-c".to_string(), command.to_string()]),
        "bash" => ("bash".to_string(), vec!["-c".to_string(), command.to_string()]),
        // "sh" and any unrecognised value fall back to /bin/sh -c.
        _ => ("sh".to_string(), vec!["-c".to_string(), command.to_string()]),
    }
}

// ── Shell-style word split (no glob, no pipe) ─────────────────────────────────
//
// Handles single/double-quoted tokens and basic backslash escapes.
// Not a full POSIX parser — covers the common cases used by build tools.
fn shell_split(s: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = s.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;

    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
            }
            '"' if !in_single => {
                in_double = !in_double;
            }
            '\\' if !in_single => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ' ' | '\t' if !in_single && !in_double => {
                if !current.is_empty() {
                    tokens.push(current.clone());
                    current.clear();
                }
            }
            other => {
                current.push(other);
            }
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

// ── PTY terminal (interactive shell) ─────────────────────────────────────────
//
// Provides three commands for the interactive VS Code-style terminal panel:
//
//   pty_create(id, cwd)        – spawn a shell in a real PTY, stream output
//                                 back via `terminal-output-{id}` events
//   pty_write(id, data)        – write keystrokes / paste data to the PTY
//   pty_resize(id, cols, rows) – inform the PTY of a resize
//   pty_kill(id)               – terminate the PTY process
//
// Implementation:
//   On Unix/macOS we use the `portable-pty` crate for proper PTY allocation.
//   On Windows we fall back to a ConPTY via the same `portable-pty` crate.
//   A global HashMap keyed on `id` stores the live PTY + writer half so that
//   subsequent pty_write / pty_resize / pty_kill calls can find it.
//
// NOTE: `portable-pty` must be added to Cargo.toml — we do that in the
//       updated Cargo.toml that ships with this patch.

use std::collections::HashMap;
use std::sync::Mutex;
// ── proxy_llm_stream ──────────────────────────────────────────────────────────
//
// Performs a streaming LLM chat-completions request (SSE) from the Rust side
// using reqwest — NOT the webview's `fetch` — so it is completely immune to
// the browser CORS restrictions that affect Zenmux and any other provider
// whose server does not include Tauri's internal origin in its
// Access-Control-Allow-Origin header.
//
// For each SSE data line the command emits a Tauri event:
//   "llm-stream-chunk-{event_id}"  →  { data: "<raw JSON string from SSE>" }
//   "llm-stream-done-{event_id}"   →  { ok: true }   (after [DONE] or EOF)
//   "llm-stream-error-{event_id}"  →  { message: "…" }
//
// The TypeScript caller (ZenmuxProvider.stream) registers listeners for these
// events, parses the JSON chunks the same way the generic openaiCompatible
// stream helper does, and invokes the StreamCallbacks.

#[derive(serde::Serialize, Clone)]
pub struct LlmStreamChunkPayload { pub data: String }

#[derive(serde::Serialize, Clone)]
pub struct LlmStreamDonePayload  { pub ok: bool }

#[derive(serde::Serialize, Clone)]
pub struct LlmStreamErrorPayload { pub message: String }

#[tauri::command]
pub async fn proxy_llm_stream(
    app: tauri::AppHandle,
    event_id: String,
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_seconds: Option<u64>,
) -> CmdResult<()> {
    use futures_util::StreamExt;

    let timeout_secs = timeout_seconds.unwrap_or(120).min(600);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("proxy_llm_stream: failed to build HTTP client: {e}"))?;

    let mut req = client.post(&url).body(body);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                &format!("llm-stream-error-{event_id}"),
                LlmStreamErrorPayload { message: format!("Request failed: {e}") },
            );
            return Ok(());
        }
    };

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let err_body = response.text().await.unwrap_or_default();
        let _ = app.emit(
            &format!("llm-stream-error-{event_id}"),
            LlmStreamErrorPayload {
                message: format!("Zenmux API error {status}: {err_body}"),
            },
        );
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    // Accumulate partial lines across byte chunks
    let mut line_buf = String::new();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                line_buf.push_str(&String::from_utf8_lossy(&bytes));

                // Drain complete newline-terminated lines from the buffer
                loop {
                    match line_buf.find('\n') {
                        None => break,
                        Some(pos) => {
                            let raw_line = line_buf[..pos].trim().to_string();
                            line_buf = line_buf[pos + 1..].to_string();

                            if !raw_line.starts_with("data:") {
                                continue;
                            }
                            let data = raw_line[5..].trim().to_string();
                            if data == "[DONE]" {
                                let _ = app.emit(
                                    &format!("llm-stream-done-{event_id}"),
                                    LlmStreamDonePayload { ok: true },
                                );
                                return Ok(());
                            }
                            if !data.is_empty() {
                                let _ = app.emit(
                                    &format!("llm-stream-chunk-{event_id}"),
                                    LlmStreamChunkPayload { data },
                                );
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    &format!("llm-stream-error-{event_id}"),
                    LlmStreamErrorPayload { message: format!("Stream read error: {e}") },
                );
                return Ok(());
            }
        }
    }

    // Stream ended without an explicit [DONE] — still signal completion.
    let _ = app.emit(
        &format!("llm-stream-done-{event_id}"),
        LlmStreamDonePayload { ok: true },
    );
    Ok(())
}

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

// ── Global PTY registry ───────────────────────────────────────────────────
struct PtySession {
    master:  Box<dyn MasterPty + Send>,
    writer:  Box<dyn Write + Send>,
    _child:  Box<dyn Child + Send + Sync>,
    /// OS pid of the shell process spawned for this session, if the
    /// platform/backend exposes one (portable-pty's `Child::process_id`).
    /// Used by pty_kill / kill_all_pty_sessions to force-stop the WHOLE
    /// process tree the shell spawned (e.g. `npm run dev`, a build
    /// watcher, ...) — not just the shell itself — when the terminal
    /// closes, so nothing lingers behind as an orphan.
    pid: Option<u32>,
}

// Safety: PtySession is only ever accessed behind a Mutex.
unsafe impl Send for PtySession {}

static PTY_SESSIONS: Mutex<Option<HashMap<String, PtySession>>> = Mutex::new(None);

fn with_sessions<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, PtySession>) -> R,
{
    let mut guard = PTY_SESSIONS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Kills `root_pid` and every process descended from it (children,
/// grandchildren, ...). Used when a terminal pane closes so that anything
/// the shell started in that pane (a dev server, a build watcher, a
/// long-running script, ...) is force-stopped along with it, instead of
/// surviving as an orphaned background process once the pane disappears
/// from the UI.
fn kill_process_tree(root_pid: u32) {
    use sysinfo::{Pid, System};

    let mut sys = System::new_all();
    sys.refresh_all();

    let root = Pid::from_u32(root_pid);

    // Walk sysinfo's parent-pid links to collect every pid descended from
    // root_pid — the whole tree, not just direct children.
    let mut to_kill: Vec<Pid> = vec![root];
    let mut frontier: Vec<Pid> = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, process) in sys.processes() {
            if process.parent() == Some(parent) && !to_kill.contains(pid) {
                to_kill.push(*pid);
                frontier.push(*pid);
            }
        }
    }

    // Kill leaf-most processes first (children were appended after their
    // parents above, so iterating in reverse approximates that order),
    // then the root shell itself, so nothing left running gets a chance
    // to respawn a child that would otherwise outlive its own parent.
    for pid in to_kill.iter().rev() {
        if let Some(process) = sys.process(*pid) {
            process.kill();
        }
    }
}

/// Force-stops every PTY session still registered (and everything each one
/// spawned — see kill_process_tree) and empties the registry. Called both
/// from pty_kill (a single closed terminal pane) and on app exit (see
/// main.rs's RunEvent::Exit handler), so quitting the whole app doesn't
/// leave terminal-spawned processes running in the background either.
pub fn kill_all_pty_sessions() {
    let pids: Vec<u32> = with_sessions(|map| {
        let pids = map.values().filter_map(|s| s.pid).collect();
        map.clear();
        pids
    });
    for pid in pids {
        kill_process_tree(pid);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Detect the user's preferred login shell.
fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
    #[cfg(windows)]
    {
        // Prefer PowerShell if available, fall back to cmd.exe
        if std::path::Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe").exists() {
            "powershell.exe".to_string()
        } else {
            "cmd.exe".to_string()
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Spawn a real PTY shell and begin streaming output back as Tauri events.
#[tauri::command]
pub async fn pty_create(
    app:  tauri::AppHandle,
    id:   String,
    cwd:  Option<String>,
) -> CmdResult<()> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width:  0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);

    // Start in the project root if provided
    if let Some(dir) = &cwd {
        cmd.cwd(dir);
    }

    // Inherit the current environment
    cmd.env("TERM", "xterm-256color");
    if let Some(entry) = managed_node_path_entry() {
        let mut paths = vec![entry];
        if let Some(existing) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&existing)); }
        if let Ok(joined) = std::env::join_paths(paths) { cmd.env("PATH", joined); }
    }

    let child = pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{shell}': {e}"))?;
    let pid = child.process_id();

    let writer = pair.master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Stream PTY output to the renderer in a background thread
    let mut reader = pair.master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let app_clone = app.clone();
    let id_clone  = id.clone();

    std::thread::spawn(move || {
        let event = format!("terminal-output-{id_clone}");
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_clone.emit(&event, data);
                }
            }
        }
        // Shell exited — notify renderer so it can display "[Process exited]"
        let _ = app_clone.emit(&format!("terminal-exit-{id_clone}"), ());
    });

    with_sessions(|map| {
        map.insert(id, PtySession {
            master: pair.master,
            writer,
            _child: child,
            pid,
        });
    });

    Ok(())
}

/// Write data (keystrokes, paste) into the PTY stdin.
#[tauri::command]
pub async fn pty_write(id: String, data: String) -> CmdResult<()> {
    with_sessions(|map| {
        if let Some(session) = map.get_mut(&id) {
            session.writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("PTY write error: {e}"))
        } else {
            Err(format!("No PTY session with id '{id}'"))
        }
    })
}

/// Inform the PTY of a resize so the shell reflows correctly.
#[tauri::command]
pub async fn pty_resize(id: String, cols: u16, rows: u16) -> CmdResult<()> {
    with_sessions(|map| {
        if let Some(session) = map.get_mut(&id) {
            session.master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("PTY resize error: {e}"))
        } else {
            Ok(()) // ignore resize for dead sessions
        }
    })
}

/// Kill the PTY process and remove it from the registry.
#[tauri::command]
pub async fn pty_kill(id: String) -> CmdResult<()> {
    let pid = with_sessions(|map| map.remove(&id).and_then(|session| session.pid));

    // Force-stop everything this shell spawned (a dev server, a build
    // watcher, a long-running script, ...), not just the shell process
    // itself — otherwise those keep running in the background even though
    // the terminal pane they were started in has closed.
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }

    Ok(())
}
// ============================================================================
// ── GIT INTEGRATION ─────────────────────────────────────────────────────────
// ============================================================================
//
// All git operations shell out to the system `git` binary via
// std::process::Command (no libgit2 / git2 crate). Every command takes the
// workspace root as `root` and runs `git -C <root> ...` so it works
// regardless of the IDE's own current working directory.
//
// Append this block to the bottom of src-tauri/src/commands.rs.
// Required imports already present at the top of commands.rs:
//   use std::process::Command;
// No additional `use` statements are needed beyond what commands.rs already
// has (serde derives are referenced via the fully-qualified `serde::...`
// path, matching the existing style in this file).

// ── git helper ───────────────────────────────────────────────────────────
//
// Runs `git -C <root> <args>` and returns (stdout, stderr, success).
// stdout/stderr are lossily converted to UTF-8 (binary-safe enough for the
// plain-text output git produces for status/diff/log/branch/commit/push/pull).
fn run_git(root: &str, args: &[&str]) -> CmdResult<(String, String, bool)> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err(format!("Workspace root does not exist: {root}"));
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .no_window()
        .output()
        .map_err(|e| format!("Failed to run git (is it installed and on PATH?): {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    Ok((stdout, stderr, output.status.success()))
}

/// Like `run_git`, but maps a non-zero exit code straight into `Err(stderr)`.
/// Used by mutating commands (stage/unstage/commit/push/pull/checkout) where
/// the caller just wants `Result<(), String>` / `Result<String, String>`.
fn run_git_ok(root: &str, args: &[&str]) -> CmdResult<String> {
    let (stdout, stderr, success) = run_git(root, args)?;
    if success {
        Ok(stdout)
    } else {
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(if msg.trim().is_empty() {
            format!("git {} failed with no output", args.join(" "))
        } else {
            msg.trim().to_string()
        })
    }
}

// ── git_status ───────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct GitFileStatus {
    /// Path relative to the workspace root (forward-slash separated, as git emits it).
    pub path: String,
    /// Single-letter-ish status code: "M" (modified), "A" (added), "D" (deleted),
    /// "R" (renamed), "C" (copied), "U" (unmerged/conflict), or "??" (untracked).
    pub status: String,
    /// True if this entry reflects a change already staged in the index.
    /// False if it's an unstaged working-tree change (or untracked file).
    pub staged: bool,
    /// For renames/copies: the original path, if known.
    pub original_path: Option<String>,
}

fn status_code_to_label(c: char) -> String {
    match c {
        'M' => "M".to_string(),
        'A' => "A".to_string(),
        'D' => "D".to_string(),
        'R' => "R".to_string(),
        'C' => "C".to_string(),
        'U' => "U".to_string(),
        'T' => "T".to_string(), // type change
        _   => c.to_string(),
    }
}

/// Returns the working-tree + index status of every changed/untracked file,
/// mirroring `git status --porcelain=v1`. Renames/staged/unstaged changes to
/// the same path are each emitted as their own entry so the frontend can
/// bucket them into "Staged" / "Unstaged" sections independently.
#[tauri::command]
pub async fn git_status(root: String) -> CmdResult<Vec<GitFileStatus>> {
    // -z: NUL-separated records, untranslated paths — robust for filenames
    // with spaces/unicode and avoids quoting weirdness.
    let (stdout, stderr, success) = run_git(&root, &["status", "--porcelain=v1", "-z"])?;
    if !success {
        return Err(if stderr.trim().is_empty() { "git status failed".to_string() } else { stderr });
    }

    let mut result = Vec::new();
    let mut parts = stdout.split('\0').filter(|s| !s.is_empty());

    while let Some(entry) = parts.next() {
        if entry.len() < 3 {
            continue;
        }
        let mut chars = entry.chars();
        let x = chars.next().unwrap_or(' '); // index/staged status
        let y = chars.next().unwrap_or(' '); // worktree/unstaged status
        // entry[3..] is the path (after "XY ")
        let path = entry.get(3..).unwrap_or("").to_string();

        let is_rename_or_copy = x == 'R' || x == 'C';
        let mut original_path: Option<String> = None;
        let mut current_path = path.clone();

        if is_rename_or_copy {
            // For -z renames, the NEXT NUL-separated record is the original path.
            if let Some(orig) = parts.next() {
                original_path = Some(orig.to_string());
            }
        } else {
            current_path = path;
        }

        if x == '?' && y == '?' {
            result.push(GitFileStatus {
                path: current_path,
                status: "??".to_string(),
                staged: false,
                original_path: None,
            });
            continue;
        }

        if x == 'U' || y == 'U' || (x == 'D' && y == 'D') || (x == 'A' && y == 'A') {
            // Unmerged / conflicted entry.
            result.push(GitFileStatus {
                path: current_path,
                status: "U".to_string(),
                staged: false,
                original_path: None,
            });
            continue;
        }

        // Staged (index) change.
        if x != ' ' && x != '?' {
            result.push(GitFileStatus {
                path: current_path.clone(),
                status: status_code_to_label(x),
                staged: true,
                original_path: original_path.clone(),
            });
        }

        // Unstaged (worktree) change.
        if y != ' ' && y != '?' {
            result.push(GitFileStatus {
                path: current_path,
                status: status_code_to_label(y),
                staged: false,
                original_path,
            });
        }
    }

    Ok(result)
}

// ── git_diff ─────────────────────────────────────────────────────────────

/// Returns the unified diff for `file_path` (or the whole working tree when
/// `None`). When `staged` is `Some(true)`, returns the diff between the index
/// and HEAD (i.e. what `git diff --cached` shows — the staged changes);
/// otherwise returns the working-tree-vs-index diff (unstaged changes).
#[tauri::command]
pub async fn git_diff(
    root: String,
    file_path: Option<String>,
    staged: Option<bool>,
) -> CmdResult<String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }
    args.push("--no-color");

    if let Some(ref path) = file_path {
        args.push("--");
        args.push(path.as_str());
    }

    let (stdout, stderr, success) = run_git(&root, &args)?;
    if !success {
        return Err(if stderr.trim().is_empty() { "git diff failed".to_string() } else { stderr });
    }

    // Untracked files don't show up in `git diff` at all — synthesize a
    // pseudo-diff so the frontend can still render "new file" content.
    if stdout.trim().is_empty() {
        if let Some(path) = &file_path {
            if !staged.unwrap_or(false) {
                let (st_out, _, st_ok) = run_git(&root, &["status", "--porcelain=v1", "--", path.as_str()])?;
                if st_ok && st_out.starts_with("??") {
                    let full = PathBuf::from(&root).join(path);
                    if let Ok(contents) = fs::read_to_string(&full) {
                        let line_count = contents.lines().count().max(1);
                        let mut synthetic = String::new();
                        synthetic.push_str(&format!("diff --git a/{path} b/{path}\n"));
                        synthetic.push_str("new file mode 100644\n");
                        synthetic.push_str("--- /dev/null\n");
                        synthetic.push_str(&format!("+++ b/{path}\n"));
                        synthetic.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
                        for line in contents.lines() {
                            synthetic.push('+');
                            synthetic.push_str(line);
                            synthetic.push('\n');
                        }
                        return Ok(synthetic);
                    }
                }
            }
        }
    }

    Ok(stdout)
}

// ── git_stage / git_unstage ─────────────────────────────────────────────

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> CmdResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run_git_ok(&root, &args)?;
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> CmdResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run_git_ok(&root, &args)?;
    Ok(())
}

// ── git_commit ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> CmdResult<()> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    run_git_ok(&root, &["commit", "-m", trimmed])?;
    Ok(())
}

// ── git_push / git_pull ─────────────────────────────────────────────────

#[tauri::command]
pub async fn git_push(root: String) -> CmdResult<String> {
    // git often writes progress/status info to stderr even on success
    // (e.g. "Everything up-to-date", branch tracking info), so surface
    // whichever stream has content on success.
    let (stdout, stderr, success) = run_git(&root, &["push"])?;
    if success {
        Ok(if stdout.trim().is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.trim().is_empty() { stdout } else { stderr })
    }
}

#[tauri::command]
pub async fn git_pull(root: String) -> CmdResult<String> {
    let (stdout, stderr, success) = run_git(&root, &["pull"])?;
    if success {
        Ok(if stdout.trim().is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.trim().is_empty() { stdout } else { stderr })
    }
}

// ── git_branches ─────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

#[tauri::command]
pub async fn git_branches(root: String) -> CmdResult<Vec<BranchInfo>> {
    // Format: "<HEAD marker>\x1f<full refname>\x1f<short refname>"
    let fmt = "%(HEAD)\x1f%(refname)\x1f%(refname:short)";
    let (stdout, stderr, success) = run_git(&root, &["branch", "-a", "--format", fmt])?;
    if !success {
        return Err(if stderr.trim().is_empty() { "git branch failed".to_string() } else { stderr });
    }

    let mut branches = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.split('\u{1f}');
        let head_marker = fields.next().unwrap_or("");
        let full_ref    = fields.next().unwrap_or("");
        let short_ref   = fields.next().unwrap_or("").to_string();

        if short_ref.is_empty() {
            continue;
        }
        // Skip the symbolic "origin/HEAD -> origin/main" pointer entry.
        if short_ref.contains(" -> ") {
            continue;
        }

        let is_remote = full_ref.starts_with("refs/remotes/");
        let is_current = head_marker.trim() == "*";

        branches.push(BranchInfo {
            name: short_ref,
            is_current,
            is_remote,
        });
    }

    Ok(branches)
}

// ── git_switch_branch / git_create_branch ───────────────────────────────

#[tauri::command]
pub async fn git_switch_branch(root: String, branch: String) -> CmdResult<()> {
    run_git_ok(&root, &["checkout", branch.as_str()])?;
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(root: String, name: String) -> CmdResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    run_git_ok(&root, &["checkout", "-b", trimmed])?;
    Ok(())
}

// ── git_log ──────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

#[tauri::command]
pub async fn git_log(root: String, limit: u32) -> CmdResult<Vec<CommitInfo>> {
    let n = limit.max(1).to_string();
    // \x1f (unit separator) between fields — safe since commit messages/authors
    // essentially never contain it, unlike commas or pipes.
    let fmt = "%H\x1f%an\x1f%ad\x1f%s";
    let pretty_arg = format!("--pretty=format:{fmt}");
    let (stdout, stderr, success) = run_git(
        &root,
        &["log", "-n", n.as_str(), pretty_arg.as_str(), "--date=iso-strict"],
    )?;

    if !success {
        // Empty repo (no commits yet) — return an empty list instead of an error.
        if stderr.contains("does not have any commits") || stderr.contains("bad default revision") {
            return Ok(vec![]);
        }
        return Err(if stderr.trim().is_empty() { "git log failed".to_string() } else { stderr });
    }

    let mut commits = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.splitn(4, '\u{1f}');
        let hash    = fields.next().unwrap_or("").to_string();
        let author  = fields.next().unwrap_or("").to_string();
        let date    = fields.next().unwrap_or("").to_string();
        let message = fields.next().unwrap_or("").to_string();

        if hash.is_empty() {
            continue;
        }
        commits.push(CommitInfo { hash, message, author, date });
    }

    Ok(commits)
}

// ── get_home_dir ──────────────────────────────────────────────────────────────
//
// Returns the current user's home directory as a string.
// Used by DoctorPanel's "Run Fix" button to set a safe cwd for install commands.

#[tauri::command]
pub async fn get_home_dir() -> CmdResult<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .or_else(|_| std::env::var("HOMEPATH"))
        .unwrap_or_else(|_| {
            // Last resort: use current dir
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| "/tmp".to_string())
        });
    Ok(home)
}

// ── doctor_check ──────────────────────────────────────────────────────────────
//
// Runs a set of environment checks and returns them as a list of structured
// results. The frontend DoctorPanel renders these as pass/warn/fail rows with
// optional fix instructions and one-click install commands.
//
// Checks are intentionally grouped: core IDE requirements first (Node.js, the
// repo-scanner itself), then language support (LSP servers), then optional
// capabilities (Ollama for semantic search, Playwright for browser_check).
// Each check returns a status (ok/warn/fail) and a short human-readable
// `detail` so the Doctor panel can display meaningful feedback without the
// user having to open a terminal.

// Emitted for every command Doctor runs so the frontend can mirror it into
// the in-app Terminal panel (a read-only "Doctor Check" tab) — this is
// purely a visibility feed, never an OS terminal window, and never affects
// the actual check logic below.
#[derive(serde::Serialize, Clone)]
pub struct DoctorLogPayload {
    pub line: String,
}

fn emit_doctor_log(app: &tauri::AppHandle, line: impl Into<String>) {
    let _ = app.emit("doctor-log", DoctorLogPayload { line: line.into() });
}

#[derive(serde::Serialize, Clone)]
pub struct DoctorCheckResult {
    pub id:          String,
    pub label:       String,
    pub group:       String,
    pub status:      String, // "ok" | "warn" | "fail"
    pub detail:      String,
    pub version:     Option<String>,
    pub fix_hint:    Option<String>,
    pub fix_command: Option<String>, // shell command the user can copy/run
}

pub(crate) fn run_version_command(program: &str, args: &[&str]) -> Option<String> {
    // On Windows, npm/npx ship as `.cmd` shims, not real .exe files.
    // Command::new()/CreateProcess does not do the PATHEXT resolution a
    // shell does, so Command::new("npm") fails to find them even though
    // `npm --version` works fine when typed in a terminal. node.exe is a
    // real executable so it's unaffected — that's why Doctor found Node
    // but not npm.
    #[cfg(target_os = "windows")]
    {
        for candidate in [format!("{program}.cmd"), format!("{program}.exe"), program.to_string()] {
            if let Some(out) = Command::new(&candidate).args(args).no_window().output().ok().filter(|o| o.status.success()) {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = text.lines().next() {
                    return Some(line.trim().to_string());
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
            .args(args)
            .no_window()
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                let out = String::from_utf8_lossy(&o.stdout);
                let line = out.lines().next()?;
                Some(line.trim().to_string())
            })
    }
}

pub(crate) fn which_found(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        // Same PATHEXT issue as above — "where" itself is a real .exe so
        // it's fine, but check .cmd/.exe variants of the target explicitly
        // since `where npm` can still miss shims in some PATH orderings.
        for candidate in [format!("{name}.cmd"), format!("{name}.exe"), name.to_string()] {
            if Command::new("where").arg(&candidate).no_window().output().map(|o| o.status.success()).unwrap_or(false) {
                return true;
            }
        }
        return false;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("which").arg(name).no_window().output().map(|o| o.status.success()).unwrap_or(false)
    }
}

/// Managed Node.js runtime version. Downloaded straight from nodejs.org, so
/// first-run setup needs no Rachna account, no Rachna backend, and works for
/// anyone who builds the (open-source) harness. Bump here to ship a newer
/// runtime; the install dir below is version-agnostic, so an existing install
/// is kept until the person deletes it.
const MANAGED_NODE_VERSION: &str = "22.11.0";

/// Official nodejs.org archive URL for this OS/arch.
fn node_download_url() -> CmdResult<String> {
    let v = MANAGED_NODE_VERSION;
    #[cfg(target_os = "windows")]
    let platform = "win-x64.zip";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let platform = "darwin-arm64.tar.gz";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let platform = "darwin-x64.tar.gz";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let platform = "linux-x64.tar.gz";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let platform = "linux-arm64.tar.gz";
    Ok(format!("https://nodejs.org/dist/v{v}/node-v{v}-{platform}"))
}

fn node_archive_name(url: &str) -> &str {
    url.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("node-runtime")
}

fn node_target_dir(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    let base = local_data_dir(app).map_err(io_err)?;
    #[cfg(target_os = "windows")]
    let dir = base.join("node").join("windows-x64");
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let dir = base.join("node").join("macos-arm64");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let dir = base.join("node").join("macos-x64");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let dir = base.join("node").join("linux-x64");
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let dir = base.join("node").join("linux-arm64");
    Ok(dir)
}

fn validate_managed_node_dir(dir: &PathBuf) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    let required = [dir.join("node.exe"), dir.join("npm.cmd"), dir.join("npx.cmd")];
    #[cfg(not(target_os = "windows"))]
    let required = [dir.join("bin/node"), dir.join("bin/npm"), dir.join("bin/npx")];

    let missing: Vec<String> = required.iter()
        .filter(|p| !p.exists())
        .map(|p| p.display().to_string())
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("Downloaded Node.js runtime is missing required files: {}", missing.join(", ")))
    }
}

fn extract_node_archive(archive_path: &PathBuf, temp_dir: &PathBuf) -> CmdResult<()> {
    let name = archive_path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_ascii_lowercase();
    if name.ends_with(".zip") {
        #[cfg(target_os = "windows")]
        {
            let status = Command::new("powershell").args(["-NoProfile", "-Command"])
                .arg(format!("Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force", archive_path.display(), temp_dir.display()))
                .no_window()
                .status().map_err(io_err)?;
            if status.success() { return Ok(()); }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let status = Command::new("unzip").arg("-q").arg(archive_path).arg("-d").arg(temp_dir).no_window().status().map_err(io_err)?;
            if status.success() { return Ok(()); }
        }
        return Err("Failed to unzip downloaded Node.js runtime".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("powershell").args(["-NoProfile", "-Command"])
            .arg(format!("Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force", archive_path.display(), temp_dir.display()))
            .no_window()
            .status().map_err(io_err)?;
        if status.success() { return Ok(()); }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("tar").arg("-xf").arg(archive_path).arg("-C").arg(temp_dir).no_window().status().map_err(io_err)?;
        if status.success() { return Ok(()); }
    }

    Err("Failed to extract downloaded Node.js runtime".to_string())
}

// Serializes concurrent callers of `ensure_managed_node`. It's invoked from
// two places — once at app startup (see `ensure_node_runtime` below, called
// from App.tsx) and once as the first step of every `doctor_check` — so
// without this lock two overlapping calls could both see "not installed yet"
// and race to download/extract into the same target directory.
static NODE_INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn ensure_managed_node(app: &tauri::AppHandle) -> CmdResult<Option<String>> {
    let _guard = NODE_INSTALL_LOCK.lock().await;
    let target_dir = node_target_dir(app)?;
    std::env::set_var("RACHNA_MANAGED_NODE_DIR", &target_dir);
    if managed_node_bin("node").is_some() && managed_node_bin("npm").is_some() && managed_node_bin("npx").is_some() {
        return Ok(Some("Managed Node.js runtime is already installed".to_string()));
    }

    // No sign-in required: the runtime comes from nodejs.org directly.
    let link = node_download_url()?;
    let client = reqwest::Client::new();

    let archive_res = client.get(&link).header(header::USER_AGENT, "Rachna-AI-Studio").send().await
        .map_err(|e| format!("Failed to download Node.js runtime: {e}"))?;
    if !archive_res.status().is_success() {
        return Err(format!("Node.js runtime download failed with HTTP {}", archive_res.status()));
    }

    let temp_dir = target_dir.with_extension("download");
    let archive_path = temp_dir.join(node_archive_name(&link));
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir).map_err(io_err)?;
    let bytes = archive_res.bytes().await.map_err(|e| e.to_string())?;
    fs::File::create(&archive_path).and_then(|mut f| f.write_all(&bytes)).map_err(io_err)?;

    extract_node_archive(&archive_path, &temp_dir)?;

    let extracted = fs::read_dir(&temp_dir).map_err(io_err)?
        .filter_map(|e| e.ok()).map(|e| e.path())
        .find(|p| p.is_dir() && p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("node-")).unwrap_or(false))
        .ok_or_else(|| "Downloaded Node.js archive did not contain a node-* directory".to_string())?;
    let _ = fs::remove_dir_all(&target_dir);
    fs::create_dir_all(target_dir.parent().unwrap_or(&target_dir)).map_err(io_err)?;
    fs::rename(&extracted, &target_dir).map_err(io_err)?;
    let _ = fs::remove_dir_all(&temp_dir);

    #[cfg(unix)]
    {
        let _ = Command::new("chmod").arg("+x").arg(target_dir.join("bin/node")).arg(target_dir.join("bin/npm")).arg(target_dir.join("bin/npx")).no_window().status();
    }

    validate_managed_node_dir(&target_dir)?;
    Ok(Some(format!("Downloaded and verified Node.js runtime from {}", link)))
}

// ── ensure_node_runtime ──────────────────────────────────────────────────────
//
// Thin public wrapper around `ensure_managed_node` so the frontend can kick
// off the Node.js download at app startup (see App.tsx), rather than waiting
// for `doctor_check` to run on IDELayout mount. The two calls share `NODE_INSTALL_LOCK` above, so
// whichever one runs first does the actual download and the other just
// observes "already installed" once it acquires the lock.
#[tauri::command]
pub async fn ensure_node_runtime(app: tauri::AppHandle) -> CmdResult<Option<String>> {
    ensure_managed_node(&app).await
}

fn run_runtime_version_command(program: &str, args: &[&str]) -> Option<String> {
    managed_node_bin(program)
        .and_then(|p| run_version_command(&p.to_string_lossy(), args))
        .or_else(|| run_version_command(program, args))
}

// ── Project language detection ──────────────────────────────────────────────
//
// Doctor used to demand Rust, Python, and Go (plus their LSP servers) on
// every machine, regardless of what the open project actually contains.
// That's backwards for a solo dev bouncing between a Go backend, a Tauri
// desktop app, and a handful of Node/React sites — nobody should be told to
// install Go+gopls just to open a plain JS project. Instead we peek at the
// open project (marker files first, a shallow bounded scan as a fallback)
// and only surface checks for languages that are actually present. If no
// project is open yet (e.g. the very first launch, before any folder is
// picked), we skip language-specific checks entirely — they aren't needed
// yet, so Doctor shouldn't ask for them yet.
#[derive(Default, Clone, Copy)]
pub(crate) struct ProjectLanguages {
    pub(crate) rust: bool,
    pub(crate) python: bool,
    pub(crate) go: bool,
    pub(crate) js_ts: bool,
    // Added alongside the LSP downloader (see lsp_install.rs) so more
    // project types get Doctor "Languages"/"LSP Servers" rows without
    // needing their own bespoke detection pass — same marker-file-then-
    // extension-scan shape as the four above, just more of them.
    pub(crate) java: bool,
    pub(crate) csharp: bool,
    pub(crate) php: bool,
    pub(crate) ruby: bool,
    pub(crate) dart: bool,
    pub(crate) cpp: bool,
}

const LANG_SCAN_IGNORE_DIRS: &[&str] = &[
    "node_modules", "target", ".git", "dist", "build", "vendor",
    "__pycache__", ".venv", "venv", ".next", "out", ".cargo",
];

pub(crate) fn detect_project_languages(project_root: Option<&str>) -> ProjectLanguages {
    let mut langs = ProjectLanguages::default();
    let Some(root) = project_root else { return langs };
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return langs;
    }

    // Fast path: well-known marker files at the project root. Covers the
    // vast majority of real projects with a single fs::metadata call each.
    if root.join("Cargo.toml").exists() {
        langs.rust = true;
    }
    if root.join("go.mod").exists() {
        langs.go = true;
    }
    if root.join("package.json").exists() || root.join("tsconfig.json").exists() {
        langs.js_ts = true;
    }
    if root.join("requirements.txt").exists()
        || root.join("pyproject.toml").exists()
        || root.join("setup.py").exists()
        || root.join("Pipfile").exists()
    {
        langs.python = true;
    }
    if root.join("pom.xml").exists() || root.join("build.gradle").exists() || root.join("build.gradle.kts").exists() {
        langs.java = true;
    }
    if root.join("Gemfile").exists() {
        langs.ruby = true;
    }
    if root.join("composer.json").exists() {
        langs.php = true;
    }
    if root.join("pubspec.yaml").exists() {
        langs.dart = true;
    }
    if root.join("CMakeLists.txt").exists() {
        langs.cpp = true;
    }
    // .csproj/.sln don't have one fixed name — a shallow root-only glob
    // covers the common case (solution/project file at the repo root)
    // cheaply, without needing the recursive scan below just for this.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                if ext == "csproj" || ext == "sln" {
                    langs.csharp = true;
                }
            }
        }
    }

    if langs.rust && langs.go && langs.js_ts && langs.python
        && langs.java && langs.csharp && langs.php && langs.ruby && langs.dart && langs.cpp {
        return langs;
    }

    // Fallback: shallow, bounded breadth-first scan for source extensions,
    // in case a project has no marker file (e.g. a bare .py script) or one
    // is nested a level or two down in a monorepo (backend/ + frontend/).
    // Bounded by depth and total entries visited so this stays cheap even
    // on large repos — this only needs to answer "is X present at all?",
    // not build a full file index.
    let mut queue: std::collections::VecDeque<(PathBuf, u32)> = std::collections::VecDeque::new();
    queue.push_back((root, 0));
    let mut visited = 0u32;
    const MAX_DEPTH: u32 = 3;
    const MAX_ENTRIES: u32 = 4000;

    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= MAX_ENTRIES || (langs.rust && langs.go && langs.js_ts && langs.python
            && langs.java && langs.csharp && langs.php && langs.ruby && langs.dart && langs.cpp) {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited >= MAX_ENTRIES {
                break;
            }
            let path = entry.path();
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();

            if path.is_dir() {
                if (name.starts_with('.') && name.as_ref() != ".") || LANG_SCAN_IGNORE_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                if depth < MAX_DEPTH {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }

            match path.extension().and_then(|e| e.to_str()) {
                Some("rs") => langs.rust = true,
                Some("go") => langs.go = true,
                Some("py") => langs.python = true,
                Some("ts") | Some("tsx") | Some("js") | Some("jsx") | Some("mjs") | Some("cjs") => {
                    langs.js_ts = true
                }
                Some("java") => langs.java = true,
                Some("cs") => langs.csharp = true,
                Some("php") => langs.php = true,
                Some("rb") => langs.ruby = true,
                Some("dart") => langs.dart = true,
                Some("c") | Some("h") | Some("cpp") | Some("cc") | Some("cxx")
                | Some("hpp") | Some("hh") | Some("hxx") => langs.cpp = true,
                _ => {}
            }
        }
    }

    langs
}

#[tauri::command]
pub async fn doctor_check(
    app: tauri::AppHandle,
    project_root: Option<String>,
    // IDs of "Optional" group checks the user has unticked in the Doctor
    // panel. Unticked optional checks are skipped entirely — not run, not
    // shown, and not counted — so only required ("Core"/"Languages"/"LSP
    // Servers") items plus any still-ticked optional ones are verified.
    // The frontend defaults every optional id into this list until the user
    // explicitly ticks one, so optional checks are unverified by default;
    // None/empty here means "verify every optional item".
    disabled_optional_ids: Option<Vec<String>>,
) -> CmdResult<Vec<DoctorCheckResult>> {
    let disabled_optional: std::collections::HashSet<String> =
        disabled_optional_ids.unwrap_or_default().into_iter().collect();
    let mut results: Vec<DoctorCheckResult> = Vec::new();

    emit_doctor_log(&app, "▶ Environment Check started");

    emit_doctor_log(&app, "$ checking managed Node.js runtime…");
    let node_install_result = ensure_managed_node(&app).await;
    if let Err(err) = &node_install_result {
        results.push(DoctorCheckResult {
            id: "node-runtime-download".to_string(),
            label: "Managed Node.js download".to_string(),
            group: "Core".to_string(),
            status: "fail".to_string(),
            detail: err.clone(),
            version: None,
            fix_hint: Some("Sign in and retry Doctor so Rachna AI Studio can download Node.js for your OS.".to_string()),
            fix_command: None,
        });
    }

    // ── 1. Node.js ─────────────────────────────────────────────────────────
    {
        emit_doctor_log(&app, "$ node --version");
        let version = run_runtime_version_command("node", &["--version"]);
        emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
        emit_doctor_log(&app, "$ npm --version");
        let npm_version = run_runtime_version_command("npm", &["--version"]);
        emit_doctor_log(&app, format!("  → {}", npm_version.as_deref().unwrap_or("not found")));
        let (status, detail, fix) = if let Some(ref v) = version {
            // Node 18+ required for the repo scanner and for npx-based MCP servers
            let major = v.trim_start_matches('v')
                .split('.')
                .next()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            if major >= 18 {
                ("ok".to_string(), format!("Node.js {} — npm {}", v, npm_version.as_deref().unwrap_or("?")), None)
            } else {
                (
                    "warn".to_string(),
                    format!("Node.js {} is installed, but ≥18 is recommended", v),
                    Some("https://nodejs.org/en/download".to_string()),
                )
            }
        } else {
            (
                "fail".to_string(),
                "Node.js not found on PATH".to_string(),
                Some("https://nodejs.org/en/download".to_string()),
            )
        };
        results.push(DoctorCheckResult {
            id: "node".to_string(),
            label: "Node.js".to_string(),
            group: "Core".to_string(),
            status,
            detail,
            version,
            fix_hint: fix.clone().map(|_| "Install Node.js ≥ 18 from nodejs.org".to_string()),
            fix_command: fix.map(|url| format!("open {}", url)),
        });
    }

    // ── 1b. npm ────────────────────────────────────────────────────────────
    {
        emit_doctor_log(&app, "$ npm --version");
        let version = run_runtime_version_command("npm", &["--version"]);
        emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
        let (status, detail, fix) = if let Some(ref v) = version {
            ("ok".to_string(), format!("npm {}", v), None)
        } else {
            (
                "fail".to_string(),
                "npm not found on PATH — LSP installs and scanner builds won't work".to_string(),
                Some("https://nodejs.org/en/download".to_string()),
            )
        };
        results.push(DoctorCheckResult {
            id: "npm".to_string(),
            label: "npm".to_string(),
            group: "Core".to_string(),
            status,
            detail,
            version,
            fix_hint: fix.clone().map(|_| "npm ships with Node.js — install Node.js ≥ 18 from nodejs.org".to_string()),
            fix_command: fix.map(|url| format!("open {}", url)),
        });
    }

    // ── 1c. npx ────────────────────────────────────────────────────────────
    {
        emit_doctor_log(&app, "$ npx --version");
        let version = run_runtime_version_command("npx", &["--version"]);
        emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
        let (status, detail, fix) = if let Some(ref v) = version {
            ("ok".to_string(), format!("npx {}", v), None)
        } else {
            (
                "fail".to_string(),
                "npx not found on PATH — MCP servers and Playwright installs won't work".to_string(),
                Some("https://nodejs.org/en/download".to_string()),
            )
        };
        results.push(DoctorCheckResult {
            id: "npx".to_string(),
            label: "npx".to_string(),
            group: "Core".to_string(),
            status,
            detail,
            version,
            fix_hint: fix.clone().map(|_| "npx ships with Node.js — install Node.js ≥ 18 from nodejs.org".to_string()),
            fix_command: fix.map(|url| format!("open {}", url)),
        });
    }

    // ── Ollama (semantic search / embeddings) ───────────────────────────────
    // Optional — placed right after the Node/npm/npx checks since it's the
    // other "core-ish" runtime dependency most people hit early. If missing,
    // semantic (vector) search over the codebase falls back to keyword-only
    // search; nothing else breaks.
    if !disabled_optional.contains("ollama") {
        // Whether the `ollama` binary is on PATH at all. Note: we deliberately
        // don't use `ollama --version`'s exit status for this — when the
        // Ollama daemon isn't running yet, `ollama --version` can exit
        // non-zero (or print nothing to stdout) on some platforms/versions,
        // which made Doctor wrongly report "Not installed" for users who had
        // Ollama installed but simply hadn't started it. `which_found` only
        // checks PATH presence, independent of daemon state, so it's the
        // reliable signal for "installed".
        emit_doctor_log(&app, "$ which ollama");
        let installed = which_found("ollama");
        emit_doctor_log(&app, "$ ollama --version");
        let version = run_version_command("ollama", &["--version"]);
        emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
        let running = if installed {
            // Quick HTTP check against the Ollama default port
            emit_doctor_log(&app, "$ checking 127.0.0.1:11434 (Ollama daemon)…");
            std::net::TcpStream::connect_timeout(
                &"127.0.0.1:11434".parse().unwrap(),
                std::time::Duration::from_millis(500),
            )
            .is_ok()
        } else { false };

        let (status, detail) = if !installed {
            ("warn".to_string(), "Not installed — semantic (vector) code search will be unavailable; keyword search still works".to_string())
        } else if !running {
            ("warn".to_string(), format!("{} is installed but not running (port 11434 unreachable) — semantic search will be unavailable until it's started", version.as_deref().unwrap_or("ollama")))
        } else {
            ("ok".to_string(), format!("{} is installed and running", version.as_deref().unwrap_or("ollama")))
        };

        results.push(DoctorCheckResult {
            id: "ollama".to_string(),
            label: "Ollama (semantic search)".to_string(),
            group: "Optional".to_string(),
            status,
            detail,
            version: version.clone(),
            fix_hint: if !installed {
                Some("Install Ollama from ollama.ai to enable embedding-based semantic search".to_string())
            } else if !running {
                Some("Run `ollama serve` to start the Ollama daemon".to_string())
            } else {
                None
            },
            fix_command: if !installed {
                Some("https://ollama.ai/download".to_string())
            } else if !running {
                Some("ollama serve".to_string())
            } else {
                None
            },
        });
    }

    // ── Playwright / Chromium (browser_check tool) ──────────────────────────
    // Optional — also placed right after Node/npm/npx since it depends on npx.
    // If missing, only the agent's browser_check tool (visual/browser preview
    // checks) will fail; everything else in the IDE keeps working.
    if !disabled_optional.contains("playwright") {
        // We check whether the `playwright` package is available via npx — it
        // doesn't need to be globally installed, just available to npx.
        emit_doctor_log(&app, "$ npx playwright show-browser --help");
        let mut npx_cmd = Command::new(managed_node_bin("npx").unwrap_or_else(|| PathBuf::from("npx")));
        let chromium_found = npx_cmd
            .args(["playwright", "show-browser", "--help"])
            .no_window()
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        emit_doctor_log(&app, format!("  → {}", if chromium_found { "found" } else { "not found" }));

        // Alternative: check if a Chrome/Chromium binary exists on PATH
        emit_doctor_log(&app, "$ which google-chrome chromium chromium-browser");
        let chrome_on_path = which_found("google-chrome")
            || which_found("chromium")
            || which_found("chromium-browser");

        let (status, detail) = if chromium_found || chrome_on_path {
            ("ok".to_string(), "Playwright / Chromium available for the browser_check tool".to_string())
        } else {
            ("warn".to_string(), "Not found — the agent's browser_check tool (browser preview / visual checks) will fail".to_string())
        };

        results.push(DoctorCheckResult {
            id: "playwright".to_string(),
            label: "Playwright Chromium".to_string(),
            group: "Optional".to_string(),
            status,
            detail,
            version: None,
            fix_hint: if !chromium_found && !chrome_on_path {
                Some("npx playwright install chromium".to_string())
            } else { None },
            fix_command: if !chromium_found && !chrome_on_path {
                Some("npx playwright install chromium".to_string())
            } else { None },
        });
    }

    // ── 2. Repo scanner (dist/run.js relative to exe) ───────────────────────
    {
        use tauri::Manager;
        let scanner_found = (|| -> Option<PathBuf> {
            // Dev mode: ../repo-scanner/dist/run.js
            if let Ok(cwd) = std::env::current_dir() {
                let dev_path = cwd.join("..").join("lib").join("repo-scanner").join("dist").join("run.js");
                if dev_path.exists() { return Some(dev_path); }
            }
            // Packaged: resource_dir/lib/repo-scanner/dist/run.js
            if let Ok(resource_dir) = app.path().resource_dir() {
                let candidate = resource_dir.join("lib").join("repo-scanner").join("dist").join("run.js");
                if candidate.exists() { return Some(candidate); }
            }
            None
        })();
        let (status, detail) = if scanner_found.is_some() {
            ("ok".to_string(), "Repo scanner found".to_string())
        } else {
            ("fail".to_string(), "Repo scanner (dist/run.js) not found — code indexing and symbol search won't work".to_string())
        };
        results.push(DoctorCheckResult {
            id: "repo_scanner".to_string(),
            label: "Repo Scanner".to_string(),
            group: "Core".to_string(),
            status,
            detail,
            version: None,
            fix_hint: Some("Run `npm run scanner:build` in the project root".to_string()),
            fix_command: Some("npm run scanner:build".to_string()),
        });
    }

    // ── Languages / LSP servers ──────────────────────────────────────────────
    // Only run at all when a project is actually open. No project open →
    // there's nothing yet to know the language of, so skip this whole section
    // rather than asking a brand-new user to install toolchains up front.
    // Once a project is open, individual checks are further gated on which
    // languages that specific project actually uses (Cargo.toml/go.mod/etc,
    // detected by `detect_project_languages`).
    if let Some(root) = project_root.as_deref() {
        let langs = detect_project_languages(Some(root));

        // ── Rust / Cargo ──────────────────────────────────────────────────
        if langs.rust {
            emit_doctor_log(&app, "$ cargo --version");
            let version = run_version_command("cargo", &["--version"]);
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or("cargo not found — Rust projects won't compile from the terminal").to_string();
            results.push(DoctorCheckResult {
                id: "cargo".to_string(),
                label: "Rust / Cargo".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install Rust via rustup.rs".to_string()) } else { None },
                fix_command: if version.is_none() { Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh".to_string()) } else { None },
            });
        }

        // ── Python ────────────────────────────────────────────────────────
        if langs.python {
            emit_doctor_log(&app, "$ python3 --version");
            let version = run_version_command("python3", &["--version"])
                .or_else(|| {
                    emit_doctor_log(&app, "$ python --version");
                    run_version_command("python", &["--version"])
                });
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or("Python not found — Python LSP (pyright) may not work").to_string();
            results.push(DoctorCheckResult {
                id: "python".to_string(),
                label: "Python".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install Python 3 from python.org".to_string()) } else { None },
                fix_command: if version.is_none() { Some("https://www.python.org/downloads/".to_string()) } else { None },
            });
        }

        // ── Go ────────────────────────────────────────────────────────────
        if langs.go {
            emit_doctor_log(&app, "$ go version");
            let version = run_version_command("go", &["version"]);
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or("Go not found — Go LSP (gopls) may not work").to_string();
            results.push(DoctorCheckResult {
                id: "go".to_string(),
                label: "Go".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install Go from go.dev/dl".to_string()) } else { None },
                fix_command: if version.is_none() { Some("https://go.dev/dl/".to_string()) } else { None },
            });
        }

        // ── Java / JDK ────────────────────────────────────────────────────
        if langs.java {
            emit_doctor_log(&app, "$ java -version");
            let version = run_version_command("java", &["-version"]);
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or("Java not found — Java LSP (jdtls) won't work").to_string();
            results.push(DoctorCheckResult {
                id: "java".to_string(),
                label: "Java / JDK".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install a JDK ≥ 17 from adoptium.net".to_string()) } else { None },
                fix_command: if version.is_none() { Some("https://adoptium.net/".to_string()) } else { None },
            });
        }

        // ── C# / .NET SDK ─────────────────────────────────────────────────
        if langs.csharp {
            emit_doctor_log(&app, "$ dotnet --version");
            let version = run_version_command("dotnet", &["--version"]);
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or(".NET SDK not found — C# LSP (csharp-ls) won't work").to_string();
            results.push(DoctorCheckResult {
                id: "dotnet".to_string(),
                label: "C# / .NET SDK".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install the .NET SDK from dotnet.microsoft.com".to_string()) } else { None },
                fix_command: if version.is_none() { Some("https://dotnet.microsoft.com/download".to_string()) } else { None },
            });
        }

        // ── PHP ───────────────────────────────────────────────────────────
        if langs.php {
            emit_doctor_log(&app, "$ php -v");
            let version = run_version_command("php", &["-v"]);
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or("PHP not found — PHP LSP (intelephense) won't work").to_string();
            results.push(DoctorCheckResult {
                id: "php".to_string(),
                label: "PHP".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install PHP from php.net".to_string()) } else { None },
                fix_command: if version.is_none() { Some("https://www.php.net/downloads".to_string()) } else { None },
            });
        }

        // ── Ruby ──────────────────────────────────────────────────────────
        if langs.ruby {
            emit_doctor_log(&app, "$ ruby -v");
            let version = run_version_command("ruby", &["-v"]);
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or("Ruby not found — Ruby LSP (ruby-lsp) won't work").to_string();
            results.push(DoctorCheckResult {
                id: "ruby".to_string(),
                label: "Ruby".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install Ruby from ruby-lang.org".to_string()) } else { None },
                fix_command: if version.is_none() { Some("https://www.ruby-lang.org/en/downloads/".to_string()) } else { None },
            });
        }

        // ── Dart ──────────────────────────────────────────────────────────
        if langs.dart {
            emit_doctor_log(&app, "$ dart --version");
            let version = run_version_command("dart", &["--version"]);
            emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
            let status = if version.is_some() { "ok" } else { "warn" };
            let detail = version.as_deref().unwrap_or("Dart not found — Dart's built-in LSP won't work").to_string();
            results.push(DoctorCheckResult {
                id: "dart".to_string(),
                label: "Dart".to_string(),
                group: "Languages".to_string(),
                status: status.to_string(),
                detail,
                version: version.clone(),
                fix_hint: if version.is_none() { Some("Install the Dart SDK from dart.dev/get-dart".to_string()) } else { None },
                fix_command: if version.is_none() { Some("https://dart.dev/get-dart".to_string()) } else { None },
            });
        }

        // ── pyright (Python LSP) ─────────────────────────────────────────
        if langs.python {
            emit_doctor_log(&app, "$ which pyright-langserver pyright");
            let found = which_found("pyright-langserver") || which_found("pyright");
            let (status, detail) = if found {
                emit_doctor_log(&app, "$ pyright --version");
                let v = run_version_command("pyright", &["--version"]);
                ("ok".to_string(), format!("pyright found — {}", v.as_deref().unwrap_or("version unknown")))
            } else {
                ("warn".to_string(), "pyright not found — Python hover / diagnostics unavailable".to_string())
            };
            results.push(DoctorCheckResult {
                id: "pyright".to_string(),
                label: "pyright (Python LSP)".to_string(),
                group: "LSP Servers".to_string(),
                status,
                detail,
                version: None,
                fix_hint: if !found { Some("npm install -g pyright".to_string()) } else { None },
                fix_command: if !found { Some("npm install -g pyright".to_string()) } else { None },
            });
        }

        // ── gopls (Go LSP) ───────────────────────────────────────────────
        if langs.go {
            emit_doctor_log(&app, "$ which gopls");
            let found = which_found("gopls");
            let (status, detail) = if found {
                emit_doctor_log(&app, "$ gopls version");
                let v = run_version_command("gopls", &["version"]);
                ("ok".to_string(), format!("gopls found — {}", v.as_deref().unwrap_or("version unknown")))
            } else {
                ("warn".to_string(), "gopls not found — Go hover / diagnostics unavailable".to_string())
            };
            results.push(DoctorCheckResult {
                id: "gopls".to_string(),
                label: "gopls (Go LSP)".to_string(),
                group: "LSP Servers".to_string(),
                status,
                detail,
                version: None,
                fix_hint: if !found { Some("go install golang.org/x/tools/gopls@latest".to_string()) } else { None },
                fix_command: if !found { Some("go install golang.org/x/tools/gopls@latest".to_string()) } else { None },
            });
        }

        // ── typescript-language-server ───────────────────────────────────
        if langs.js_ts {
            emit_doctor_log(&app, "$ which typescript-language-server");
            let found = which_found("typescript-language-server");
            let (status, detail) = if found {
                ("ok".to_string(), "typescript-language-server found".to_string())
            } else {
                ("warn".to_string(), "typescript-language-server not found — TS/JS diagnostics unavailable".to_string())
            };
            results.push(DoctorCheckResult {
                id: "tsls".to_string(),
                label: "typescript-language-server".to_string(),
                group: "LSP Servers".to_string(),
                status,
                detail,
                version: None,
                fix_hint: if !found { Some("npm install -g typescript-language-server typescript".to_string()) } else { None },
                fix_command: if !found { Some("npm install -g typescript-language-server typescript".to_string()) } else { None },
            });
        }

        // ── rust-analyzer ─────────────────────────────────────────────────
        if langs.rust {
            emit_doctor_log(&app, "$ which rust-analyzer");
            let found = which_found("rust-analyzer");
            let (status, detail) = if found {
                emit_doctor_log(&app, "$ rust-analyzer --version");
                let v = run_version_command("rust-analyzer", &["--version"]);
                ("ok".to_string(), format!("rust-analyzer found — {}", v.as_deref().unwrap_or("version unknown")))
            } else {
                ("warn".to_string(), "rust-analyzer not found — Rust hover / diagnostics unavailable".to_string())
            };
            results.push(DoctorCheckResult {
                id: "rust_analyzer".to_string(),
                label: "rust-analyzer".to_string(),
                group: "LSP Servers".to_string(),
                status,
                detail,
                version: None,
                fix_hint: if !found { Some("rustup component add rust-analyzer".to_string()) } else { None },
                fix_command: if !found { Some("rustup component add rust-analyzer".to_string()) } else { None },
            });
        }

        // ── Everything else (the LSP downloader's registry) ─────────────────
        // pyright/gopls/tsls/rust-analyzer above predate the in-IDE LSP
        // downloader and are left exactly as they were. Every language the
        // downloader added support for afterwards (clangd, plus ~15 more
        // via npm/go/cargo installs) is data-driven from one table in
        // lsp_install.rs, so this is a single call rather than another
        // dozen copy-pasted blocks — see lsp_install::doctor_rows.
        results.extend(crate::lsp_install::doctor_rows(&langs));
    }

    // ── Git (optional) ───────────────────────────────────────────────────────
    // Git is not required for Rachna AI Studio to run — only the in-app Git
    // panel (diffs, commit/push) depends on it. It's checked only when the
    // user has left the "Git" optional checkbox ticked in the Doctor panel
    // (see `disabled_optional_ids` below), and a missing install is a warning
    // rather than a hard failure.
    if !disabled_optional.contains("git") {
        emit_doctor_log(&app, "$ git --version");
        let version = run_version_command("git", &["--version"]);
        emit_doctor_log(&app, format!("  → {}", version.as_deref().unwrap_or("not found")));
        let (status, detail) = if let Some(ref v) = version {
            ("ok".to_string(), v.clone())
        } else {
            ("warn".to_string(), "git not found — the Git panel (diffs, commit/push) won't work".to_string())
        };
        let missing = version.is_none();
        results.push(DoctorCheckResult {
            id: "git".to_string(),
            label: "Git".to_string(),
            group: "Optional".to_string(),
            status,
            detail,
            version,
            fix_hint: if missing { Some("Install Git from git-scm.com".to_string()) } else { None },
            fix_command: if missing { Some("open https://git-scm.com/downloads".to_string()) } else { None },
        });
    }

    emit_doctor_log(&app, "✓ Environment Check finished");

    Ok(results)
}

// ── Conversation memory commands ────────────────────────────────────────────
//
// Thin wrappers around db::{conversation,message,rejected_edit} helpers.
// Pattern: resolve app_data_dir from AppHandle, delegate to db.rs, map
// SqlResult errors to String (CmdResult<T>).

/// Saves one message as a node in the conversation's message graph
/// (CHAT-004). If `conversation_id` is omitted or empty, a new conversation
/// is created for `project_root` first (auto-titled from `content` when
/// `role == "user"`). Returns both ids so the caller can track the active
/// conversation without a separate round-trip.
///
/// `parent_id`, when provided, is the id of the message this one follows
/// (see `db::save_message` for the linear-continuation vs. new-branch
/// distinction). Omit it entirely for the very first message of a brand
/// new conversation.
///
/// `metadata` (CHAT-005) is an opaque JSON string built on the TypeScript
/// side (see useChat.ts's extractMessageMetadata) holding every non-text
/// field of the message that needs to survive a reload — generated plan,
/// per-step statuses, agent activity chips, retrieval/compression stats,
/// attached images, pending login/toggle cards, etc. Stored as-is and
/// never inspected here.
#[tauri::command]
pub async fn save_message(
    app: tauri::AppHandle,
    conversation_id: Option<String>,
    project_root: String,
    client_message_id: Option<String>,
    parent_id: Option<String>,
    role: String,
    content: String,
    tool_name: Option<String>,
    metadata: Option<String>,
) -> CmdResult<SaveMessageResult> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    // A prior attempt may have committed successfully even if its invoke
    // response was lost. Return the original ids instead of creating a
    // second conversation during the retry.
    if let Some(message_id) = client_message_id.as_deref() {
        if let Some(existing_conversation_id) =
            db::find_message_conversation(&app_data_dir, message_id)
                .map_err(|e| format!("Failed to check existing message: {e}"))?
        {
            return Ok(SaveMessageResult {
                conversation_id: existing_conversation_id,
                message_id: message_id.to_string(),
            });
        }
    }

    let conv_id = match conversation_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            let title_seed = if role == "user" { Some(content.as_str()) } else { None };
            db::create_conversation(&app_data_dir, &project_root, title_seed)
                .map_err(|e| format!("Failed to create conversation: {e}"))?
        }
    };

    let message_id = db::save_message(
        &app_data_dir,
        &conv_id,
        client_message_id.as_deref(),
        parent_id.as_deref(),
        &role,
        &content,
        tool_name.as_deref(),
        metadata.as_deref(),
    )
    .map_err(|e| format!("Failed to save message: {e}"))?;

    Ok(SaveMessageResult { conversation_id: conv_id, message_id })
}

/// Repoints a conversation's active branch at an existing message —
/// version prev/next navigation. Never creates or deletes anything.
#[tauri::command]
pub async fn set_current_leaf(
    app: tauri::AppHandle,
    conversation_id: String,
    leaf_id: String,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::set_current_leaf(&app_data_dir, &conversation_id, &leaf_id)
        .map_err(|e| format!("Failed to switch branch: {e}"))
}

/// Overwrites an already-saved message's `metadata` JSON blob in place
/// (CHAT-005) — for state that keeps changing on a message after its first
/// save, e.g. an IntentPlanCard's `planApproved`/`stepStatuses` as the plan
/// is approved and executed, or a pending login/toggle card's `resolved`
/// flag. Does not create a new graph node or move the conversation's
/// current leaf — see `db::update_message_metadata`.
#[tauri::command]
pub async fn update_message_metadata(
    app: tauri::AppHandle,
    message_id: String,
    metadata: Option<String>,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::update_message_metadata(&app_data_dir, &message_id, metadata.as_deref())
        .map_err(|e| format!("Failed to update message metadata: {e}"))
}

/// Atomically checkpoints a message's current visible body and metadata.
#[tauri::command]
pub async fn update_message(
    app: tauri::AppHandle,
    message_id: String,
    content: String,
    metadata: Option<String>,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::update_message(&app_data_dir, &message_id, &content, metadata.as_deref())
        .map_err(|e| format!("Failed to update message: {e}"))
}

#[derive(serde::Serialize)]
pub struct SaveMessageResult {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
}

/// Loads the most recently updated conversation for `project_root` and its
/// COMPLETE message graph — every branch, not just the active path (see
/// `db::load_message_graph`). The caller reconstructs the displayed
/// transcript by walking `parent_id` from `conversation.current_leaf_id`.
/// Returns `null` for `conversation` when the project has no history yet.
/// `limit` is kept for API compatibility but no longer truncates history —
/// version navigation needs every branch available, and chat graphs are
/// small enough that this is never a concern in practice.
#[tauri::command]
pub async fn load_conversation(
    app: tauri::AppHandle,
    project_root: String,
    limit: Option<u32>,
) -> CmdResult<LoadConversationResult> {
    let _ = limit; // retained for API compatibility; graph loads are unbounded
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    let conversation = db::get_latest_conversation(&app_data_dir, &project_root)
        .map_err(|e| format!("Failed to load conversation: {e}"))?;

    let Some(conversation) = conversation else {
        return Ok(LoadConversationResult { conversation: None, messages: vec![] });
    };

    let messages = db::load_message_graph(&app_data_dir, &conversation.id)
        .map_err(|e| format!("Failed to load messages: {e}"))?;

    Ok(LoadConversationResult { conversation: Some(conversation), messages })
}

#[derive(serde::Serialize)]
pub struct LoadConversationResult {
    pub conversation: Option<db::Conversation>,
    /// Every message in the conversation's graph (all branches).
    pub messages: Vec<db::Message>,
}

/// Loads a specific conversation's complete message graph by id (used when
/// restoring from the sidebar). Returns the conversation row (for its
/// `current_leaf_id`) alongside every message node.
#[tauri::command]
pub async fn load_conversation_by_id(
    app: tauri::AppHandle,
    conversation_id: String,
    limit: Option<u32>,
) -> CmdResult<LoadConversationResult> {
    let _ = limit; // retained for API compatibility; graph loads are unbounded
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    let conversation = db::get_conversation(&app_data_dir, &conversation_id)
        .map_err(|e| format!("Failed to load conversation: {e}"))?;

    let messages = db::load_message_graph(&app_data_dir, &conversation_id)
        .map_err(|e| format!("Failed to load messages: {e}"))?;

    Ok(LoadConversationResult { conversation, messages })
}

/// Lists all conversations for `project_root`, newest first. Powers the
/// conversation-history sidebar.
#[tauri::command]
pub async fn list_conversations(
    app: tauri::AppHandle,
    project_root: String,
) -> CmdResult<Vec<db::Conversation>> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::list_conversations(&app_data_dir, &project_root)
        .map_err(|e| format!("Failed to list conversations: {e}"))
}

/// Lists every conversation across every project root (plus the
/// no-project-open scope), newest first. Powers the sidebar's combined
/// view: a flat "User Chats" list for the no-project scope, and one
/// expandable group per project.
#[tauri::command]
pub async fn list_all_conversations(
    app: tauri::AppHandle,
) -> CmdResult<Vec<db::Conversation>> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::list_all_conversations(&app_data_dir)
        .map_err(|e| format!("Failed to list all conversations: {e}"))
}

/// Deletes a conversation and all of its messages.
#[tauri::command]
pub async fn delete_conversation(
    app: tauri::AppHandle,
    conversation_id: String,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::delete_conversation(&app_data_dir, &conversation_id)
        .map_err(|e| format!("Failed to delete conversation: {e}"))?;
    Ok(())
}

/// Records a rejected edit proposal so the agent system prompt can remind
/// the model not to re-propose it.
#[tauri::command]
pub async fn save_rejected_edit(
    app: tauri::AppHandle,
    message_id: Option<String>,
    project_root: String,
    file_path: String,
    description: String,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::save_rejected_edit(
        &app_data_dir,
        message_id.as_deref(),
        &project_root,
        &file_path,
        &description,
    )
    .map_err(|e| format!("Failed to save rejected edit: {e}"))?;
    Ok(())
}

/// Returns the most recent rejected edits for `project_root` (default 10).
#[tauri::command]
pub async fn get_rejected_edits(
    app: tauri::AppHandle,
    project_root: String,
    limit: Option<u32>,
) -> CmdResult<Vec<db::RejectedEdit>> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::get_rejected_edits(&app_data_dir, &project_root, limit.unwrap_or(10))
        .map_err(|e| format!("Failed to load rejected edits: {e}"))
}

// ── Run configurations ──────────────────────────────────────────────────────

/// Lists all run configurations saved for `project_root`.
#[tauri::command]
pub async fn list_run_configs(
    app: tauri::AppHandle,
    project_root: String,
) -> CmdResult<Vec<db::RunConfig>> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::list_run_configs(&app_data_dir, &project_root)
        .map_err(|e| format!("Failed to list run configurations: {e}"))
}

/// Creates (when `id` is omitted) or updates (when `id` is provided) a run
/// configuration. `env_json` is a JSON-encoded `{"KEY":"value"}` object.
#[tauri::command]
pub async fn save_run_config(
    app: tauri::AppHandle,
    id: Option<String>,
    project_root: String,
    name: String,
    build_command: String,
    run_command: String,
    env_json: String,
    cwd: Option<String>,
) -> CmdResult<db::RunConfig> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::save_run_config(
        &app_data_dir,
        id.as_deref(),
        &project_root,
        &name,
        &build_command,
        &run_command,
        &env_json,
        cwd.as_deref(),
    )
    .map_err(|e| format!("Failed to save run configuration: {e}"))
}

/// Deletes a run configuration by id.
#[tauri::command]
pub async fn delete_run_config(app: tauri::AppHandle, id: String) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::delete_run_config(&app_data_dir, &id)
        .map_err(|e| format!("Failed to delete run configuration: {e}"))?;
    Ok(())
}

/// Marks a run configuration as the active one for its project.
#[tauri::command]
pub async fn set_active_run_config(
    app: tauri::AppHandle,
    project_root: String,
    id: String,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;

    db::set_active_run_config(&app_data_dir, &project_root, &id)
        .map_err(|e| format!("Failed to set active run configuration: {e}"))?;
    Ok(())
}

// ── App settings & project registry (app.db) ────────────────────────────
//
// Small global key/value preferences and the "recent projects" registry.
// Both live in app.db, never chats.db or any project.db.

/// Reads a single app setting's value, if present.
#[tauri::command]
pub async fn get_setting(app: tauri::AppHandle, key: String) -> CmdResult<Option<String>> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    db::get_setting(&app_data_dir, &key).map_err(|e| format!("Failed to read setting: {e}"))
}

/// Upserts a single app setting's value.
#[tauri::command]
pub async fn set_setting(app: tauri::AppHandle, key: String, value: String) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    db::set_setting(&app_data_dir, &key, &value).map_err(|e| format!("Failed to save setting: {e}"))
}

/// Deletes a single app setting, if present.
#[tauri::command]
pub async fn delete_setting(app: tauri::AppHandle, key: String) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    db::delete_setting(&app_data_dir, &key)
        .map_err(|e| format!("Failed to delete setting: {e}"))?;
    Ok(())
}

/// Lists every stored app setting.
#[tauri::command]
pub async fn list_settings(app: tauri::AppHandle) -> CmdResult<Vec<(String, String)>> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    db::list_settings(&app_data_dir).map_err(|e| format!("Failed to list settings: {e}"))
}

/// Registers/refreshes a project in the "recent projects" registry.
#[tauri::command]
pub async fn touch_project_registry(
    app: tauri::AppHandle,
    project_root: String,
    display_name: String,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    db::touch_project_registry(&app_data_dir, &project_root, &display_name)
        .map_err(|e| format!("Failed to update project registry: {e}"))
}

/// Lists every known project, most-recently-opened first.
#[tauri::command]
pub async fn list_project_registry(app: tauri::AppHandle) -> CmdResult<Vec<db::ProjectRegistryEntry>> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    db::list_project_registry(&app_data_dir)
        .map_err(|e| format!("Failed to list project registry: {e}"))
}

/// Removes a project from the "recent projects" registry (does not delete
/// any files, conversations, or the project's own index).
#[tauri::command]
pub async fn remove_project_registry_entry(
    app: tauri::AppHandle,
    project_root: String,
) -> CmdResult<()> {
    let app_data_dir = local_data_dir(&app)
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    db::remove_project_registry_entry(&app_data_dir, &project_root)
        .map_err(|e| format!("Failed to remove project registry entry: {e}"))?;
    Ok(())
}
