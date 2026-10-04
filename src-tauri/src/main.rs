// src-tauri/src/main.rs
// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use tauri::{Emitter, Manager};

mod action_notifications;
mod app_registry;
mod auth;
mod browser_profiles;
mod commands;
mod db;
mod input_control;
mod keychain;
mod logging;
mod lsp;
mod lsp_install;
mod mcp;
mod oauth;
mod process_ext;
mod process_utils;
mod desktop_task;
mod watcher;
mod window_control;
mod window_registry;

// ── Multi-instance support ──────────────────────────────────────────────────
//
// Rachna IDE allows multiple full app windows to be open at once (like
// VS Code) — there is deliberately NO OS-level single-instance lock here.
//
// The one thing that still needs cross-process coordination is the OAuth
// deep-link redirect: `rachna-ide://auth?token=...`. On Windows/Linux, the OS
// launches a brand-new *process* of the app for that URL scheme rather than
// routing it into an already-open window, so left unhandled every login
// would pop a second, otherwise-blank IDE window instead of signing the
// user's existing (already-open) sign-in screen in.
//
// We solve just that narrow case with a tiny best-effort loopback TCP
// handshake, instead of a blanket single-instance plugin:
//   • Any already-running instance opens a listener on DEEP_LINK_PORT (the
//     first instance to start "wins" the port; later instances simply skip
//     listening, which is fine — it only needs one live listener).
//   • A brand-new process, before creating any window, checks whether its
//     own argv contains a `rachna-ide://` URL. If so, it tries to hand that
//     URL off to whichever instance is listening and then exits immediately
//     — no extra window ever appears. If no instance is listening (e.g. this
//     really is the first launch), it falls through and starts up normally;
//     `App.tsx`'s `getCurrent()` picks the URL up on cold start as before.
// Ordinary launches (double-clicking the exe, opening a new window from the
// Start Menu, etc.) never carry a `rachna-ide://` arg, so they always fall
// straight through to a fresh, independent instance.
const DEEP_LINK_PORT: u16 = 47813;

fn deep_link_arg() -> Option<String> {
    std::env::args().find(|a| a.starts_with("rachna-ide://"))
}

/// Try to forward `url` to an already-running instance's listener.
/// Returns true if the handoff succeeded (caller should exit immediately).
fn try_forward_deep_link(url: &str) -> bool {
    match TcpStream::connect_timeout(
        &format!("127.0.0.1:{DEEP_LINK_PORT}").parse().unwrap(),
        Duration::from_millis(200),
    ) {
        Ok(mut stream) => {
            let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
            stream.write_all(url.as_bytes()).is_ok()
        }
        Err(_) => false,
    }
}

/// Start (best-effort) the loopback listener that receives deep-link URLs
/// forwarded from later processes. Safe to call from every instance — only
/// the first one to successfully bind the port actually listens; the rest
/// silently no-op, since a single live listener is all that's needed.
fn start_deep_link_listener(app_handle: tauri::AppHandle) {
    let listener = match TcpListener::bind(("127.0.0.1", DEEP_LINK_PORT)) {
        Ok(l) => l,
        Err(_) => return, // another instance already owns the port — fine
    };
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let mut buf = Vec::new();
            if stream.read_to_end(&mut buf).is_err() && buf.is_empty() {
                continue;
            }
            let Ok(url) = String::from_utf8(buf) else {
                continue;
            };
            if url.is_empty() {
                continue;
            }

            let _ = app_handle.emit("deep-link-urls", vec![url]);
            if let Some(window) = app_handle.webview_windows().values().next() {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    });
}

