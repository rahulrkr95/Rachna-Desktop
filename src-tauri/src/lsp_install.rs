// src-tauri/src/lsp_install.rs
//
// In-IDE downloader for LSP servers ("Language Servers" panel), surfaced as
// the natural next step after a project opens and its languages are
// detected (see commands::detect_project_languages, already used by
// doctor_check) — Doctor tells you the runtime toolchain is missing, this
// panel gets you the matching language server without leaving the app.
//
// ── Where installs go ────────────────────────────────────────────────────
// LSP servers are not bundled with the application.
//
// Everything downloaded from the in-app Language Servers panel is stored at:
//
//   <app-data-dir>/lsp-servers/<id>/
//
// `lsp.rs` resolves servers from this managed directory first, then falls
// back to a compatible server installed on the system PATH. This keeps LSP
// binaries out of the application bundle and downloads only the servers
// needed by the user's projects.

// ── Adding another language ───────────────────────────────────────────────
// Every entry in REGISTRY is a plain data row: an id (must match the
// `language` string lsp.rs's resolve_server_command matches on), an install
// method, and an official-site URL for the cases this module can't (or
// deliberately doesn't) automate. Adding support for a new LSP is adding
// one row here — not new install code — as long as it fits one of the
// four generic methods below (Npm / GoInstall / CargoInstall / DotnetTool).
// Only genuinely different distribution shapes (single prebuilt binary in
// a GitHub release, one per platform) need their own function, and there
// are only two of those so far: rust-analyzer and clangd.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use reqwest::header;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::{
    self, local_data_dir, run_version_command, which_found, ProjectLanguages,
};
use crate::process_ext::NoWindow;
use crate::process_utils::managed_node_bin;

type CmdResult<T> = Result<T, String>;

// ── Install methods ──────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum InstallMethod {
    /// `npm install <packages>` inside the managed dir, using the same
    /// managed Node.js runtime the IDE itself depends on. Covers most
    /// LSPs — they're overwhelmingly distributed as npm packages.
    Npm { packages: &'static [&'static str] },
    /// `go install <module>` with GOBIN pointed at the managed dir.
    /// Requires `go` on PATH (already required for Go projects).
    GoInstall { module: &'static str },
    /// `cargo install <crate> --root <managed dir>`. Requires `cargo` on
    /// PATH (already required for Rust projects).
    CargoInstall { krate: &'static str, bin: &'static str },
    /// `dotnet tool install --tool-path <managed dir> <package>`.
    /// Requires the .NET SDK on PATH.
    DotnetTool { package: &'static str, bin: &'static str },
    /// Prebuilt single-binary GitHub release, one per (language) — the
    /// asset-naming differs enough between projects that each gets its own
    /// small function rather than trying to force a shared shape.
    GithubReleaseRustAnalyzer,
    GithubReleaseClangd,
    /// No automated installer here (distribution is a native package
    /// manager, an editor-bundled toolchain, or a multi-step setup) — the
    /// panel just shows an "official site" link instead of a Download
    /// button. Still worth a registry row so status/detection show up.
    Manual,
}

struct LangEntry {
    /// Must match the `language` string in lsp.rs's resolve_server_command.
    id: &'static str,
    label: &'static str,
    lsp_label: &'static str,
    official_url: &'static str,
    method: InstallMethod,
    /// Binary name(s) to look for once installed — checked directly in the
    /// managed dir, then in <managed dir>/node_modules/.bin (npm installs
    /// land there), in that order. First match wins.
    bin_names: &'static [&'static str],
    /// Whether ProjectLanguages tracks this precisely. Used to decide
    /// whether doctor_check should surface it (precise relevance only —
    /// see doctor_rows below) versus only the LSP Setup panel (which shows
    /// the full registry regardless, since it's an explicit "browse
    /// language servers" screen, not a silent background check).
    relevance: fn(&ProjectLanguages) -> bool,
}

