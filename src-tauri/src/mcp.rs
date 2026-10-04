// src-tauri/src/mcp.rs
//
// MCP (Model Context Protocol) client, backed by the official `rmcp` Rust
// SDK (https://github.com/modelcontextprotocol/rust-sdk).
//
// This file used to hand-roll JSON-RPC framing, the `initialize` handshake,
// request-id bookkeeping, timeouts, and stdio line-framing itself (see git
// history). All of that is now owned by `rmcp`: transport, protocol
// negotiation, request/response correlation, cancellation, and errors.
// What's left here is a thin wrapper: spawn/connect, remember the resulting
// session per `server_id`, and translate Tauri commands into rmcp calls.
//
// Commands:
//   mcp_connect(server_id, command, args, env, cwd, url?, auth_token?)
//     – stdio: spawns `command` with `args`/`env`/`cwd` as a child process
//       transport. remote: if `url` is set, connects over Streamable HTTP
//       instead and the stdio fields are ignored; `auth_token`, if set, is
//       sent as `Authorization: Bearer <auth_token>` on every request (used
//       for OAuth-authenticated remote MCP servers — see oauth.rs).
//       rmcp performs the `initialize` handshake as part of `.serve()`.
//       Returns the server's advertised tools (same as mcp_list_tools).
//   mcp_list_tools(server_id) / mcp_list_resources(server_id) /
//   mcp_list_prompts(server_id)
//     – re-queries the server for its current tools/resources/prompts.
//   mcp_call_tool(server_id, name, arguments)
//   mcp_read_resource(server_id, uri)
//     – forwards to the server and returns its result as JSON.
//   mcp_disconnect(server_id)
//     – cancels the session (closes the transport / kills the child
//       process for stdio servers) and drops it from the registry.
//   mcp_is_connected(server_id)
//     – whether a session is currently registered for this id.
//
// Stdio connection diagnostics (see `ProcessDiagnostics` below):
//   rmcp's own handshake error only says the transport closed (e.g.
//   "connection closed: initialize response") — it doesn't say *why* the
//   server process went away. For stdio servers we spawn the child
//   ourselves (instead of via rmcp's `TokioChildProcess` convenience
//   wrapper) so we can keep its stderr pipe and exit status around after
//   handing rmcp just the stdout/stdin pair as the JSON-RPC transport.
//   `(ChildStdout, ChildStdin)` is one of rmcp's own first-class transport
//   shapes (`IntoTransport` for `(R, W): AsyncRead + AsyncWrite`, see
//   rmcp::transport::async_rw) — this changes who owns the OS process, not
//   how the MCP protocol is spoken over it.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ReadResourceRequestParams};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport};
use rmcp::ServiceExt;
use serde_json::Value;
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, ChildStderr, Command};
use tokio::sync::Mutex;

use crate::process_ext::NoWindow;
use crate::process_utils::{resolve_executable, with_managed_node_path};

type CmdResult<T> = Result<T, String>;

/// Tool calls can run arbitrary remote/local work (DB queries, API calls,
/// browser automation, ...) — give them more headroom than a plain
/// round-trip. Everything else (list_tools, connect, etc.) uses rmcp's own
/// default request timeout.
const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(120);

const GMAIL_OAUTH_KEYS_FILE: &str = "gcp-oauth.keys.json";
const GMAIL_TOKEN_FILE: &str = "credentials.json";

fn gmail_credentials_dir() -> CmdResult<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "Could not determine the current user's home directory".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".gmail-mcp"))
}