fn main() {
    // Installed as the very first thing in main() -- before deep-link
    // handling, before the Tauri builder, before anything else -- so every
    // panic from here on, no matter how early, is captured to
    // data/startup.log (message + location + backtrace) even though
    // release builds run with `panic = "abort"` and there's no unwinding to
    // catch. See src-tauri/src/logging.rs for details.
    logging::install_panic_hook();
    logging::checkpoint("main() entered");

    // Handle an incoming OAuth deep-link handoff BEFORE any window is
    // created — if another instance is already listening, forward the URL
    // to it and exit immediately so no extra window ever flashes on screen.
    if let Some(url) = deep_link_arg() {
        logging::checkpoint("deep_link_arg: present, attempting handoff");
        if try_forward_deep_link(&url) {
            logging::ok("deep_link_arg: forwarded to existing instance, exiting");
            return;
        }
        // No listener answered — proceed as a normal (first) launch; the
        // frontend's getCurrent() picks the URL up on cold start.
        logging::ok("deep_link_arg: no listener answered, continuing as normal launch");
    } else {
        logging::ok("deep_link_arg: none present");
    }

    logging::checkpoint("tauri_builder: begin plugin registration");

    let builder = tauri::Builder::default();

    // Register the tauri-plugin-dialog for open/save dialogs
    let builder = builder.plugin(tauri_plugin_dialog::init());
    logging::ok("plugin: dialog");

    // Register the tauri-plugin-shell so scan_repo can spawn `node`
    // (required by the Tauri 2 capability system on Windows)
    let builder = builder.plugin(tauri_plugin_shell::init());
    logging::ok("plugin: shell");

    // Deep-link plugin — handles rachna-ide:// URI scheme for OAuth callback
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    logging::ok("plugin: deep_link");

    let builder = builder.plugin(tauri_plugin_fs::init());
    logging::ok("plugin: fs");

    let builder = builder.plugin(tauri_plugin_os::init());
    logging::ok("plugin: os");

    let builder = builder.plugin(tauri_plugin_process::init());
    logging::ok("plugin: process");

    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    logging::ok("plugin: updater");

    // Desktop Task tool: OS notifications + clipboard read/write
    // (open_path/launch_app/list_processes/kill_process need no plugin —
    // see src-tauri/src/desktop_task.rs).
    let builder = builder.plugin(tauri_plugin_notification::init());
    logging::ok("plugin: notification");

    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    logging::ok("plugin: clipboard_manager");

    logging::ok("tauri_builder: plugin registration complete");

    let builder = builder
        // Managed state for the incremental file watcher
        .manage(watcher::WatcherState::new())
        // Initialise SQLite database on first start
        .setup(|app| {
            logging::checkpoint("setup: local_data_dir resolution");
            let app_data_dir = match commands::local_data_dir(app.handle()) {
                Ok(dir) => {
                    logging::ok(&format!("setup: local_data_dir resolved to {}", dir.display()));
                    dir
                }
                Err(e) => {
                    // Preserve the original behavior (abort startup on
                    // failure — the app cannot run without a data
                    // directory) but log the exact error first instead of
                    // letting `.expect()` abort silently with no record.
                    logging::fail("setup: local_data_dir resolution", &e);
                    panic!("Failed to resolve local data directory: {e}");
                }
            };

            logging::checkpoint("setup: database initialization (sqlite + sqlite-vec)");
            // Two global databases are initialised eagerly here:
            //   - app.db   (settings / project_registry / run_configs)
            //   - chats.db (conversations / messages / rejected_edits)
            // Each project's Project DB (project.db — chunks/symbols/
            // embeddings) is initialised lazily on first scan (see
            // `db::init_project_db` in commands.rs::scan_repo), same as
            // before this split. Both `db::init_app_db` and
            // `db::init_chats_db` transparently run the legacy migrations
            // (pre-split `chunks.db` -> `app.db`, then legacy combined
            // `app.db` -> `app.db` + `chats.db`) the first time either runs
            // — see db.rs's migration helpers.
            match db::init_app_db(&app_data_dir) {
                Ok(()) => {
                    logging::ok("setup: app.db initialization");
                }
                Err(e) => {
                    // Recovery path: a corrupt/incompatible app.db (e.g.
                    // from a crashed write, a disk-full truncation, or a
                    // schema mismatch left over from an older build) makes
                    // `db::init_app_db` fail every time the app starts, with
                    // no way for the user to recover short of finding the
                    // file themselves. app.db only holds rebuildable/
                    // re-derivable state (settings, the project registry,
                    // run configs — never chat history, which now lives in
                    // chats.db instead), so it's safe to delete and let
                    // `init_app_db` recreate it from scratch, then retry the
                    // failed step once before giving up. This never touches
                    // a legacy `chunks.db` if one is still present — only
                    // the current-generation `app.db` file.
                    logging::fail("setup: app.db initialization (attempt 1)", &e);
                    let db_file = db::app_db_path(&app_data_dir);
                    logging::checkpoint(&format!(
                        "setup: deleting possibly-corrupt {} and retrying",
                        db_file.display()
                    ));

                    // Remove the app.db file plus any WAL/SHM sidecar files
                    // left over from WAL mode, so init_app_db() truly starts
                    // fresh.
                    let _ = std::fs::remove_file(&db_file);
                    let _ = std::fs::remove_file(db_file.with_extension("db-wal"));
                    let _ = std::fs::remove_file(db_file.with_extension("db-shm"));

                    match db::init_app_db(&app_data_dir) {
                        Ok(()) => {
                            logging::ok(
                                "setup: app.db initialization (attempt 2, after deleting app.db)",
                            );
                        }
                        Err(e2) => {
                            logging::fail(
                                "setup: app.db initialization (attempt 2, after deleting app.db)",
                                &e2,
                            );
                            panic!(
                                "Failed to initialise SQLite app.db even after deleting it: {e2}"
                            );
                        }
                    }
                }
            }

            // chats.db holds irreplaceable user data (chat history), so —
            // unlike app.db above — there is NO delete-and-retry recovery
            // path here. A failure is surfaced and the app refuses to start
            // rather than risk silently wiping conversations. `init_chats_db`
            // itself runs the same split-migration as `init_app_db`, so by
            // the time we get here the migration has already happened via
            // whichever of the two ran first.
            match db::init_chats_db(&app_data_dir) {
                Ok(()) => {
                    logging::ok("setup: chats.db initialization");
                }
                Err(e) => {
                    logging::fail("setup: chats.db initialization", &e);
                    panic!(
                        "Failed to initialise SQLite chats.db (chat history is not rebuildable, \
                         so this is not auto-recovered — check {} for details): {e}",
                        db::chats_db_path(&app_data_dir).display()
                    );
                }
            }

            println!("DB initialised at: {}", app_data_dir.display());

            // Best-effort: start listening for deep-link handoffs from any
            // later-launched process (see the multi-instance notes above).
            logging::checkpoint("setup: deep_link listener startup");
            start_deep_link_listener(app.handle().clone());
            logging::ok("setup: deep_link listener startup (best-effort, no failure signal)");

            let window_count = app.webview_windows().len();
            logging::ok(&format!(
                "setup: complete, {window_count} webview window(s) present"
            ));

            Ok(())
        })
        ;

    logging::checkpoint("invoke_handler: registering command handlers");
    let builder = builder
        // Register our custom commands (originals + new search_repo + file ops)
        .invoke_handler(tauri::generate_handler![
            auth::login,
            auth::google_sign_in,
            auth::google_sign_in_cancel,
            auth::verify_session,
            auth::cloud_ai_generate,
            auth::save_cached_session,
            auth::load_cached_session,
            auth::clear_cached_session,
            commands::ensure_node_runtime,
            commands::open_folder,
            commands::read_folder,
            commands::pick_directory,
            commands::pick_file,
            commands::create_project,
            commands::get_default_projects_dir,
            commands::get_mcp_credentials_dir,
            commands::path_info,
            commands::read_file,
            commands::list_directory,
            commands::save_file,
            commands::write_base64_file,
            commands::rename_file,
            commands::delete_file,
            commands::copy_file,
            commands::copy_folder,
            commands::move_folder,
            commands::delete_folder,
            commands::create_folder,
            commands::scan_repo,
            commands::scan_repo_files,
            commands::fast_reindex_files,
            commands::search_repo,
            commands::search_repo_by_file,
            commands::search_symbols,
            commands::get_vector_index_path,
            commands::store_embedding,
            commands::get_embedding_stats,
            commands::reembed_repo,
            commands::run_terminal_command,
            commands::run_http_request,
            commands::proxy_llm_stream,
            commands::run_browser_check,
            commands::render_html_design_preview,
            commands::run_web_task,
            commands::open_terminal_link,
            commands::get_system_info,
            commands::search_files,
            commands::pty_create,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::git_status,
            commands::git_diff,
            commands::git_stage,
            commands::git_unstage,
            commands::git_commit,
            commands::git_push,
            commands::git_pull,
            commands::git_branches,
            commands::git_switch_branch,
            commands::git_create_branch,
            commands::git_log,
            commands::get_home_dir,
            commands::doctor_check,
            commands::save_message,
            commands::set_current_leaf,
            commands::update_message_metadata,
            commands::update_message,
            commands::load_conversation,
            commands::load_conversation_by_id,
            commands::list_conversations,
            commands::list_all_conversations,
            commands::delete_conversation,
            commands::save_rejected_edit,
            commands::get_rejected_edits,
            commands::list_run_configs,
            commands::save_run_config,
            commands::delete_run_config,
            commands::set_active_run_config,
            commands::get_setting,
            commands::set_setting,
            commands::delete_setting,
            commands::list_settings,
            commands::touch_project_registry,
            commands::list_project_registry,
            commands::remove_project_registry_entry,
            app_registry::scan_installed_apps,
            app_registry::launch_installed_app,
            browser_profiles::list_browser_profiles,
            desktop_task::open_path,
            desktop_task::reveal_in_explorer,
            desktop_task::resolve_app,
            desktop_task::launch_app,
            desktop_task::list_processes,
            desktop_task::kill_process,
            desktop_task::show_notification,
            action_notifications::show_action_notification,
            desktop_task::read_clipboard,
            desktop_task::write_clipboard,
            desktop_task::take_screenshot,
            input_control::mouse_click,
            input_control::mouse_drag_path,
            input_control::press_key,
            window_control::focus_app,
            window_control::ensure_focused_app,
            window_control::close_app,
            window_control::get_foreground_app,
            window_control::get_self_pid,
            window_control::move_window,
            window_control::resize_window,
            window_control::minimize_window,
            window_control::maximize_window,
            window_registry::list_visible_windows,
            window_registry::find_windows_by_pid,
            window_registry::list_running_apps,
            lsp::lsp_start,
            lsp::lsp_request,
            lsp::lsp_notify,
            lsp::lsp_stop,
            lsp_install::lsp_installer_list,
            lsp_install::lsp_installer_install,
            lsp_install::lsp_installer_uninstall,
            mcp::mcp_connect,
            mcp::gmail_install_oauth_keys,
            mcp::gmail_is_authenticated,
            mcp::gmail_authenticate,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            mcp::mcp_list_resources,
            mcp::mcp_read_resource,
            mcp::mcp_list_prompts,
            mcp::mcp_disconnect,
            mcp::mcp_is_connected,
            oauth::oauth_exchange_code,
            oauth::oauth_refresh_token,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            keychain::keychain_get_many,
            watcher::watch_project,
            watcher::unwatch_project,
        ]);
    logging::ok("invoke_handler: command handlers registered");

    logging::checkpoint("tauri: build()");
    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => {
            logging::ok("tauri: build() succeeded");
            app
        }
        Err(e) => {
            // Preserve the original behavior (the app cannot run if the
            // Tauri runtime itself fails to build) but log the exact error
            // first instead of letting `.expect()` abort with no record.
            logging::fail("tauri: build()", &e);
            panic!("error while building Tauri application: {e}");
        }
    };

    logging::checkpoint("tauri: run() -- entering event loop / showing window");
    app.run(|_app_handle, event| {
        // Force-stop every still-open terminal's process tree on app
        // exit — mirrors pty_kill's per-pane behaviour (see
        // commands::kill_process_tree) so quitting the whole app
        // doesn't leave a dev server or build watcher an open terminal
        // started running in the background.
        if let tauri::RunEvent::Exit = event {
            commands::kill_all_pty_sessions();
        }
    });
}