const REGISTRY: &[LangEntry] = &[
    LangEntry {
        id: "python", label: "Python", lsp_label: "pyright",
        official_url: "https://microsoft.github.io/pyright/#/installation",
        method: InstallMethod::Npm { packages: &["pyright"] },
        bin_names: &["pyright-langserver", "pyright-langserver.cmd"],
        relevance: |l| l.python,
    },
    LangEntry {
        id: "typescript", label: "TypeScript / JavaScript", lsp_label: "typescript-language-server",
        official_url: "https://github.com/typescript-language-server/typescript-language-server",
        method: InstallMethod::Npm { packages: &["typescript-language-server", "typescript"] },
        bin_names: &["typescript-language-server", "typescript-language-server.cmd"],
        relevance: |l| l.js_ts,
    },
    LangEntry {
        id: "go", label: "Go", lsp_label: "gopls",
        official_url: "https://pkg.go.dev/golang.org/x/tools/gopls",
        method: InstallMethod::GoInstall { module: "golang.org/x/tools/gopls@latest" },
        bin_names: &["gopls", "gopls.exe"],
        relevance: |l| l.go,
    },
    LangEntry {
        id: "rust", label: "Rust", lsp_label: "rust-analyzer",
        official_url: "https://rust-analyzer.github.io/manual.html#installation",
        method: InstallMethod::GithubReleaseRustAnalyzer,
        bin_names: &["rust-analyzer", "rust-analyzer.exe"],
        relevance: |l| l.rust,
    },
    LangEntry {
        id: "cpp", label: "C / C++", lsp_label: "clangd",
        official_url: "https://clangd.llvm.org/installation.html",
        method: InstallMethod::GithubReleaseClangd,
        bin_names: &["clangd", "clangd.exe"],
        relevance: |l| l.cpp,
    },
    LangEntry {
        id: "java", label: "Java", lsp_label: "jdtls (Eclipse JDT)",
        official_url: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
        method: InstallMethod::Manual,
        bin_names: &["jdtls", "jdtls.bat"],
        relevance: |l| l.java,
    },
    LangEntry {
        id: "csharp", label: "C#", lsp_label: "csharp-ls",
        official_url: "https://github.com/razzmatazz/csharp-language-server",
        method: InstallMethod::DotnetTool { package: "csharp-ls", bin: "csharp-ls" },
        bin_names: &["csharp-ls", "csharp-ls.exe"],
        relevance: |l| l.csharp,
    },
    LangEntry {
        id: "php", label: "PHP", lsp_label: "intelephense",
        official_url: "https://intelephense.com/",
        method: InstallMethod::Npm { packages: &["intelephense"] },
        bin_names: &["intelephense", "intelephense.cmd"],
        relevance: |l| l.php,
    },
    LangEntry {
        id: "ruby", label: "Ruby", lsp_label: "ruby-lsp",
        official_url: "https://github.com/Shopify/ruby-lsp",
        method: InstallMethod::Manual, // gem install layout varies too much per Ruby version manager to automate safely
        bin_names: &["ruby-lsp", "ruby-lsp.bat"],
        relevance: |l| l.ruby,
    },
    LangEntry {
        id: "dart", label: "Dart / Flutter", lsp_label: "dart analysis_server",
        official_url: "https://dart.dev/get-dart",
        method: InstallMethod::Manual, // bundled with the Dart SDK itself — nothing separate to install
        bin_names: &["dart", "dart.exe"],
        relevance: |l| l.dart,
    },
    LangEntry {
        id: "kotlin", label: "Kotlin", lsp_label: "kotlin-language-server",
        official_url: "https://github.com/fwcd/kotlin-language-server",
        method: InstallMethod::Manual,
        bin_names: &["kotlin-language-server", "kotlin-language-server.bat"],
        relevance: |_| false, // not tracked by ProjectLanguages — panel-only entry
    },
    LangEntry {
        id: "swift", label: "Swift", lsp_label: "sourcekit-lsp",
        official_url: "https://www.swift.org/tools/",
        method: InstallMethod::Manual, // ships with Xcode / the Swift toolchain
        bin_names: &["sourcekit-lsp"],
        relevance: |_| false,
    },
    LangEntry {
        id: "css", label: "CSS / SCSS / Less", lsp_label: "vscode-css-language-server",
        official_url: "https://github.com/hrsh7th/vscode-langservers-extracted",
        method: InstallMethod::Npm { packages: &["vscode-langservers-extracted"] },
        bin_names: &["vscode-css-language-server", "vscode-css-language-server.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "html", label: "HTML", lsp_label: "vscode-html-language-server",
        official_url: "https://github.com/hrsh7th/vscode-langservers-extracted",
        method: InstallMethod::Npm { packages: &["vscode-langservers-extracted"] },
        bin_names: &["vscode-html-language-server", "vscode-html-language-server.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "json", label: "JSON / JSONC", lsp_label: "vscode-json-language-server",
        official_url: "https://github.com/hrsh7th/vscode-langservers-extracted",
        method: InstallMethod::Npm { packages: &["vscode-langservers-extracted"] },
        bin_names: &["vscode-json-language-server", "vscode-json-language-server.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "vue", label: "Vue", lsp_label: "vue-language-server (Volar)",
        official_url: "https://github.com/vuejs/language-tools",
        method: InstallMethod::Npm { packages: &["@vue/language-server"] },
        bin_names: &["vue-language-server", "vue-language-server.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "svelte", label: "Svelte", lsp_label: "svelte-language-server",
        official_url: "https://github.com/sveltejs/language-tools",
        method: InstallMethod::Npm { packages: &["svelte-language-server"] },
        bin_names: &["svelteserver", "svelteserver.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "graphql", label: "GraphQL", lsp_label: "graphql-language-service-cli",
        official_url: "https://github.com/graphql/graphiql/tree/main/packages/graphql-language-service-cli",
        method: InstallMethod::Npm { packages: &["graphql-language-service-cli"] },
        bin_names: &["graphql-lsp", "graphql-lsp.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "yaml", label: "YAML", lsp_label: "yaml-language-server",
        official_url: "https://github.com/redhat-developer/yaml-language-server",
        method: InstallMethod::Npm { packages: &["yaml-language-server"] },
        bin_names: &["yaml-language-server", "yaml-language-server.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "toml", label: "TOML", lsp_label: "taplo",
        official_url: "https://taplo.tamasfe.dev/",
        method: InstallMethod::CargoInstall { krate: "taplo-cli", bin: "taplo" },
        bin_names: &["taplo", "taplo.exe"],
        relevance: |_| false,
    },
    LangEntry {
        id: "bash", label: "Bash / Shell", lsp_label: "bash-language-server",
        official_url: "https://github.com/bash-lsp/bash-language-server",
        method: InstallMethod::Npm { packages: &["bash-language-server"] },
        bin_names: &["bash-language-server", "bash-language-server.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "dockerfile", label: "Dockerfile", lsp_label: "dockerfile-language-server-nodejs",
        official_url: "https://github.com/rcjsuen/dockerfile-language-server-nodejs",
        method: InstallMethod::Npm { packages: &["dockerfile-language-server-nodejs"] },
        bin_names: &["docker-langserver", "docker-langserver.cmd"],
        relevance: |_| false,
    },
    LangEntry {
        id: "sql", label: "SQL", lsp_label: "sqls",
        official_url: "https://github.com/sqls-server/sqls",
        method: InstallMethod::GoInstall { module: "github.com/sqls-server/sqls@latest" },
        bin_names: &["sqls", "sqls.exe"],
        relevance: |_| false,
    },
    LangEntry {
        id: "lua", label: "Lua", lsp_label: "lua-language-server",
        official_url: "https://github.com/LuaLS/lua-language-server",
        method: InstallMethod::Manual, // per-platform archive layout changes often enough to keep this manual
        bin_names: &["lua-language-server", "lua-language-server.exe"],
        relevance: |_| false,
    },
];

fn entry_by_id(id: &str) -> Option<&'static LangEntry> {
    REGISTRY.iter().find(|e| e.id == id)
}

// ── Managed install directory ────────────────────────────────────────────

fn managed_lsp_dir(app: &AppHandle, id: &str) -> CmdResult<PathBuf> {
    Ok(local_data_dir(app)?.join("lsp-servers").join(id))
}

/// Checked first by lsp.rs's resolve_server_command before falling back to
/// the system PATH. Public so lsp.rs can call it directly without duplicating
/// the node_modules/.bin lookup shape.
pub(crate) fn managed_binary_path(app: &AppHandle, id: &str, bin_names: &[&str]) -> Option<PathBuf> {
    let dir = managed_lsp_dir(app, id).ok()?;
    for name in bin_names {
        let direct = dir.join(name);
        if direct.exists() {
            return Some(direct);
        }
        let npm_bin = dir.join("node_modules").join(".bin").join(name);
        if npm_bin.exists() {
            return Some(npm_bin);
        }
    }
    None
}

// ── Status (for both doctor_check and the LSP Setup panel) ──────────────

#[derive(Serialize, Clone)]
pub struct LspServerInfo {
    pub id: String,
    pub label: String,
    pub lsp_label: String,
    /// Whether the currently open project was precisely detected as using
    /// this language (see LangEntry::relevance) — entries the registry
    /// can't precisely detect (most of the "misc" ones) report `false`
    /// here even though they may still be relevant; the panel just won't
    /// badge them as "detected in this project".
    pub relevant: bool,
    pub status: String, // "managed" | "path" | "not_installed"
    pub location: Option<String>,
    pub version: Option<String>,
    pub install_method: String, // "npm" | "go" | "cargo" | "dotnet" | "github-release" | "manual"
    pub official_url: String,
    pub can_uninstall: bool,
}

fn method_label(m: InstallMethod) -> &'static str {
    match m {
        InstallMethod::Npm { .. } => "npm",
        InstallMethod::GoInstall { .. } => "go",
        InstallMethod::CargoInstall { .. } => "cargo",
        InstallMethod::DotnetTool { .. } => "dotnet",
        InstallMethod::GithubReleaseRustAnalyzer | InstallMethod::GithubReleaseClangd => "github-release",
        InstallMethod::Manual => "manual",
    }
}

fn build_info(app: &AppHandle, entry: &LangEntry, relevant: bool) -> LspServerInfo {
    // 1. Managed (downloaded by this module).
    if let Some(path) = managed_binary_path(app, entry.id, entry.bin_names) {
        return LspServerInfo {
            id: entry.id.to_string(), label: entry.label.to_string(), lsp_label: entry.lsp_label.to_string(),
            relevant, status: "managed".to_string(), location: Some(path.display().to_string()),
            version: None, install_method: method_label(entry.method).to_string(),
            official_url: entry.official_url.to_string(), can_uninstall: true,
        };
    }
    // 2. System PATH.
    for name in entry.bin_names {
        if which_found(name) {
            return LspServerInfo {
                id: entry.id.to_string(), label: entry.label.to_string(), lsp_label: entry.lsp_label.to_string(),
                relevant, status: "path".to_string(), location: None,
                version: None, install_method: method_label(entry.method).to_string(),
                official_url: entry.official_url.to_string(), can_uninstall: false,
            };
        }
    }
    LspServerInfo {
        id: entry.id.to_string(), label: entry.label.to_string(), lsp_label: entry.lsp_label.to_string(),
        relevant, status: "not_installed".to_string(), location: None,
        version: None, install_method: method_label(entry.method).to_string(),
        official_url: entry.official_url.to_string(), can_uninstall: false,
    }
}

/// Full registry status, for the LSP Setup panel — shows every language
/// this module knows about, not just the ones ProjectLanguages can detect
/// precisely (see the `relevance: |_| false` rows above).
#[tauri::command]
pub async fn lsp_installer_list(app: AppHandle, project_root: Option<String>) -> CmdResult<Vec<LspServerInfo>> {
    let langs = commands::detect_project_languages(project_root.as_deref());
    Ok(REGISTRY.iter().map(|e| build_info(&app, e, (e.relevance)(&langs))).collect())
}

/// Doctor-panel rows for just the precisely-detected extra languages (java,
/// csharp, php, ruby, dart, cpp) — kept separate from the full registry so
/// doctor_check's silent per-launch check doesn't surface a dozen "misc"
/// entries the panel can't actually tell are relevant to this project.
pub(crate) fn doctor_rows(langs: &ProjectLanguages) -> Vec<commands::DoctorCheckResult> {
    const PRECISE_IDS: &[&str] = &["java", "csharp", "php", "ruby", "dart", "cpp"];
    PRECISE_IDS.iter().filter_map(|id| {
        let entry = entry_by_id(id)?;
        if !(entry.relevance)(langs) {
            return None;
        }
        // doctor_check does not have an AppHandle at this call site, so this
        // lightweight Doctor row checks the system PATH. The Language Servers
        // panel uses build_info() for the full managed-install + PATH status.
        let found_on_path = entry.bin_names.iter().any(|n| which_found(n));
        let (status, detail) = if found_on_path {
            let v = entry.bin_names.iter().find_map(|n| run_version_command(n, &["--version"]));
            ("ok".to_string(), format!("{} found{}", entry.lsp_label, v.map(|v| format!(" — {v}")).unwrap_or_default()))
        } else {
            ("warn".to_string(), format!("{} not found — {} hover / diagnostics unavailable", entry.lsp_label, entry.label))
        };
        let (fix_hint, fix_command) = manual_fix_text(entry);
        Some(commands::DoctorCheckResult {
            id: format!("lsp_{}", entry.id),
            label: format!("{} ({} LSP)", entry.lsp_label, entry.label),
            group: "LSP Servers".to_string(),
            status,
            detail,
            version: None,
            fix_hint: if found_on_path { None } else { fix_hint },
            fix_command: if found_on_path { None } else { fix_command },
        })
    })
    .collect()
}

fn manual_fix_text(entry: &LangEntry) -> (Option<String>, Option<String>) {
    match entry.method {
        InstallMethod::Npm { packages } => {
            let cmd = format!("npm install -g {}", packages.join(" "));
            (Some(cmd.clone()), Some(cmd))
        }
        InstallMethod::GoInstall { module } => {
            let cmd = format!("go install {module}");
            (Some(cmd.clone()), Some(cmd))
        }
        InstallMethod::CargoInstall { krate, .. } => {
            let cmd = format!("cargo install {krate}");
            (Some(cmd.clone()), Some(cmd))
        }
        InstallMethod::DotnetTool { package, .. } => {
            let cmd = format!("dotnet tool install -g {package}");
            (Some(cmd.clone()), Some(cmd))
        }
        InstallMethod::GithubReleaseRustAnalyzer | InstallMethod::GithubReleaseClangd | InstallMethod::Manual => {
            (Some(format!("See {}", entry.official_url)), Some(format!("open {}", entry.official_url)))
        }
    }
}

// ── Install engine ────────────────────────────────────────────────────────

fn emit_log(app: &AppHandle, id: &str, message: impl Into<String>) {
    #[derive(Serialize, Clone)]
    struct Line { message: String }
    let _ = app.emit(&format!("lsp-install-log-{id}"), Line { message: message.into() });
}

#[tauri::command]
pub async fn lsp_installer_install(app: AppHandle, language: String) -> CmdResult<String> {
    let entry = entry_by_id(&language).ok_or_else(|| format!("Unknown language '{language}'"))?;
    if matches!(entry.method, InstallMethod::Manual) {
        return Err(format!(
            "{} isn't auto-installable here — see {}", entry.lsp_label, entry.official_url
        ));
    }
    let dir = managed_lsp_dir(&app, entry.id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    emit_log(&app, entry.id, format!("Installing {} into {}", entry.lsp_label, dir.display()));

    let result = match entry.method {
        InstallMethod::Npm { packages } => install_npm(&app, &dir, entry.id, packages).await,
        InstallMethod::GoInstall { module } => install_go(&app, &dir, entry.id, module).await,
        InstallMethod::CargoInstall { krate, bin } => install_cargo(&app, &dir, entry.id, krate, bin).await,
        InstallMethod::DotnetTool { package, bin } => install_dotnet_tool(&app, &dir, entry.id, package, bin).await,
        InstallMethod::GithubReleaseRustAnalyzer => install_rust_analyzer(&app, &dir, entry.id).await,
        InstallMethod::GithubReleaseClangd => install_clangd(&app, &dir, entry.id).await,
        InstallMethod::Manual => unreachable!("handled above"),
    };

    match &result {
        Ok(msg) => emit_log(&app, entry.id, format!("✓ {msg}")),
        Err(err) => emit_log(&app, entry.id, format!("✗ {err}")),
    }
    result
}

#[tauri::command]
pub async fn lsp_installer_uninstall(app: AppHandle, language: String) -> CmdResult<()> {
    let dir = managed_lsp_dir(&app, &language)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn install_npm(app: &AppHandle, dir: &Path, id: &str, packages: &[&str]) -> CmdResult<String> {
    let npm = managed_node_bin("npm")
        .ok_or("Managed npm not found — restart Rachna AI Studio so it can finish setting up Node.js, then retry")?;
    if !dir.join("package.json").exists() {
        emit_log(app, id, "$ npm init -y");
        let out = Command::new(&npm).arg("init").arg("-y").current_dir(dir).no_window().output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("npm init failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }
    emit_log(app, id, format!("$ npm install {}", packages.join(" ")));
    let out = Command::new(&npm).arg("install").args(packages).current_dir(dir).no_window().output().map_err(|e| e.to_string())?;
    for line in (String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr)).lines() {
        emit_log(app, id, line.to_string());
    }
    if !out.status.success() {
        return Err(format!("npm install failed for {}", packages.join(", ")));
    }
    Ok(format!("Installed {} via npm", packages.join(", ")))
}

async fn install_go(app: &AppHandle, dir: &Path, id: &str, module: &str) -> CmdResult<String> {
    if !which_found("go") {
        return Err("Go is not on PATH — install Go first (Doctor → Languages), then retry".to_string());
    }
    emit_log(app, id, format!("$ GOBIN={} go install {module}", dir.display()));
    let out = Command::new("go").arg("install").arg(module).env("GOBIN", dir).no_window().output().map_err(|e| e.to_string())?;
    for line in (String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr)).lines() {
        emit_log(app, id, line.to_string());
    }
    if !out.status.success() {
        return Err(format!("go install failed for {module}"));
    }
    Ok(format!("Installed via go install {module}"))
}

async fn install_cargo(app: &AppHandle, dir: &Path, id: &str, krate: &str, bin: &str) -> CmdResult<String> {
    if !which_found("cargo") {
        return Err("Rust/Cargo is not on PATH — install Rust first (Doctor → Languages), then retry".to_string());
    }
    emit_log(app, id, format!("$ cargo install {krate} --root {}", dir.display()));
    let out = Command::new("cargo").args(["install", krate, "--root"]).arg(dir).no_window().output().map_err(|e| e.to_string())?;
    for line in (String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr)).lines() {
        emit_log(app, id, line.to_string());
    }
    if !out.status.success() {
        return Err(format!("cargo install failed for {krate}"));
    }
    // `cargo install --root <dir>` places binaries in <dir>/bin/, not <dir>/
    // directly — copy it up so managed_binary_path's flat lookup finds it.
    let bin_name = if cfg!(windows) { format!("{bin}.exe") } else { bin.to_string() };
    let installed = dir.join("bin").join(&bin_name);
    if installed.exists() {
        let _ = fs::copy(&installed, dir.join(&bin_name));
    }
    Ok(format!("Installed {bin} via cargo install"))
}

async fn install_dotnet_tool(app: &AppHandle, dir: &Path, id: &str, package: &str, bin: &str) -> CmdResult<String> {
    if !which_found("dotnet") {
        return Err("The .NET SDK is not on PATH — install it first (Doctor → Languages), then retry".to_string());
    }
    emit_log(app, id, format!("$ dotnet tool install --tool-path {} {package}", dir.display()));
    let out = Command::new("dotnet").args(["tool", "install", "--tool-path"]).arg(dir).arg(package)
        .no_window().output().map_err(|e| e.to_string())?;
    for line in (String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr)).lines() {
        emit_log(app, id, line.to_string());
    }
    if !out.status.success() {
        return Err(format!("dotnet tool install failed for {package}"));
    }
    Ok(format!("Installed {bin} via dotnet tool install"))
}

// ── GitHub release binaries (rust-analyzer, clangd) ──────────────────────

async fn download_bytes(url: &str) -> CmdResult<Vec<u8>> {
    let client = reqwest::Client::new();
    let res = client.get(url).header(header::USER_AGENT, "Rachna-AI-Studio").send().await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Download failed with HTTP {} for {url}", res.status()));
    }
    res.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

fn gunzip_bytes(gz_bytes: &[u8]) -> CmdResult<Vec<u8>> {
    let tmp_path = std::env::temp_dir().join(format!("rachna-lsp-dl-{}.gz", std::process::id()));
    fs::write(&tmp_path, gz_bytes).map_err(|e| e.to_string())?;
    let output = Command::new("gzip").arg("-dc").arg(&tmp_path).no_window().output().map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&tmp_path);
    if !output.status.success() {
        return Err("gzip decompression failed (is `gzip` installed?)".to_string());
    }
    Ok(output.stdout)
}

fn extract_zip_bytes(zip_bytes: &[u8], dest_dir: &Path) -> CmdResult<()> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let tmp_zip = dest_dir.with_extension("ziptmp");
    fs::write(&tmp_zip, zip_bytes).map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("powershell").args(["-NoProfile", "-Command"])
            .arg(format!("Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force", tmp_zip.display(), dest_dir.display()))
            .no_window().status().map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&tmp_zip);
        if !status.success() { return Err("Failed to extract zip archive".to_string()); }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("unzip").arg("-q").arg("-o").arg(&tmp_zip).arg("-d").arg(dest_dir)
            .no_window().status().map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&tmp_zip);
        if !status.success() { return Err("Failed to extract zip archive (is `unzip` installed?)".to_string()); }
    }
    Ok(())
}

fn find_file_recursive(root: &Path, filename: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().and_then(|n| n.to_str()) == Some(filename) {
                return Some(path);
            }
        }
    }
    None
}