/// Validate and install the Desktop OAuth client where the Gmail MCP's
/// `auth` subcommand requires it. The copy deliberately lives in the user's
/// home directory so both auth and normal server processes reuse it across
/// projects and application restarts.
#[tauri::command]
pub async fn gmail_install_oauth_keys(source_path: String) -> CmdResult<String> {
    let bytes = fs::read(&source_path)
        .map_err(|e| format!("Could not read Google OAuth JSON at '{source_path}': {e}"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("The selected Google OAuth file is not valid JSON: {e}"))?;
    let client = value.get("installed").or_else(|| value.get("web"));
    let valid = client.and_then(Value::as_object).is_some_and(|v| {
        v.get("client_id")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
            && v.get("client_secret")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
    });
    if !valid {
        return Err("The selected file is not a Google OAuth client JSON (client_id/client_secret are missing).".to_string());
    }

    let dir = gmail_credentials_dir()?;
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Could not create Gmail credentials directory '{}': {e}",
            dir.display()
        )
    })?;
    let destination = dir.join(GMAIL_OAUTH_KEYS_FILE);
    fs::write(&destination, bytes).map_err(|e| {
        format!(
            "Could not store Gmail OAuth keys at '{}': {e}",
            destination.display()
        )
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

/// A successfully completed `auth` run writes a non-empty JSON credentials
/// file. This avoids re-running browser authentication on later connections.
#[tauri::command]
pub async fn gmail_is_authenticated() -> CmdResult<bool> {
    let token = gmail_credentials_dir()?.join(GMAIL_TOKEN_FILE);
    let Ok(bytes) = fs::read(token) else {
        return Ok(false);
    };
    let Ok(Value::Object(credentials)) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(false);
    };
    Ok(["access_token", "refresh_token"]
        .iter()
        .any(|key| credentials.get(*key).and_then(Value::as_str).is_some_and(|v| !v.is_empty())))
}

/// Run the package's one-shot `auth` mode and wait for its local browser
/// callback to complete. Only the Gmail-specific frontend path calls this;
/// normal MCP providers and transports remain unchanged.
#[tauri::command]
pub async fn gmail_authenticate(
    command: String,
    mut args: Vec<String>,
    mut env: HashMap<String, String>,
) -> CmdResult<()> {
    if gmail_is_authenticated().await? {
        return Ok(());
    }
    let dir = gmail_credentials_dir()?;
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Could not create Gmail credentials directory '{}': {e}",
            dir.display()
        )
    })?;
    if !dir.join(GMAIL_OAUTH_KEYS_FILE).is_file() {
        return Err(format!(
            "Google OAuth keys are missing at '{}'. Select the OAuth JSON in Gmail settings first.",
            dir.join(GMAIL_OAUTH_KEYS_FILE).display()
        ));
    }

    env.insert(
        "GMAIL_OAUTH_PATH".to_string(),
        dir.join(GMAIL_OAUTH_KEYS_FILE).to_string_lossy().into_owned(),
    );
    env.insert(
        "GMAIL_CREDENTIALS_PATH".to_string(),
        dir.join(GMAIL_TOKEN_FILE).to_string_lossy().into_owned(),
    );

    args.push("auth".to_string());
    let resolved = resolve_executable(&command);
    let mut cmd = Command::new(&resolved);
    cmd.args(&args).envs(&env).current_dir(&dir);
    with_managed_node_path(cmd.as_std_mut());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to start Gmail authentication command: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "Gmail authentication failed{}",
            if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
        ));
    }
    if !gmail_is_authenticated().await? {
        return Err("Gmail authentication finished without creating a credentials cache. Please try again.".to_string());
    }
    Ok(())
}

// ── Session registry ─────────────────────────────────────────────────────
//
// Keyed by the user-assigned `server_id` (stable uuid-like string minted in
// the frontend store, see store/useMcpStore.ts) — one rmcp session per
// connected server. A `RunningService` owns the transport (child process or
// HTTP connection) and the background task that drives it; dropping it (or
// calling `.cancel()`) tears the connection down, so this map *is* the
// source of truth for "is this server connected".

type McpService = RunningService<RoleClient, ()>;
type ServiceFuture<'a, R> =
    Pin<Box<dyn Future<Output = Result<R, rmcp::ServiceError>> + Send + 'a>>;

static MCP_SESSIONS: Mutex<Option<HashMap<String, McpService>>> = Mutex::const_new(None);

async fn with_mcp_sessions<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, McpService>) -> R,
{
    let mut guard = MCP_SESSIONS.lock().await;
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Borrows the session for `server_id` for the duration of `f`, removing it
/// from the registry if `f` returns an error — a failed request usually
/// means the transport is gone (server process crashed, HTTP connection
/// dropped), so a stale "connected" entry would just hang the next call.
async fn with_service<F, R>(server_id: &str, f: F) -> CmdResult<R>
where
    F: for<'a> FnOnce(&'a McpService) -> ServiceFuture<'a, R>,
{
    let mut guard = MCP_SESSIONS.lock().await;
    let map = guard.get_or_insert_with(HashMap::new);
    let Some(service) = map.get(server_id) else {
        return Err(format!(
            "No active MCP session for '{server_id}' — connect it first"
        ));
    };

    match f(service).await {
        Ok(value) => Ok(value),
        Err(err) => {
            map.remove(server_id);
            // The transport is gone — if this was a stdio server, its
            // process is presumably dead or dying too, but make sure: an
            // un-reaped/lingering child here would otherwise only get
            // cleaned up the next time someone calls mcp_disconnect.
            kill_stdio_child(server_id).await;
            Err(format!("MCP request to '{server_id}' failed: {err}"))
        }
    }
}

