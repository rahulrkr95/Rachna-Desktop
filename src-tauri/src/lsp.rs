// src-tauri/src/lsp.rs
//
// Real Language Server Protocol bridge (Python via pyright, Go via gopls,
// TypeScript/JavaScript via typescript-language-server, Rust via
// rust-analyzer, C/C++ via clangd). Mirrors the lifecycle pattern of the PTY terminal
// in `commands.rs` (a global session registry behind a Mutex, one thread per
// process streaming output back as Tauri events) but swaps the PTY's raw
// byte-stream model for LSP's JSON-RPC framing (`Content-Length` headers)
// and request/response correlation by numeric id.
//
// Commands:
//   lsp_start(language, root)              – lazily spawn + initialize a
//                                             server for (language, root)
//   lsp_request(language, root, method, params) – send a JSON-RPC request,
//                                             await the matching response
//   lsp_notify(language, root, method, params)  – fire-and-forget notification
//   lsp_stop(language, root)               – kill the process, drop the session
//
// Diagnostics:
//   `textDocument/publishDiagnostics` notifications from the server are
//   forwarded verbatim to a `lsp-diagnostics-{language}` Tauri event (mirrors
//   the `terminal-output-{id}` emit pattern used by the PTY).
//
// Crash handling:
//   When the reader thread hits EOF/a read error, the session is removed
//   from the registry and an `lsp-crashed-{language}` event is emitted with
//   the workspace root as payload. We deliberately do NOT attempt an
//   unbounded auto-respawn loop here (that's a recipe for crash storms) —
//   the frontend's `ensureLspStarted` lazily re-spawns on the next request,
//   which is simple, sufficient for this slice, and easy to harden later
//   with backoff if needed.
//
// Scope note:
//   "python" (pyright), "go" (gopls), "typescript"/"javascript"
//   (typescript-language-server), "rust" (rust-analyzer), and "c"/"cpp"
//   (clangd) are wired up. Adding another language later means adding one
//   more arm to `resolve_server_command` below — no new architecture
//   required.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use crate::process_ext::NoWindow;

type CmdResult<T> = Result<T, String>;

// ── Session registry ─────────────────────────────────────────────────────
//
// Keyed by "{language}|{root}" so the same language can run independently
// per open workspace. Follows the PTY's `with_sessions` pattern exactly.

struct LspSession {
    stdin:   Arc<Mutex<std::process::ChildStdin>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: Arc<AtomicI64>,
    child:   Child,
}

// Safety: LspSession is only ever accessed behind a Mutex.
unsafe impl Send for LspSession {}

static LSP_SESSIONS: Mutex<Option<HashMap<String, LspSession>>> = Mutex::new(None);

fn with_lsp_sessions<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, LspSession>) -> R,
{
    let mut guard = LSP_SESSIONS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn session_key(language: &str, root: &str) -> String {
    format!("{language}|{root}")
}

// ── JSON-RPC framing ─────────────────────────────────────────────────────

fn write_message(stdin: &mut std::process::ChildStdin, value: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(value).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e)
    })?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes())?;
    stdin.write_all(&body)?;
    stdin.flush()
}

/// Reads one `Content-Length`-framed JSON-RPC message. Returns `Ok(None)` on
/// clean EOF (process exited), matching `read()` returning 0.
fn read_message<R: Read>(reader: &mut BufReader<R>) -> std::io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None); // EOF while reading headers
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break; // blank line terminates the header block
        }
        if let Some(v) = trimmed.strip_prefix("Content-Length:") {
            content_length = v.trim().parse::<usize>().ok();
        }
        // Other headers (e.g. Content-Type) are accepted and ignored.
    }

    let len = content_length.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "LSP message missing Content-Length header")
    })?;

    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

// ── Server binary resolution ─────────────────────────────────────────────

