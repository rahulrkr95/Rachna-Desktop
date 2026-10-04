// src-tauri/src/logging.rs
//
// Startup diagnostics logging — DIAGNOSTICS ONLY, no behavior change.
//
// Everything the app does between process start and the main window
// appearing gets a timestamped line in `data/startup.log` (the same `data`
// directory `commands::local_data_dir` resolves to — next to the
// executable). If startup crashes or panics, this file is the thing a user
// can send back that shows exactly how far it got and why it stopped.
//
// Design constraints driving the implementation below:
//   - The panic hook must be installed before ANYTHING else in `main()`, so
//     logging must not depend on a `tauri::AppHandle` (it doesn't exist
//     yet) or on any other module's state.
//   - Release builds keep `panic = "abort"` (see Cargo.toml) — there is no
//     unwinding to rely on, so every single line written here is flushed
//     and the file handle is closed immediately. Nothing is buffered in
//     memory across calls; a write that already happened is safely on disk
//     even if the very next line is the abort.
//   - `RUST_BACKTRACE` is not guaranteed to be set when a user just
//     double-clicks the app, so backtraces are captured with
//     `Backtrace::force_capture()`, which ignores that env var.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Resolve `<exe_dir>/data/startup.log`, matching where
/// `commands::local_data_dir` puts everything else. Deliberately does NOT
/// call into `commands::local_data_dir` itself (that takes a
/// `tauri::AppHandle`, which doesn't exist this early in `main()`, and it
/// only creates the dir — it doesn't need Tauri for that).
///
/// Falls back to the OS temp dir if the exe path can't be resolved or the
/// directory can't be created (e.g. installed to a read-only location) —
/// better to log somewhere findable than to silently lose every line.
fn resolve_log_path() -> PathBuf {
    let from_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .map(|dir| dir.join("data"));

    if let Some(dir) = from_exe {
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir.join("startup.log");
        }
    }

    std::env::temp_dir().join("rachna-ide-startup.log")
}

fn log_path() -> &'static PathBuf {
    LOG_PATH.get_or_init(resolve_log_path)
}

fn timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => format!("{}.{:03}", d.as_secs(), d.subsec_millis()),
        Err(_) => "t?".to_string(),
    }
}

/// Append one line to `startup.log`. Opens, writes, flushes, and closes the
/// file on every single call — no buffered writer held across calls — so
/// whatever was logged before an abrupt crash (including `panic = "abort"`)
/// is guaranteed to already be on disk.
fn append_line(line: &str) {
    let path = log_path();
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut file) => {
            // Best-effort: if the write or flush fails there's nothing
            // further we can do (and nowhere better to report it), but we
            // must never let logging itself panic.
            let _ = writeln!(file, "[{}] {}", timestamp(), line);
            let _ = file.flush();
            let _ = file.sync_all();
        }
        Err(e) => {
            // Last resort so the info isn't lost outright, e.g. when
            // running from a terminal during dev.
            eprintln!("[startup.log unavailable ({e}), path={}] {line}", path.display());
        }
    }
}

/// Mark the start of a startup phase (e.g. "db_init"). If the process dies
/// before the matching `ok`/`fail` for the same label, this is the last
/// line in the log and tells you exactly which phase was in progress.
pub fn checkpoint(label: &str) {
    append_line(&format!("CHECKPOINT {label}"));
}

/// Mark a startup phase (or sub-step) as having completed successfully.
pub fn ok(label: &str) {
    append_line(&format!("OK        {label}"));
}

/// Mark a startup phase as having failed, with its error. Purely
/// diagnostic — logging a failure here does not itself decide whether the
/// caller aborts or continues.
pub fn fail(label: &str, err: &dyn std::fmt::Display) {
    append_line(&format!("FAIL      {label}: {err}"));
}

/// Install the panic hook as the very first thing `main()` does. Logs the
/// panic message, exact source location, and a forced (always-on)
/// backtrace to `startup.log`, then chains to whatever hook was previously
/// installed (Rust's default one, in practice) so console output and the
/// `panic = "abort"` release-build behavior are completely unchanged —
/// this only adds a durable record of what happened.
pub fn install_panic_hook() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());

        let message = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };

        // force_capture() ignores RUST_BACKTRACE=0/unset — we always want
        // the full trace in the log, since this is exactly the situation
        // (an unattended startup crash) where nobody set that env var.
        let backtrace = std::backtrace::Backtrace::force_capture();

        append_line(&format!(
            "PANIC at {location}: {message}\n----- backtrace -----\n{backtrace}\n----- end backtrace -----"
        ));

        previous_hook(panic_info);
    }));

    // Logged via ok(), not checkpoint(), since installing the hook is
    // itself an atomic, already-complete step by the time this returns.
    ok("panic_hook installed");
}