// ── Stdio child process diagnostics ──────────────────────────────────────
//
// One entry per connected (or connecting) stdio server, keyed by
// `server_id`. Holds the process handle (for killing on disconnect/
// reconnect/failure) and a rolling stderr tail + exit code (for error
// messages). Remote (Streamable HTTP) servers never have an entry here.

const STDERR_BUFFER_LINES: usize = 200;

/// Rolling stderr tail + exit status for one spawned MCP server process.
/// Shared between the background stderr-reader task (writer) and whoever
/// is building an error message (reader). Plain `std::sync::Mutex` is fine
/// here — every critical section is a cheap, non-async buffer mutation.
struct ProcessDiagnostics {
    stderr: StdMutex<VecDeque<String>>,
    exit_code: StdMutex<Option<i32>>,
}

impl ProcessDiagnostics {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stderr: StdMutex::new(VecDeque::with_capacity(STDERR_BUFFER_LINES)),
            exit_code: StdMutex::new(None),
        })
    }

    fn push_line(&self, line: String) {
        let mut buf = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        if buf.len() >= STDERR_BUFFER_LINES {
            buf.pop_front();
        }
        buf.push_back(line);
    }

    fn set_exit_code(&self, code: Option<i32>) {
        *self.exit_code.lock().unwrap_or_else(|e| e.into_inner()) = code;
    }

    /// Snapshot of the current stderr tail and exit code, for building an
    /// error message. Doesn't consume/clear anything — the buffer keeps
    /// collecting for as long as the process is running.
    fn snapshot(&self) -> (Vec<String>, Option<i32>) {
        let lines = self
            .stderr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        let code = *self.exit_code.lock().unwrap_or_else(|e| e.into_inner());
        (lines, code)
    }
}

/// A tracked stdio child process: shared with the background stderr-reader
/// task so both it and `kill_stdio_child` can wait()/kill() it safely (the
/// `tokio::sync::Mutex` means only one of them ever touches the child at a
/// time — no racing waitpid() calls).
struct StdioChild {
    child: Arc<Mutex<Child>>,
    diagnostics: Arc<ProcessDiagnostics>,
}

static MCP_CHILDREN: Mutex<Option<HashMap<String, Arc<StdioChild>>>> = Mutex::const_new(None);

async fn with_mcp_children<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, Arc<StdioChild>>) -> R,
{
    let mut guard = MCP_CHILDREN.lock().await;
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Kills and reaps the tracked stdio child process for `server_id`, if
/// there is one. A no-op for remote servers or a server that was already
/// cleaned up — safe to call unconditionally from every teardown path.
async fn kill_stdio_child(server_id: &str) {
    let Some(entry) = with_mcp_children(|map| map.remove(server_id)).await else {
        return;
    };
    let mut child = entry.child.lock().await;
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// Reads the child's stderr asynchronously, line by line, into a rolling
/// buffer — runs for the lifetime of the process and never touches the
/// stdin/stdout pipes rmcp is using for the JSON-RPC transport, so it can't
/// block or interfere with that. Once stderr closes (almost always because
/// the process exited or is exiting), makes a best-effort, bounded attempt
/// to record the exit code for diagnostics; process cleanup itself remains
/// the job of `kill_stdio_child`.
fn spawn_stderr_reader(
    stderr: ChildStderr,
    diagnostics: Arc<ProcessDiagnostics>,
    child: Arc<Mutex<Child>>,
) {
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => diagnostics.push_line(line),
                Ok(None) | Err(_) => break, // EOF or read error — done collecting.
            }
        }

        let mut guard = child.lock().await;
        if let Ok(Some(status)) = guard.try_wait() {
            diagnostics.set_exit_code(status.code());
        } else if let Ok(Ok(status)) =
            tokio::time::timeout(Duration::from_millis(1500), guard.wait()).await
        {
            diagnostics.set_exit_code(status.code());
        }
        // If neither resolves quickly, leave exit_code as None — the error
        // message reports it as unavailable rather than blocking on it.
    });
}

/// Builds the structured connection-failure message described in the MCP
/// diagnostics improvement: rmcp's own error, the exit code if known, and
/// the last captured stderr lines (or an explicit "no output" note).
async fn connection_failure_message(
    label: &str,
    rmcp_err: &str,
    diagnostics: Option<&ProcessDiagnostics>,
) -> String {
    let mut message = format!("Failed to connect to MCP server '{label}'.\nrmcp: {rmcp_err}");

    let Some(diagnostics) = diagnostics else {
        return message;
    };

    // A process that fails fast (e.g. exits immediately because a required
    // env var is missing) can beat the stderr-reader task to recording its
    // exit code. Give it a brief window to catch up before we snapshot.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (lines, exit_code) = diagnostics.snapshot();

    match exit_code {
        Some(code) => message.push_str(&format!("\nExit code: {code}")),
        None => message.push_str("\nExit code: unavailable (process may still be running)"),
    }

    if lines.is_empty() {
        message.push_str("\nstderr: No stderr output was produced by the MCP server.");
    } else {
        message.push_str(&format!("\nstderr:\n{}", lines.join("\n")));
    }

    message
}