/// Returns (program, args) for the given LSP `language`.
///
/// LSP servers are resolved from Rachna-managed installs first, then from
/// the system PATH. No language servers are bundled with the application.
/// Managed installs live under the app data directory and are created by the
/// Language Servers setup flow.
fn resolve_server_command(app: &AppHandle, language: &str) -> CmdResult<(String, Vec<String>)> {
    match language {

        // ── Python ──────────────────────────────────────────────────────────
        "python" => {
            if let Some(bin) = crate::lsp_install::managed_binary_path(
                app,
                "python",
                &["pyright-langserver", "pyright-langserver.cmd"]
            ) {
                return Ok((
                    bin.to_string_lossy().into_owned(),
                    vec!["--stdio".to_string()]
                ));
            }

            Ok((
                "pyright-langserver".to_string(),
                vec!["--stdio".to_string()]
            ))
        }

        // ── Go ──────────────────────────────────────────────────────────────
        "go" => {
            let bin_name = if cfg!(windows) { "gopls.exe" } else { "gopls" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "go", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec![]));
            }
            Ok(("gopls".to_string(), vec![]))
        }

        // ── TypeScript / JavaScript ─────────────────────────────────────────
        "typescript" | "javascript" => {
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "typescript", &["typescript-language-server", "typescript-language-server.cmd"]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            Ok(("typescript-language-server".to_string(), vec!["--stdio".to_string()]))
        }

        // ── Rust ────────────────────────────────────────────────────────────
        "rust" => {
            let bin_name = if cfg!(windows) { "rust-analyzer.exe" } else { "rust-analyzer" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "rust", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec![]));
            }
            Ok(("rust-analyzer".to_string(), vec![]))
        }

        // ── C / C++ ─────────────────────────────────────────────────────────
        "c" | "cpp" => {
            let bin_name = if cfg!(windows) { "clangd.exe" } else { "clangd" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "cpp", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec![]));
            }
            Ok(("clangd".to_string(), vec![]))
        }

        // ── Java ────────────────────────────────────────────────────────────
        // eclipse.jdt.ls: installed via `brew install jdtls` (macOS) or the
        // jdtls release binary. Requires a JDK ≥ 17 on PATH.
        // Install: brew install jdtls   OR   sdk install java && sdk install jdtls
        "java" => {
            // jdtls on PATH (e.g. brew install jdtls on macOS)
            if which_exists("jdtls") {
                return Ok(("jdtls".to_string(), vec![]));
            }
            Err("Java LSP (jdtls) not found. Install via: brew install jdtls   OR   sdk install java && sdk install jdtls".to_string())
        }

        // ── C# ──────────────────────────────────────────────────────────────
        // csharp-ls: `dotnet tool install -g csharp-ls` (cross-platform)
        // Also accepts OmniSharp if available.
        "csharp" => {
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "csharp", &["csharp-ls", "csharp-ls.exe"]) {
                return Ok((bin.to_string_lossy().into_owned(), vec![]));
            }
            if which_exists("csharp-ls") {
                return Ok(("csharp-ls".to_string(), vec![]));
            }
            let omnisharp = if cfg!(windows) { "OmniSharp.exe" } else { "OmniSharp" };
            if which_exists(omnisharp) {
                return Ok((omnisharp.to_string(), vec!["--languageserver".to_string()]));
            }
            Err("C# LSP (csharp-ls) not found. Install via: dotnet tool install -g csharp-ls".to_string())
        }

        // ── PHP ─────────────────────────────────────────────────────────────
        // intelephense: `npm install -g intelephense`
        "php" => {
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "php", &["intelephense", "intelephense.cmd"]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists("intelephense") {
                return Ok(("intelephense".to_string(), vec!["--stdio".to_string()]));
            }
            Err("PHP LSP (intelephense) not found. Install via: npm install -g intelephense".to_string())
        }

        // ── Ruby ────────────────────────────────────────────────────────────
        // ruby-lsp: `gem install ruby-lsp`
        "ruby" => {
            let bin_name = if cfg!(windows) { "ruby-lsp.bat" } else { "ruby-lsp" };
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("Ruby LSP (ruby-lsp) not found. Install via: gem install ruby-lsp".to_string())
        }

        // ── Kotlin ──────────────────────────────────────────────────────────
        // kotlin-language-server: download release jar from GitHub or brew
        // Install: brew install kotlin-language-server
        "kotlin" => {
            let bin_name = if cfg!(windows) { "kotlin-language-server.bat" } else { "kotlin-language-server" };
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec![]));
            }
            Err("Kotlin LSP not found. Install via: brew install kotlin-language-server  OR  download from github.com/fwcd/kotlin-language-server/releases".to_string())
        }

        // ── Swift ────────────────────────────────────────────────────────────
        // sourcekit-lsp is bundled with Xcode on macOS. On Linux it ships with
        // the Swift toolchain.
        "swift" => {
            if which_exists("sourcekit-lsp") {
                return Ok(("sourcekit-lsp".to_string(), vec![]));
            }
            // Xcode-bundled path on macOS
            #[cfg(target_os = "macos")]
            {
                let xcode_path = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/sourcekit-lsp";
                if std::path::Path::new(xcode_path).exists() {
                    return Ok((xcode_path.to_string(), vec![]));
                }
            }
            Err("Swift LSP (sourcekit-lsp) not found. Install Xcode (macOS) or the Swift toolchain (Linux).".to_string())
        }

        // ── Dart / Flutter ──────────────────────────────────────────────────
        // dart analysis_server is bundled with the Dart SDK.
        "dart" => {
            if which_exists("dart") {
                return Ok(("dart".to_string(), vec!["language-server".to_string(), "--client-id=rachna-ide".to_string()]));
            }
            Err("Dart LSP not found. Install the Dart SDK from dart.dev/get-dart (or Flutter SDK which bundles Dart).".to_string())
        }

        // ── CSS / SCSS / Less ────────────────────────────────────────────────
        // vscode-css-language-server ships in vscode-langservers-extracted:
        // npm install -g vscode-langservers-extracted
        "css" | "scss" | "less" => {
            let bin_name = if cfg!(windows) { "vscode-css-language-server.cmd" } else { "vscode-css-language-server" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "css", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("CSS LSP not found. Install via: npm install -g vscode-langservers-extracted".to_string())
        }

        // ── HTML ────────────────────────────────────────────────────────────
        "html" => {
            let bin_name = if cfg!(windows) { "vscode-html-language-server.cmd" } else { "vscode-html-language-server" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "html", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("HTML LSP not found. Install via: npm install -g vscode-langservers-extracted".to_string())
        }

        // ── JSON / JSONC ─────────────────────────────────────────────────────
        "json" | "jsonc" => {
            let bin_name = if cfg!(windows) { "vscode-json-language-server.cmd" } else { "vscode-json-language-server" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "json", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("JSON LSP not found. Install via: npm install -g vscode-langservers-extracted".to_string())
        }

        // ── Vue (Volar) ──────────────────────────────────────────────────────
        // @vue/language-server: npm install -g @vue/language-server
        "vue" => {
            let bin_name = if cfg!(windows) { "vue-language-server.cmd" } else { "vue-language-server" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "vue", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("Vue LSP (Volar) not found. Install via: npm install -g @vue/language-server".to_string())
        }

        // ── Svelte ───────────────────────────────────────────────────────────
        // svelte-language-server: npm install -g svelte-language-server
        "svelte" => {
            let bin_name = if cfg!(windows) { "svelteserver.cmd" } else { "svelteserver" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "svelte", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("Svelte LSP not found. Install via: npm install -g svelte-language-server".to_string())
        }

        // ── GraphQL ───────────────────────────────────────────────────────────
        // graphql-language-service-cli: npm install -g graphql-language-service-cli
        "graphql" => {
            let bin_name = if cfg!(windows) { "graphql-lsp.cmd" } else { "graphql-lsp" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "graphql", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["server".to_string(), "-m".to_string(), "stream".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["server".to_string(), "-m".to_string(), "stream".to_string()]));
            }
            Err("GraphQL LSP not found. Install via: npm install -g graphql-language-service-cli".to_string())
        }

        // ── YAML ─────────────────────────────────────────────────────────────
        // yaml-language-server: npm install -g yaml-language-server
        "yaml" => {
            let bin_name = if cfg!(windows) { "yaml-language-server.cmd" } else { "yaml-language-server" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "yaml", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("YAML LSP not found. Install via: npm install -g yaml-language-server".to_string())
        }

        // ── TOML ─────────────────────────────────────────────────────────────
        // taplo: cargo install taplo-cli  OR  brew install taplo
        "toml" => {
            let bin_name = if cfg!(windows) { "taplo.exe" } else { "taplo" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "toml", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["lsp".to_string(), "stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["lsp".to_string(), "stdio".to_string()]));
            }
            Err("TOML LSP (taplo) not found. Install via: cargo install taplo-cli   OR   brew install taplo".to_string())
        }

        // ── Bash / Shell ─────────────────────────────────────────────────────
        // bash-language-server: npm install -g bash-language-server
        "bash" | "shellscript" => {
            let bin_name = if cfg!(windows) { "bash-language-server.cmd" } else { "bash-language-server" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "bash", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["start".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["start".to_string()]));
            }
            Err("Bash LSP not found. Install via: npm install -g bash-language-server".to_string())
        }

        // ── Dockerfile ───────────────────────────────────────────────────────
        // dockerfile-language-server-nodejs: npm install -g dockerfile-language-server-nodejs
        "dockerfile" => {
            let bin_name = if cfg!(windows) { "docker-langserver.cmd" } else { "docker-langserver" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "dockerfile", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec!["--stdio".to_string()]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec!["--stdio".to_string()]));
            }
            Err("Dockerfile LSP not found. Install via: npm install -g dockerfile-language-server-nodejs".to_string())
        }

        // ── Lua ──────────────────────────────────────────────────────────────
        // lua-language-server: brew install lua-language-server
        "lua" => {
            let bin_name = if cfg!(windows) { "lua-language-server.exe" } else { "lua-language-server" };
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec![]));
            }
            Err("Lua LSP not found. Install via: brew install lua-language-server   OR   winget install lua-language-server".to_string())
        }

        // ── SQL ───────────────────────────────────────────────────────────────
        // sqls: go install github.com/sqls-server/sqls@latest
        "sql" => {
            let bin_name = if cfg!(windows) { "sqls.exe" } else { "sqls" };
            if let Some(bin) = crate::lsp_install::managed_binary_path(app, "sql", &[bin_name]) {
                return Ok((bin.to_string_lossy().into_owned(), vec![]));
            }
            if which_exists(bin_name) {
                return Ok((bin_name.to_string(), vec![]));
            }
            Err("SQL LSP (sqls) not found. Install via: go install github.com/sqls-server/sqls@latest".to_string())
        }

        other => Err(format!(
            "No LSP server configured for language '{other}'. \
             Supported: python, go, typescript, javascript, rust, c, cpp, java, \
             csharp, php, ruby, kotlin, swift, dart, css, scss, less, html, json, \
             jsonc, vue, svelte, graphql, yaml, toml, bash, shellscript, \
             dockerfile, lua, sql."
        )),
    }
}