fn rust_analyzer_asset_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))] { "rust-analyzer-aarch64-apple-darwin.gz" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))] { "rust-analyzer-x86_64-apple-darwin.gz" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))] { "rust-analyzer-x86_64-unknown-linux-gnu.gz" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))] { "rust-analyzer-aarch64-unknown-linux-gnu.gz" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))] { "rust-analyzer-x86_64-pc-windows-msvc.zip" }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))] { "rust-analyzer-aarch64-pc-windows-msvc.zip" }
}

async fn install_rust_analyzer(app: &AppHandle, dir: &Path, id: &str) -> CmdResult<String> {
    let asset = rust_analyzer_asset_name();
    let url = format!("https://github.com/rust-lang/rust-analyzer/releases/latest/download/{asset}");
    emit_log(app, id, format!("Downloading {url}"));
    let bytes = download_bytes(&url).await?;

    let bin_name = if cfg!(windows) { "rust-analyzer.exe" } else { "rust-analyzer" };
    let target = dir.join(bin_name);

    if asset.ends_with(".gz") {
        let raw = gunzip_bytes(&bytes)?;
        fs::write(&target, raw).map_err(|e| e.to_string())?;
    } else {
        let extract_dir = dir.join("_extract");
        let _ = fs::remove_dir_all(&extract_dir);
        extract_zip_bytes(&bytes, &extract_dir)?;
        let found = find_file_recursive(&extract_dir, bin_name)
            .ok_or("Downloaded rust-analyzer archive did not contain the expected binary")?;
        fs::copy(&found, &target).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&extract_dir);
    }
    #[cfg(unix)]
    { let _ = Command::new("chmod").arg("+x").arg(&target).no_window().status(); }

    Ok(format!("Installed rust-analyzer to {}", target.display()))
}