// ── Transport setup ──────────────────────────────────────────────────────

async fn connect_stdio(
    server_id: &str,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: Option<&str>,
) -> CmdResult<McpService> {
    let program = resolve_executable(command);
    let args = args.to_vec();
    let env = env.clone();
    let cwd = cwd.map(|s| s.to_string());

    let mut cmd = Command::new(&program).configure(|cmd| {
        cmd.no_window();
        cmd.args(&args);
        for (k, v) in &env {
            cmd.env(k, v);
        }
        if let Some(dir) = &cwd {
            if !dir.is_empty() {
                cmd.current_dir(dir);
            }
        }
        with_managed_node_path(cmd.as_std_mut());
    });
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server '{command}': {e}"))?;

    // Pull the three pipes apart: stdout/stdin go to rmcp as the JSON-RPC
    // transport, stderr goes to our own reader task. rmcp never sees the
    // `Child` itself, so it can't race us for who gets to wait()/kill() it.
    let stdout = child.stdout.take().ok_or_else(|| {
        format!("Failed to spawn MCP server '{command}': no stdout pipe")
    })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        format!("Failed to spawn MCP server '{command}': no stdin pipe")
    })?;
    let stderr = child.stderr.take();

    let diagnostics = ProcessDiagnostics::new();
    let child = Arc::new(Mutex::new(child));

    if let Some(stderr) = stderr {
        spawn_stderr_reader(stderr, diagnostics.clone(), child.clone());
    }

    // Track the process immediately (before the handshake even starts) so
    // it's reachable for cleanup and diagnostics no matter how connecting
    // fails, and drop any leftover entry from a previous attempt for this
    // same server_id first.
    kill_stdio_child(server_id).await;
    with_mcp_children(|map| {
        map.insert(
            server_id.to_string(),
            Arc::new(StdioChild {
                child,
                diagnostics: diagnostics.clone(),
            }),
        );
    })
    .await;

    match ().serve((stdout, stdin)).await {
        Ok(service) => Ok(service),
        Err(err) => {
            let message =
                connection_failure_message(command, &err.to_string(), Some(&diagnostics)).await;
            // The handshake failed — this server_id isn't "connected", so
            // don't leave its process lingering in the tracker.
            kill_stdio_child(server_id).await;
            Err(message)
        }
    }
}