// ── which_exists helper ──────────────────────────────────────────────────────
// Returns true when `name` resolves to an executable via `which` / `where`.
fn which_exists(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    let prog = "where";
    #[cfg(not(target_os = "windows"))]
    let prog = "which";

    std::process::Command::new(prog)
        .arg(name)
        .no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Incoming message dispatch ────────────────────────────────────────────

fn handle_incoming(
    app: &AppHandle,
    language: &str,
    root: &str,
    msg: Value,
    pending: &Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
) {
    // Response or server→client request: both carry an "id".
    if let Some(id) = msg.get("id").and_then(Value::as_i64) {
        if msg.get("method").is_some() {
            // Server is asking US something (e.g. workspace/configuration,
            // window/workDoneProgress/create, client/registerCapability).
            // We don't implement any of these; reply with a null result so
            // the server doesn't block waiting on a response that never
            // comes.
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
            if let Ok(mut s) = stdin.lock() {
                let _ = write_message(&mut s, &reply);
            }
            return;
        }

        // It's a response to one of our requests — resolve the pending future.
        let sender = pending.lock().unwrap().remove(&id);
        if let Some(sender) = sender {
            let payload = if let Some(err) = msg.get("error") {
                json!({ "error": err })
            } else {
                msg.get("result").cloned().unwrap_or(Value::Null)
            };
            let _ = sender.send(payload);
        }
        return;
    }

    // No "id" → notification.
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        if method == "textDocument/publishDiagnostics" {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let _ = app.emit(
                &format!("lsp-diagnostics-{language}"),
                json!({ "language": language, "root": root, "params": params }),
            );
        }
        // window/logMessage, $/progress, etc. are intentionally ignored —
        // not needed for hover/definition/references/diagnostics.
    }
}

