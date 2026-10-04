// src-tauri/src/keychain.rs
//
// Secure storage for provider API keys using the OS-native credential store
// (Keychain on macOS, Credential Manager on Windows, Secret Service /
// libsecret on Linux) via the `keyring` crate.
//
// Previously, raw API key values were persisted in plaintext inside the
// renderer's `localStorage`, which is readable by anyone with devtools
// access (or by reading the app's local storage file directly on disk).
// That made every BYOK key trivially exfiltratable. Now only non-sensitive
// metadata (label, providerId, which key is active, etc.) lives in
// localStorage — the actual secret value is written to/read from the OS
// keychain through these commands, keyed by a stable per-key id.

const SERVICE: &str = "com.rachnaai.ide";

type CmdResult<T> = Result<T, String>;

fn entry_for(id: &str) -> CmdResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

/// Store (or overwrite) a secret value under the OS keychain, addressed by `id`.
#[tauri::command]
pub fn keychain_set(id: String, value: String) -> CmdResult<()> {
    entry_for(&id)?.set_password(&value).map_err(|e| e.to_string())
}

/// Retrieve a previously stored secret. Returns `Ok(None)` if nothing is
/// stored yet for this id (rather than an error), so callers can treat a
/// missing key as "not configured" instead of a hard failure.
#[tauri::command]
pub fn keychain_get(id: String) -> CmdResult<Option<String>> {
    match entry_for(&id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret from the OS keychain. Treated as a no-op (success) if it
/// was already absent.
#[tauri::command]
pub fn keychain_delete(id: String) -> CmdResult<()> {
    match entry_for(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Bulk fetch: given a list of ids, return a map of id -> secret for every
/// id that actually has a stored value. Missing ids are silently skipped.
/// Used on app startup to hydrate in-memory key values without making the
/// renderer issue one invoke() per stored key.
#[tauri::command]
pub fn keychain_get_many(ids: Vec<String>) -> CmdResult<std::collections::HashMap<String, String>> {
    let mut out = std::collections::HashMap::new();
    for id in ids {
        if let Ok(entry) = entry_for(&id) {
            if let Ok(value) = entry.get_password() {
                out.insert(id, value);
            }
        }
    }
    Ok(out)
}
