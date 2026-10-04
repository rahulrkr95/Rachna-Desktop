// src-tauri/src/action_notifications.rs
//
// OS notifications with real, clickable action buttons (e.g. Accept /
// Reject) — for permission prompts fired while the user isn't looking at
// the app. See services/notify.ts's `nudgeWithActions()` and
// store/useTerminalPermissionStore.ts, which is currently the only caller
// (the terminal/desktop-control permission dialog).
//
// Why this isn't just `show_notification` (desktop_task.rs):
//   `show_notification` goes through tauri-plugin-notification, which only
//   supports registering interactive action types on *mobile* — see its
//   mobile.rs; there's no desktop equivalent, which is why notify.ts used
//   to fall back to appending "(Approve / Reject)" as plain text in the
//   body. Windows toast notifications themselves DO support real action
//   buttons, so on Windows this bypasses the plugin and talks to the
//   WinRT toast API directly via `tauri-winrt-notification` — already
//   pulled in transitively by tauri-plugin-notification's `notify-rust`
//   dependency on Windows; declared as a direct dependency in Cargo.toml
//   so we can use its `add_button()` / `on_activated()` API.
//
// How a button click gets back to the frontend:
//   `Toast::on_activated` registers a callback directly on the specific
//   `ToastNotification` COM object this command creates and shows. As long
//   as the app process is still running when the user clicks a button —
//   the only case that matters here, since these notifications only exist
//   while the app (and the pending permission request they describe) are
//   both still alive — Windows fires that callback straight to this
//   object, with no background/COM-activator registration needed. The
//   callback re-emits the clicked button's label as a `notification-
//   action` Tauri event, which `initPermissionNotificationActions()` in
//   store/useTerminalPermissionStore.ts listens for and turns into a
//   normal `approve()` / `deny()` call — the exact same path the in-app
//   modal's own buttons use, so a click on either resolves the same
//   pending request (and the other one, if clicked afterwards, is just a
//   harmless no-op against an already-resolved request).
//
// Non-Windows: falls back to the old plain-text-body notification (no real
// buttons — same as before this file existed).

use tauri::AppHandle;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub async fn show_action_notification(
    app: AppHandle,
    title: String,
    body: String,
    actions: Vec<String>,
) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        win::show(app, title, body, actions)
    }
    #[cfg(not(target_os = "windows"))]
    {
        fallback::show(app, title, body, actions)
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::CmdResult;
    use tauri::{AppHandle, Emitter};
    use tauri_winrt_notification::Toast;

    pub fn show(app: AppHandle, title: String, body: String, actions: Vec<String>) -> CmdResult<()> {
        let app_id = app.config().identifier.clone();

        let mut toast = Toast::new(&app_id).title(&title).text1(&body);

        // Each button's `action` argument is just its own label — the
        // simplest possible payload, and all the frontend needs to map
        // the click straight to approve()/deny().
        for action in &actions {
            toast = toast.add_button(action, action);
        }

        toast = toast.on_activated(move |clicked_action| {
            if let Some(clicked_action) = clicked_action {
                let _ = app.emit("notification-action", clicked_action);
            }
            Ok(())
        });

        toast
            .show()
            .map_err(|e| format!("Failed to show notification: {e}"))
    }
}

#[cfg(not(target_os = "windows"))]
mod fallback {
    use super::CmdResult;
    use tauri::AppHandle;
    use tauri_plugin_notification::NotificationExt;

    pub fn show(app: AppHandle, title: String, body: String, actions: Vec<String>) -> CmdResult<()> {
        let full_body = if actions.is_empty() {
            body
        } else {
            format!("{body} ({})", actions.join(" / "))
        };

        app.notification()
            .builder()
            .title(title)
            .body(full_body)
            .show()
            .map_err(|e| format!("Failed to show notification: {e}"))
    }
}