/// Spawns the server process, wires up stdout/stderr readers, and returns
/// the (not-yet-initialized) session. Does NOT send `initialize` — the
/// caller (`lsp_start`) owns the handshake so it can await the response.
fn spawn_session(app: &AppHandle, language: &str, root: &str) -> CmdResult<LspSession> {
    let (program, args) = resolve_server_command(app, language)?;

    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("Failed to spawn LSP server '{program}' for '{language}': {e}"))?;

    let stdin = child.stdin.take().ok_or("LSP process has no stdin handle")?;
    let stdout = child.stdout.take().ok_or("LSP process has no stdout handle")?;
    let stderr = child.stderr.take().ok_or("LSP process has no stderr handle")?;

    let stdin: Arc<Mutex<std::process::ChildStdin>> = Arc::new(Mutex::new(stdin));
    let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicI64::new(1));

    // Drain stderr to the console for debugging; servers are chatty here.
    let language_for_stderr = language.to_string();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => eprintln!("[lsp:{language_for_stderr}:stderr] {}", line.trim_end()),
            }
        }
    });

    // Read + dispatch framed stdout messages until the process exits.
    let app_clone        = app.clone();
    let language_clone    = language.to_string();
    let root_clone        = root.to_string();
    let pending_clone     = Arc::clone(&pending);
    let stdin_for_replies = Arc::clone(&stdin);

    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(msg)) => {
                    handle_incoming(&app_clone, &language_clone, &root_clone, msg, &pending_clone, &stdin_for_replies);
                }
                Ok(None) | Err(_) => {
                    // EOF or a framing error — treat both as a crash.
                    let key = session_key(&language_clone, &root_clone);
                    with_lsp_sessions(|map| {
                        map.remove(&key);
                    });
                    let _ = app_clone.emit(&format!("lsp-crashed-{language_clone}"), root_clone.clone());
                    break;
                }
            }
        }
    });

    Ok(LspSession { stdin, pending, next_id, child })
}

