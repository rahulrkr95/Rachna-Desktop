// src-tauri/src/browser_profiles.rs
//
// Best-effort discovery of a browser's user profiles, backing the
// BrowserPreferenceModal's profile picker (components/AiChat/
// BrowserPreferenceModal.tsx) so the user can pick a profile by its real
// name instead of typing an internal folder name from memory.
//
// Chromium-family browsers (Chrome, Edge, Brave, Vivaldi, Arc) keep a
// top-level "Local State" JSON file in their user-data directory with a
// `profile.info_cache` map of `{ <folder name>: { name: <display name> } }`
// — the same folder name Chromium expects after `--profile-directory=`
// (see openDefaultBrowserTool.ts's launchArgumentsFor, which this module
// does not touch). Reading that file directly avoids needing the browser
// itself to be running.
//
// This is deliberately read-only, best-effort, and silent on failure: any
// missing directory, unreadable file, or unrecognized browser name simply
// resolves to an empty list rather than an error, so the frontend can
// treat "no profiles found" and "discovery unsupported for this browser"
// identically — both fall back to manual profile entry (see
// BrowserPreferenceModal.tsx).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

type CmdResult<T> = Result<T, String>;

#[derive(serde::Serialize, Clone, Debug)]
pub struct BrowserProfileInfo {
    /// The internal folder name (e.g. "Default", "Profile 2") — what
    /// actually gets passed to `--profile-directory=` / `-P` at launch.
    pub id: String,
    /// The user-facing name shown in the browser's own profile switcher
    /// (e.g. "Work", "Personal"). Falls back to `id` when a browser hasn't
    /// set a custom display name for a profile.
    pub name: String,
}

// ── Chromium-family (Chrome, Edge, Brave, Vivaldi, Arc) ─────────────────────

/// Normalizes a free-typed/display browser name (e.g. "Google Chrome",
/// "Microsoft Edge") down to the family key used to locate its user-data
/// directory below. Mirrors the substring-based matching openDefaultBrowserTool.ts
/// already uses for CHROMIUM_BROWSER_NAMES, extended with vivaldi/arc since
/// those are also Chromium-based and keep the same "Local State" layout.
fn chromium_family_key(browser: &str) -> Option<&'static str> {
    let lower = browser.to_lowercase();
    // Order matters only in that "chromium" must be checked before nothing
    // else conflicts with it — each of these is otherwise mutually exclusive.
    if lower.contains("edge") {
        Some("edge")
    } else if lower.contains("brave") {
        Some("brave")
    } else if lower.contains("vivaldi") {
        Some("vivaldi")
    } else if lower.contains("arc") {
        Some("arc")
    } else if lower.contains("chrome") || lower.contains("chromium") {
        Some("chrome")
    } else {
        None
    }
}

fn chromium_user_data_dir(family: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        let base = PathBuf::from(local);
        let rel: &[&str] = match family {
            "chrome" => &["Google", "Chrome", "User Data"],
            "edge" => &["Microsoft", "Edge", "User Data"],
            "brave" => &["BraveSoftware", "Brave-Browser", "User Data"],
            "vivaldi" => &["Vivaldi", "User Data"],
            "arc" => &["Arc", "User Data"],
            _ => return None,
        };
        Some(rel.iter().fold(base, |acc, part| acc.join(part)))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        let base = PathBuf::from(home).join("Library").join("Application Support");
        let rel: &[&str] = match family {
            "chrome" => &["Google", "Chrome"],
            "edge" => &["Microsoft Edge"],
            "brave" => &["BraveSoftware", "Brave-Browser"],
            "vivaldi" => &["Vivaldi"],
            "arc" => &["Arc", "User Data"],
            _ => return None,
        };
        Some(rel.iter().fold(base, |acc, part| acc.join(part)))
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").ok()?;
        let base = PathBuf::from(home).join(".config");
        let rel: &[&str] = match family {
            "chrome" => &["google-chrome"],
            "edge" => &["microsoft-edge"],
            "brave" => &["BraveSoftware", "Brave-Browser"],
            "vivaldi" => &["vivaldi"],
            // Arc is not available on Linux — falls through to "unsupported".
            _ => return None,
        };
        Some(rel.iter().fold(base, |acc, part| acc.join(part)))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = family;
        None
    }
}

#[derive(serde::Deserialize)]
struct LocalStateProfileEntry {
    #[serde(default)]
    name: Option<String>,
}

#[derive(serde::Deserialize)]
struct LocalStateProfile {
    #[serde(default)]
    info_cache: HashMap<String, LocalStateProfileEntry>,
}

#[derive(serde::Deserialize)]
struct LocalState {
    profile: Option<LocalStateProfile>,
}

fn read_chromium_profiles(user_data_dir: &Path) -> Vec<BrowserProfileInfo> {
    let local_state_path = user_data_dir.join("Local State");
    let Ok(content) = std::fs::read_to_string(&local_state_path) else {
        return vec![];
    };
    let Ok(parsed) = serde_json::from_str::<LocalState>(&content) else {
        return vec![];
    };
    let Some(profile) = parsed.profile else {
        return vec![];
    };

    let mut profiles: Vec<BrowserProfileInfo> = profile
        .info_cache
        .into_iter()
        .map(|(folder, entry)| {
            let name = entry
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| folder.clone());
            BrowserProfileInfo { id: folder, name }
        })
        .collect();

    // "Default" first (it's what most users actually use day to day), then
    // alphabetical by display name for everything else.
    profiles.sort_by(|a, b| match (a.id == "Default", b.id == "Default") {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    profiles
}

// ── Public entry point ───────────────────────────────────────────────────────

/// Best-effort profile discovery for the given browser (matched loosely
/// against its display name, e.g. "Google Chrome", "Brave"). Always
/// resolves — never returns Err — since "nothing found" and "this browser
/// isn't recognized" are both handled the same way by the frontend: fall
/// back to manual profile entry. Firefox and any browser whose profile
/// layout isn't recognized simply resolve to an empty list.
#[tauri::command]
pub async fn list_browser_profiles(browser: String) -> CmdResult<Vec<BrowserProfileInfo>> {
    let trimmed = browser.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    let profiles = match chromium_family_key(trimmed) {
        Some(family) => match chromium_user_data_dir(family) {
            Some(dir) => read_chromium_profiles(&dir),
            None => vec![],
        },
        None => vec![],
    };

    Ok(profiles)
}