fn clangd_asset_name() -> &'static str {
    #[cfg(target_os = "macos")] { "clangd-mac.zip" }
    #[cfg(target_os = "windows")] { "clangd-windows.zip" }
    #[cfg(target_os = "linux")] { "clangd-linux.zip" }
}

async fn install_clangd(app: &AppHandle, dir: &Path, id: &str) -> CmdResult<String> {
    let asset = clangd_asset_name();
    let url = format!("https://github.com/clangd/clangd/releases/latest/download/{asset}");
    emit_log(app, id, format!("Downloading {url}"));
    let bytes = download_bytes(&url).await?;

    let extract_dir = dir.join("_extract");
    let _ = fs::remove_dir_all(&extract_dir);
    extract_zip_bytes(&bytes, &extract_dir)?;

    let bin_name = if cfg!(windows) { "clangd.exe" } else { "clangd" };
    let found = find_file_recursive(&extract_dir, bin_name)
        .ok_or_else(|| format!("Downloaded clangd archive did not contain a '{bin_name}' binary"))?;
    let target = dir.join(bin_name);
    fs::copy(&found, &target).map_err(|e| e.to_string())?;
    // The official release zip also bundles ~90MB of clang resource headers
    // (lib/clang/...) alongside the binary — discard everything except the
    // one file we actually need.
    let _ = fs::remove_dir_all(&extract_dir);

    #[cfg(unix)]
    { let _ = Command::new("chmod").arg("+x").arg(&target).no_window().status(); }

    Ok(format!("Installed clangd to {} (headers discarded, binary only)", target.display()))
}