/// Sends a JSON-RPC request over an already-spawned session's stdin and
/// awaits the correlated response via a `oneshot` channel. This is the core
/// of the request/response correlation across the Tauri command boundary:
/// the pending sender is registered BEFORE the write (so a fast reply can
/// never race ahead of registration), and the receiver is awaited with a
/// timeout so a non-responding server can't leak the slot forever.
async fn send_request(
    stdin:   &Arc<Mutex<std::process::ChildStdin>>,
    pending: &Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: &Arc<AtomicI64>,
    method:  &str,
    params:  Value,
    timeout: Duration,
) -> CmdResult<Value> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });

    let (tx, rx) = oneshot::channel::<Value>();
    pending.lock().unwrap().insert(id, tx);

    {
        let mut s = stdin.lock().map_err(|_| "LSP stdin lock poisoned".to_string())?;
        if let Err(e) = write_message(&mut s, &request) {
            pending.lock().unwrap().remove(&id);
            return Err(format!("LSP write error sending '{method}': {e}"));
        }
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => {
            if let Some(err) = value.get("error") {
                Err(format!("LSP server returned an error for '{method}': {err}"))
            } else {
                Ok(value)
            }
        }
        Ok(Err(_)) => Err(format!("LSP response channel for '{method}' closed (server likely crashed)")),
        Err(_) => {
            pending.lock().unwrap().remove(&id);
            Err(format!("LSP request '{method}' timed out after {:?}", timeout))
        }
    }
}