/// `auth_token` (when set) is sent as `Authorization: Bearer <auth_token>` on
/// every request the transport makes — this is how OAuth-authenticated
/// remote MCP servers (see `oauth.rs` / the frontend's `OAuthManager`) get
/// their access token onto the wire. Static/no-auth remote servers simply
/// pass `None`.
async fn connect_remote(url: &str, auth_token: Option<String>) -> CmdResult<McpService> {
    let config = rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig {
        uri: url.to_string().into(),
        auth_header: auth_token,
        ..Default::default()
    };
    let transport = StreamableHttpClientTransport::from_config(config);
    match ().serve(transport).await {
        Ok(service) => Ok(service),
        Err(err) => Err(connection_failure_message(url, &err.to_string(), None).await),
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────

/// Connects to an MCP server — spawning it as a local process (stdio) or
/// dialing it over Streamable HTTP (`url`, remote) — and returns its
/// advertised tools. Safe to call again for an already-connected server
/// (reconnects with a fresh session).
///
/// `auth_token`: for remote (`url`-based) servers only, an already-valid
/// OAuth access token (or any other bearer token) to send as
/// `Authorization: Bearer <auth_token>`. Callers are expected to have
/// already resolved a *valid, non-expired* token before calling this — see
/// `services/oauth/OAuthManager.ts` on the frontend, which refreshes an
/// expired token before every connect. Ignored for stdio servers.
#[tauri::command]
pub async fn mcp_connect(
    server_id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
    url: Option<String>,
    auth_token: Option<String>,
) -> CmdResult<Vec<Value>> {
    // Drop any existing session for this id first (reconnect = fresh session).
    if let Some(existing) = with_mcp_sessions(|map| map.remove(&server_id)).await {
        let _ = existing.cancel().await;
    }
    kill_stdio_child(&server_id).await;

    let service = match url.filter(|u| !u.is_empty()) {
        Some(url) => connect_remote(&url, auth_token.filter(|t| !t.is_empty())).await?,
        None => connect_stdio(&server_id, &command, &args, &env, cwd.as_deref()).await?,
    };

    let tools = match service.list_tools(Default::default()).await {
        Ok(tools) => tools,
        Err(err) => {
            let _ = service.cancel().await;
            kill_stdio_child(&server_id).await;
            return Err(format!("Failed to list tools for '{server_id}': {err}"));
        }
    };
    let tool_values = tools_to_json(&tools.tools);

    with_mcp_sessions(|map| map.insert(server_id, service)).await;
    Ok(tool_values)
}

/// Re-fetches `tools/list` for an already-connected server.
#[tauri::command]
pub async fn mcp_list_tools(server_id: String) -> CmdResult<Vec<Value>> {
    let tools = with_service(&server_id, |s| Box::pin(s.list_tools(Default::default()))).await?;
    Ok(tools_to_json(&tools.tools))
}

/// Calls a tool on an already-connected server and returns its result as
/// JSON — typically `{ content: [...], isError?: bool }`.
#[tauri::command]
pub async fn mcp_call_tool(server_id: String, name: String, arguments: Value) -> CmdResult<Value> {
    let arguments = match arguments {
        Value::Object(map) => Some(map),
        _ => None,
    };
    let param = CallToolRequestParams {
        name: name.into(),
        arguments,
        meta: None,
        task: None,
    };

    let result = with_service(&server_id, |s| {
        Box::pin(async move {
            match tokio::time::timeout(TOOL_CALL_TIMEOUT, s.call_tool(param)).await {
                Ok(inner) => inner,
                Err(_) => Err(rmcp::ServiceError::Timeout {
                    timeout: TOOL_CALL_TIMEOUT,
                }),
            }
        })
    })
    .await?;

    serde_json::to_value(&result).map_err(|e| format!("Failed to serialize tool result: {e}"))
}

/// Re-fetches `resources/list` for an already-connected server.
#[tauri::command]
pub async fn mcp_list_resources(server_id: String) -> CmdResult<Vec<Value>> {
    let resources = with_service(&server_id, |s| {
        Box::pin(s.list_resources(Default::default()))
    })
    .await?;
    Ok(resources
        .resources
        .iter()
        .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
        .collect())
}

/// Reads a resource by URI from an already-connected server.
#[tauri::command]
pub async fn mcp_read_resource(server_id: String, uri: String) -> CmdResult<Value> {
    let result = with_service(&server_id, |s| {
        Box::pin(s.read_resource(ReadResourceRequestParams { uri, meta: None }))
    })
    .await?;
    serde_json::to_value(&result).map_err(|e| format!("Failed to serialize resource: {e}"))
}

/// Re-fetches `prompts/list` for an already-connected server.
#[tauri::command]
pub async fn mcp_list_prompts(server_id: String) -> CmdResult<Vec<Value>> {
    let prompts =
        with_service(&server_id, |s| Box::pin(s.list_prompts(Default::default()))).await?;
    Ok(prompts
        .prompts
        .iter()
        .map(|p| serde_json::to_value(p).unwrap_or(Value::Null))
        .collect())
}

/// Closes the session (stdio: kills the child process; remote: closes the
/// HTTP connection) and removes it from the registry.
#[tauri::command]
pub async fn mcp_disconnect(server_id: String) -> CmdResult<()> {
    if let Some(service) = with_mcp_sessions(|map| map.remove(&server_id)).await {
        let _ = service.cancel().await;
    }
    // Belt-and-suspenders: `service.cancel()` only closes the transport
    // (for stdio, that's dropping the stdin/stdout pipes — most well
    // behaved servers exit on EOF, but not all do). We own the child
    // process independently of rmcp now, so make sure it's actually gone.
    kill_stdio_child(&server_id).await;
    Ok(())
}

/// Whether a session is currently registered for this server id.
#[tauri::command]
pub async fn mcp_is_connected(server_id: String) -> CmdResult<bool> {
    Ok(with_mcp_sessions(|map| map.contains_key(&server_id)).await)
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// `rmcp::model::Tool` already (de)serializes to/from the wire's
/// `{ name, description, inputSchema }` shape, so we pass it straight
/// through as JSON rather than re-declaring an equivalent Rust struct —
/// the frontend's `McpToolInfo` type (lib/mcp/McpClient.ts) matches this
/// shape directly.
fn tools_to_json(tools: &[rmcp::model::Tool]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
        .collect()
}