fn send_notification(
    stdin:  &Arc<Mutex<std::process::ChildStdin>>,
    method: &str,
    params: Value,
) -> CmdResult<()> {
    let notification = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    let mut s = stdin.lock().map_err(|_| "LSP stdin lock poisoned".to_string())?;
    write_message(&mut s, &notification).map_err(|e| format!("LSP write error sending '{method}': {e}"))
}

// ── Tauri commands ────────────────────────────────────────────────────────

/// Lazily spawns + initializes the LSP server for (language, root). Safe to
/// call repeatedly — a no-op once a session is already registered.
#[tauri::command]
pub async fn lsp_start(app: AppHandle, language: String, root: String) -> CmdResult<()> {
    let key = session_key(&language, &root);

    if with_lsp_sessions(|map| map.contains_key(&key)) {
        return Ok(());
    }

    let session = spawn_session(&app, &language, &root)?;

    let root_uri = format!("file://{}", root.replace('\\', "/"));
    let init_params = json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
        "capabilities": {
            "textDocument": {
                "synchronization": { "didSave": true },
                "hover":           { "contentFormat": ["markdown", "plaintext"] },
                "definition":      { "linkSupport": false },
                "references":      {},
                "publishDiagnostics": { "relatedInformation": true },
            },
        },
    });

    // Initialize handshake — must complete before any other request.
    send_request(&session.stdin, &session.pending, &session.next_id, "initialize", init_params, Duration::from_secs(20)).await?;
    send_notification(&session.stdin, "initialized", json!({}))?;

    with_lsp_sessions(|map| {
        map.insert(key, session);
    });

    Ok(())
}

/// Sends a JSON-RPC request to an already-started session and returns the
/// raw `result` value (or an Err for `error` responses / timeouts).
#[tauri::command]
pub async fn lsp_request(language: String, root: String, method: String, params: Value) -> CmdResult<Value> {
    let key = session_key(&language, &root);
    let (stdin, pending, next_id) = with_lsp_sessions(|map| {
        map.get(&key).map(|s| (Arc::clone(&s.stdin), Arc::clone(&s.pending), Arc::clone(&s.next_id)))
    })
    .ok_or_else(|| format!("No active LSP session for '{language}' at '{root}' — call lsp_start first"))?;

    send_request(&stdin, &pending, &next_id, &method, params, Duration::from_secs(15)).await
}

/// Sends a fire-and-forget JSON-RPC notification (e.g. textDocument/didOpen).
#[tauri::command]
pub async fn lsp_notify(language: String, root: String, method: String, params: Value) -> CmdResult<()> {
    let key = session_key(&language, &root);
    let stdin = with_lsp_sessions(|map| map.get(&key).map(|s| Arc::clone(&s.stdin)))
        .ok_or_else(|| format!("No active LSP session for '{language}' at '{root}' — call lsp_start first"))?;

    send_notification(&stdin, &method, params)
}

/// Kills the server process and removes it from the registry.
#[tauri::command]
pub async fn lsp_stop(language: String, root: String) -> CmdResult<()> {
    let key = session_key(&language, &root);
    with_lsp_sessions(|map| {
        if let Some(mut session) = map.remove(&key) {
            let _ = session.child.kill();
        }
    });
    Ok(())
}
