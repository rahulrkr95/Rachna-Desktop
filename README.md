# Rachna IDE

A local-first desktop coding agent built on Tauri + React + Monaco Editor with BYOK support and a one-time purchase model.

> **Stack:** Tauri 2 · React 18 · TypeScript · Monaco Editor · Rust · SQLite (rusqlite + sqlite-vec)

---

## Table of contents

1. [Windows Setup Guide](#windows-setup-guide) — prerequisites, clone, build, run
2. [Building a release installer](#building-a-release-installer)
3. [Project structure](#project-structure)
4. [Environment and config](#environment-and-config)
5. [Agent architecture](#agent-architecture) — agent loop, verification gate
6. [Intent classification](#intent-classification) — how a message is routed before it reaches the agent
7. [Tool registry & intent-scoped tool calls](#tool-registry--intent-scoped-tool-calls) — every built-in tool, and which intents get which tools
8. [Indexing & search architecture](#indexing--search-architecture)
9. [Troubleshooting](#troubleshooting)

---

# Windows Setup Guide

## Prerequisites

Install these before anything else:

| Tool              | Download                         |
| ----------------- | -------------------------------- |
| Git for Windows   | https://git-scm.com/download/win |
| Node.js 20+ (LTS) | https://nodejs.org               |
| Rust + rustup     | https://rustup.rs                |

After installing Rust, open a new terminal and install the Tauri CLI:

```powershell
cargo install tauri-cli
```

---

## Step 1 — Clone the IDE

`lib/repo-scanner/` is a regular folder inside this repo (own `package.json`/`tsconfig.json`, built independently — see below for why). Nothing special is needed to clone it, it comes down with the rest of the repo:

```powershell
git clone https://github.com/rahulrkr95/Rachna-Desktop.git
cd Rachna-Desktop
```

---

## Step 2 — Build the repo scanner

```powershell
cd lib\repo-scanner
npm install
npm run build
cd ..\..
```

This compiles the TypeScript scanner into `lib/repo-scanner/dist/`. The `prebuild` npm script (see `package.json`) runs these same steps automatically before `npm run build`, so you rarely need to do this by hand outside of first setup.

---

## Step 3 — Install IDE dependencies

```powershell
npm install
```

---

## Step 4 — Run in development mode

```powershell
npm run tauri dev
```

---

## Step 5 — Build for production

```powershell
npm run build
npm run tauri build
```

The installer will be in `src-tauri/target/release/bundle/`.

---

## Day-to-day workflows

### Making changes to the scanner

`lib/repo-scanner` is a normal folder in this repo — edit it and commit like any other part of the IDE:

```powershell
cd lib\repo-scanner
# ... edit files ...
cd ..\..
git add lib\repo-scanner
git commit -m "feat(scanner): ..."
git push
```

### Fresh pull on another machine or after a teammate pushes

```powershell
git pull
cd lib\repo-scanner && npm install && npm run build && cd ..\..
```

---

## Building a release installer

```bash
npm run tauri build
```

This runs the full pipeline:

1. Builds the repo scanner (`lib/repo-scanner/dist/`)
2. Compiles the React frontend (`dist/`)
3. Installs Playwright Chromium
4. Compiles the Rust binary in release mode (optimised, stripped)
5. Bundles everything into installers

Output lives in:

```text
src-tauri/target/release/bundle/
  msi/        →  Rachna AI Studio_version_x64_en-US.msi
dist/
  Rachna AI Studio Setup.exe   (Windows only, built in a separate step — see below)
```

MSI on Windows only. `src-tauri/tauri.windows.conf.json` restricts that platform to the MSI target.

First release build takes ~10 min. Subsequent builds are faster.

### Bundled prerequisite installation (Windows)

The MSI checks for two Windows components before Rachna AI Studio is ever launched, and silently installs whichever is missing:

1. Microsoft Edge WebView2 Runtime
2. Microsoft Visual C++ 2015-2022 Redistributable (x64)

Both are downloaded on the fly from Microsoft's official "evergreen" permalinks, not bundled at build time, so the installer always fetches whatever the current release is. Already-installed components are left untouched. If either component needs installing, a small progress window is shown; if a download or install step fails, the user gets a Retry/Cancel prompt instead of a silent failure. No manual steps are needed beyond the one UAC prompt that any per-machine MSI install already requires.

This is implemented as a WiX custom action, not through Tauri's built-in `webviewInstallMode` (which only covers WebView2, and only for the WiX/NSIS bootstrapper it drives internally). See:

* `src-tauri/tauri.windows.conf.json` — Windows-only config override. Tauri merges this automatically on top of `tauri.conf.json` when building for Windows, leaving macOS/Linux builds untouched. It restricts Windows to the MSI target, turns off Tauri's own WebView2 bootstrapper, and wires in the fragment below.
* `src-tauri/windows/fragments/prereqs.wxs` — WiX fragment that installs the script below alongside the app and runs it once, right after files are copied, before the MSI finishes.
* `src-tauri/windows/prereqs/install-prereqs.ps1` — performs detection, download, installation, progress UI, and retry/cancel handling. Logs to `%TEMP%\RachnaAIStudio-Prereqs.log`.

Both files have extensive comments explaining why they're written the way they are, including avoiding a known Tauri/WiX extension conflict and why the custom action has to run impersonated rather than as LocalSystem so its progress window is actually visible instead of being stuck in a non-interactive session.

**Because MSI/WiX can only be built and tested on Windows, build the MSI and run it on clean Windows 10 and Windows 11 VMs, with both components pre-removed, before shipping.**

The MSI-only restriction only applies on Windows. macOS and Linux still build their normal bundle formats (`dmg`/`app`, `deb`/`appimage`).

### Setup.exe bootstrapper (Windows)

```text
Rachna AI Studio Setup.exe
     │
     ├── Check WebView2         → install if missing
     ├── Check VC++ x64         → install if missing
     └── Run Rachna AI Studio.msi
```

This is a separate, thin NSIS wrapper around the MSI above, not Tauri's built-in `bundle.windows.nsis` target. That target isn't enabled; `tauri.windows.conf.json` restricts Windows to `msi`.

It reuses the same `install-prereqs.ps1` script the MSI's own WiX custom action calls, then runs `msiexec /i` on the MSI. Unlike the MSI, it doesn't register itself in Add/Remove Programs. The MSI remains the single source of truth for install/upgrade/repair/uninstall. `Setup.exe`'s job ends once `msiexec` succeeds.

Running the prereq script twice, once from `Setup.exe` and once again inside the MSI for anyone who deploys the MSI directly via SCCM/Intune/etc., is intentional and harmless. It no-ops immediately if both components are already present.

See `src-tauri/windows/bootstrapper/setup.nsi` and its [README](src-tauri/windows/bootstrapper/README.md) for the script itself, build instructions, and the CI step that produces it automatically.

### npm scripts reference

| Script                  | What it does                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`           | Starts the Vite dev server only (renderer without the Tauri shell).                                                                                                                                                                                        |
| `npm run tauri dev`     | Full dev mode: renderer + Rust backend + native window.                                                                                                                                                                                                    |
| `npm run build`         | Type-checks (`tsc`) then builds the production renderer bundle (`dist/`).                                                                                                                                                                                  |
| `npm run tauri build`   | Full release pipeline: scanner → renderer → Playwright → Rust release build → installers.                                                                                                                                                                  |
| `npm run scanner:build` | Builds `lib/repo-scanner` in isolation (also runs automatically as `prebuild`).                                                                                                                                                                            |
| `npm run browser:setup` | Installs `lib/browser-tool` deps and downloads Playwright's Chromium (used by `browser_check` / `web_task`). Run this once if browser-driven tools error out in dev mode. `npm run tauri dev` does not run the release pipeline's Playwright install step. |
| `npm run preview`       | Serves the built renderer bundle locally (no Tauri shell) for a quick sanity check post-build.                                                                                                                                                             |
| `npm test`              | Runs the Vitest suite.                                                                                                                                                                                                                                     |

---

## Repo scanner

`lib/repo-scanner` is a normal, tracked folder inside this repo. There is no separate repo or submodule to initialize.

It still has its own `package.json`/`tsconfig.json` and is built independently via `npm run scanner:build`, because it has Node-only dependencies (`better-sqlite3`, `ts-morph`, `tree-sitter-wasms`) that shouldn't be bundled into the Vite/renderer build.

---

## Project structure

```text
rachna-ide/
├── App.tsx                        # React root
├── components/                    # UI components
│   ├── AiChat/                    # Chat panel, agent activity, retrieval
│   ├── DiffPanel/                 # Diff viewer
│   ├── Terminal/                  # Embedded terminal
│   ├── viewers/                   # Image, PDF, audio, video, binary viewers
│   └── ...
├── services/
│   ├── agent/                     # Agent loop, tool registry, tools
│   ├── lsp/                       # LSP client, Monaco providers
│   ├── edits/                     # Edit store, serial patch queue
│   ├── git/                       # Git service (simple-git)
│   └── diagnostics/               # Monaco + LSP diagnostics
├── store/                         # Zustand stores
├── lib/
│   ├── repo-scanner/              # Vendored folder, own package.json/tsconfig, built separately
│   ├── browser-tool/              # Playwright browser sidecar
│   ├── lsp-servers/               # Bundled LSP binaries (clangd, etc.)
│   ├── providers/                 # AI provider adapters (Claude, Gemini, etc.)
│   └── ...
├── src-tauri/
│   ├── src/                       # Rust backend
│   │   ├── commands.rs            # Tauri commands
│   │   ├── db.rs                  # SQLite + sqlite-vec
│   │   ├── keychain.rs            # OS-native credential storage
│   │   ├── lsp.rs                 # LSP process management
│   │   ├── watcher.rs             # File system watcher
│   │   └── ...
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── tsconfig.json
```

---

## Environment and config

### Accounts: only Rachna Cloud needs one

The IDE opens straight to the workspace with no sign-in. Your own API keys, local models, MCP, terminal and git all work without a Rachna account. A Rachna account is needed **only** for Rachna Cloud AI; the sign-in dialog (`components/LoginScreen.tsx`) appears the first time you pick Rachna Cloud or send it a message while signed out.

Sign-in supports email/password and "Continue with Google". Google sign-in is optional and only shown when configured. Copy `.env.example` to `.env` and set:

- `VITE_RACHNA_GOOGLE_CLIENT_ID` / `VITE_RACHNA_GOOGLE_CLIENT_SECRET`: a Google OAuth client of type **Desktop app**. Add the same client ID to the backend's `GOOGLE_CLIENT_IDS`, or the backend will reject the token.

The managed Node.js runtime is downloaded from nodejs.org at first launch (version pinned by `MANAGED_NODE_VERSION` in `src-tauri/src/commands.rs`) and needs no account.


All API keys are stored via the OS-native credential store: Windows Credential Manager, macOS Keychain, or libsecret/Secret Service on Linux, through the `keyring` crate (see `src-tauri/src/keychain.rs`).

Nothing is written to `.env` files or disk in plaintext. Only non-sensitive metadata such as label, provider id, and which key is active lives in the renderer's `localStorage`.

Keys are set inside the IDE's Settings panel at runtime using the BYOK model.

Supported providers:

* Anthropic Claude
* OpenAI
* Google Gemini
* DeepSeek
* OpenRouter
* Ollama (local)
* LM Studio (local)
* Zenmux
* Hugging Face (any Hub model id via Inference Providers)
* Sarvam AI

---

## Agent architecture

The agent is a provider-agnostic loop, independent of any single AI vendor's SDK:

```text
User message
     │
     ▼
lib/intentClassifier.ts
     │
     │  Classifies the request before routing.
     ▼
components/AiChat/useChat.ts
     │
     │  Handles dedicated flows and determines
     │  the concrete intent passed to the agent.
     ▼
services/agent/AgentLoop.ts
     │
     ├──▶ ToolRegistry.ts
     │      Resolves tool declarations scoped
     │      to the classified intent/sub-intent.
     │
     ├──▶ ToolExecutor.ts
     │      Executes model tool calls.
     │
     └──▶ verificationGate.ts
            Forces verification after file edits
            before the turn can finalize.
```

Key pieces, all under `services/agent/`:

* **`AgentLoop.ts`** — core provider-agnostic tool-calling loop. Streams the model's response, dispatches tool calls through `ToolExecutor`, feeds results back, and repeats until the model stops calling tools or a cap is reached. Supports cancellation (`opts.signal`) and mid-turn resume (`resumeState`).
* **`ToolRegistry.ts`** — central registry for built-in tools and the intent/sub-intent-specific allowlists that determine which declarations are sent to the model.
* **`ToolExecutor.ts`** — runs tool calls returned by a model turn, parallelizing where safe, creates `AgentActivity` entries for the UI, and normalizes results into `ToolResult`.
* **`verificationGate.ts`** — after file-editing tools (`propose_edit`, `batch_propose_edits`, `create_file`, `rename_file`, `delete_file`) run, forces diagnostics/build/test verification before the agent can finalize unless `skip_verification` is explicitly used.
* **`mcpTools.ts`** — converts MCP connector tools into the same declaration/execution shape as built-in tools so `AgentLoop` doesn't need a separate execution architecture for them.

---

## Intent classification

`lib/intentClassifier.ts` is the main routing classifier.

The current architecture contains **10 top-level routable intents**, with additional sub-intents/categories underneath them.

```text
USER MESSAGE
│
├── DESIGN
│   └── design_project
│
├── CODING
│   │
│   ├── NEW_PROJECT
│   │   └── build_new_project
│   │
│   ├── EDIT_EXISTING
│   │   └── edit_existing
│   │       ├── read_only
│   │       ├── debug
│   │       └── feature
│   │
│   ├── RUN_PROJECT
│   │   └── run_project
│   │
│   └── TERMINAL_TASK
│       └── terminal_task
│
├── DESKTOP_TASK
│   └── desktop_task
│       ├── files
│       ├── apps
│       └── research
│
├── BROWSER_TASK
│   ├── research
│   └── input_control
│
├── MCP_TASK:<service>
│   └── mcp_task
│
└── CHAT
    └── chat
```

### Intent behavior

| Intent                              | Meaning                                                                                             | Routing                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `design_project`                    | Create a visual/aesthetic project such as a site, landing page, portfolio, dashboard, or UI concept | Dedicated design/new-project flow                                                                                                   |
| `build_new_project`                 | Scaffold a brand-new software project                                                               | New-project flow, followed by a scoped coding agent                                                                                 |
| `edit_existing:read_only`           | Inspect, locate, understand, or explain existing code                                               | Read/search-only coding agent                                                                                                       |
| `edit_existing:debug`               | Diagnose and fix a scoped bug/error                                                                 | Debug-oriented coding agent                                                                                                         |
| `edit_existing:feature`             | Implement features, refactors, or broader multi-file changes                                        | Full feature-editing agent                                                                                                          |
| `run_project`                       | Run/start/launch the project                                                                        | Scoped coding agent using terminal, process-monitoring, diagnostics, and browser-check tools                                        |
| `terminal_task`                     | Execute one-off shell/terminal work                                                                 | Terminal-scoped agent                                                                                                               |
| `desktop_task:files`                 | Manage files/folders outside normal project editing                                                 | Implemented using scoped file + desktop-input tools                                                                                 |
| `desktop_task:apps`                  | Launch, focus, close, inspect, or interact with desktop applications                                | Implemented using scoped application + desktop-input tools                                                                          |
| `desktop_task:research`              | Local/system-oriented research deliverable                                                          | Implemented using the research tool set                                                                                              |
| `browser_task:research` | Public-web information lookup without interactive page automation                                   | Research-focused web tools                                                                                                          |
| `browser_task:input_control` | Navigate/click/fill/extract from a public site                                                      | Browser automation tools                                                                                                            |
| `mcp_task`                          | Work through a connected MCP service                                                                | Minimal built-in context tools + dynamically attached MCP tools                                                                     |
| `chat`                              | General conversation requiring no external action                                                   | Direct conversational response                                                                                                      |

### Main intent vs repo retrieval intent

The repository also contains a **second intent system** inside:

```text
lib/repo-scanner/src/repoScanner/intentDetector.ts
```

This is separate from the main chat/agent classifier.

It does **not** decide which agent tools are available. Instead, it adjusts repository retrieval/search weighting.

```text
REPO RETRIEVAL INTENTS
│
├── modify
│   └── Add/change/refactor/rename/remove code.
│
├── bug_fix
│   └── Bugs, crashes, errors, exceptions, failures.
│
├── explain
│   └── Understand or explain how code works.
│
├── find_implementation
│   └── Locate a function/class/definition/implementation.
│
├── architecture
│   └── Understand overall structure/design/data flow.
│
├── frontend
│   └── CSS/UI/layout/component/theme-related requests.
│
└── general
    └── Fallback retrieval intent.
```

The two systems therefore serve different purposes:

```text
User Message
│
├── Main Intent Classifier
│   └── Workflow + agent tool scope
│
└── Repo Scanner Intent Detector
    └── Repository retrieval/search weighting
```

---

## Tool registry & intent-scoped tool calls

All built-in agent tools live under:

```text
services/agent/tools/
```

and are registered centrally in:

```text
services/agent/ToolRegistry.ts
```

The registry currently contains **41 built-in tools**.

`getToolNamesForIntent()` then restricts which declarations are sent to the model according to the classified intent/sub-intent.

This serves two purposes:

1. Reduces unnecessary tool schemas/tokens sent to the model.
2. Prevents the model from reaching for tools unrelated to the current task.

### Built-in tool categories

```text
BUILT-IN TOOLS
│
├── Repository Reading & Search
│   ├── read_file
│   ├── read_lines
│   ├── search_codebase
│   ├── semantic_search_codebase
│   ├── grep_codebase
│   ├── list_directory
│   └── get_repo_overview
│
├── Repository Graph
│   ├── find_dependencies
│   ├── find_dependents
│   ├── trace_import_chain
│   ├── find_component_usage
│   └── find_hook_usage
│
├── Editing
│   ├── propose_edit
│   ├── batch_propose_edits
│   ├── create_file
│   ├── rename_file
│   └── delete_file
│
├── Development & Verification
│   ├── run_terminal_command
│   ├── get_diagnostics
│   ├── browser_check
│   └── skip_verification
│
├── Web & HTTP
│   ├── curl_request
│   ├── web_task
│   ├── web_search
│   ├── search_stackoverflow
│   ├── get_package_changelog
│   └── open_url
│
├── Planning & Version Control
│   ├── manage_todos
│   └── git_action
│
├── Desktop Files
│   ├── open_in_explorer
│   └── open_file
│
├── Desktop Applications
│   ├── open_app
│   ├── focus_app
│   ├── close_app
│   ├── list_running_apps
│   ├── kill_process
│   └── take_screenshot
│
├── Desktop Input
│   ├── mouse_click
│   ├── press_key
│   └── press_key_sequence
│
└── Legacy / General System
    └── desktop_task
```

### Intent-scoped tool sets

#### `build_new_project`

```text
build_new_project
├── create_file
├── run_terminal_command
├── get_diagnostics
├── browser_check
├── manage_todos
├── skip_verification
├── open_in_explorer
└── open_file
```

Used for creating/scaffolding a new project.

---

#### `edit_existing:read_only`

```text
edit_existing:read_only
├── read_file
├── read_lines
├── search_codebase
├── semantic_search_codebase
├── grep_codebase
├── list_directory
├── get_repo_overview
├── find_dependencies
├── find_dependents
├── trace_import_chain
├── find_component_usage
├── find_hook_usage
├── open_in_explorer
└── open_file
```

Read/search/navigation only. No editing tools are exposed.

---

#### `edit_existing:debug`

```text
edit_existing:debug
├── read_file
├── read_lines
├── grep_codebase
├── search_codebase
├── list_directory
├── get_diagnostics
├── propose_edit
├── batch_propose_edits
├── run_terminal_command
├── skip_verification
├── open_in_explorer
└── open_file
```

Designed for focused bug investigation and repair.

---

#### `edit_existing:feature`

```text
edit_existing:feature
├── read_file
├── read_lines
├── grep_codebase
├── search_codebase
├── semantic_search_codebase
├── list_directory
├── get_repo_overview
├── get_diagnostics
├── find_dependencies
├── find_dependents
├── trace_import_chain
├── find_component_usage
├── find_hook_usage
├── propose_edit
├── batch_propose_edits
├── create_file
├── rename_file
├── delete_file
├── run_terminal_command
├── manage_todos
├── git_action
├── skip_verification
├── open_in_explorer
└── open_file
```

The broadest coding scope, intended for features, refactors, and coordinated multi-file changes.

---

#### `run_project`

```text
run_project
├── run_terminal_command
├── browser_check
├── kill_process
├── list_running_apps
└── get_diagnostics
```

Handled through the normal Planner → AgentLoop → Tool pipeline. The Run
Configuration UI remains available for manual user-initiated runs.

---

#### `terminal_task`

```text
terminal_task
├── run_terminal_command
├── curl_request
├── git_action
├── read_file
├── list_directory
└── kill_process
```

Used for focused command-line/system-terminal tasks.

---

#### `desktop_task:files`

```text
desktop_task:files
├── open_in_explorer
├── open_file
├── list_directory
├── read_file
├── create_file
├── rename_file
├── delete_file
├── mouse_click
├── press_key
└── press_key_sequence
```

Implemented.

Provides local file/folder operations plus desktop input when interaction with the file UI is necessary.

---

#### `desktop_task:apps`

```text
desktop_task:apps
├── open_app
├── focus_app
├── close_app
├── list_running_apps
├── kill_process
├── take_screenshot
├── mouse_click
├── press_key
└── press_key_sequence
```

Implemented.

Provides application lifecycle/control, screenshots, and desktop input.

---

#### Other Desktop Task categories

```text
desktop_task
└── research          → Research deliverables
```

Files, apps, and research route to implemented Desktop Task tool sets.

---

#### `browser_task:research`

```text
browser_task:research
├── web_search
├── search_stackoverflow
└── get_package_changelog
```

Used when the task is information retrieval rather than interactive browser automation.

---

#### `browser_task:input_control`

```text
browser_task:input_control
├── web_task
├── browser_check
├── curl_request
└── open_url
```

Used when the model needs to navigate, click, fill, inspect, or extract from a public webpage.

---

#### `mcp_task`

```text
mcp_task
├── read_file
├── list_directory
├── web_search
│
└── + dynamically attached MCP server tools
```

MCP tools are appended separately by `AgentLoop` according to the connected service.

The service can include connectors such as:

```text
github
postgres
sentry
figma
slack
jira
linear
...
```

---

#### `chat`

```text
chat
└── No tools
```

General conversation is answered without exposing agent tools.

---

### Legacy `desktop_task` tool

The registry still contains the older:

```text
desktop_task
```

tool implemented by:

```text
services/agent/tools/desktopTaskTool.ts
```

The newer Desktop Task architecture instead exposes specialized tools such as:

```text
open_app
focus_app
close_app
list_running_apps
kill_process
take_screenshot

open_in_explorer
open_file

mouse_click
press_key
press_key_sequence
```

`desktop_task` is therefore **not included** in either:

```text
DESKTOP_TASK_FILES_TOOL_NAMES
DESKTOP_TASK_APPS_TOOL_NAMES
```

This avoids exposing both the legacy general-purpose system interface and the newer specialized tools for the same scoped Desktop Task flow.

The legacy tool should only be removed from the global registry after confirming there are no remaining callers that depend on it.

---

### Fail-open behavior

If `getToolNamesForIntent()` receives an intent with no explicit mapping, it returns `undefined`.

That means the agent receives the full built-in registry rather than silently losing tools it may need.

Known, intentionally scoped intents should therefore always have an explicit mapping where appropriate.

---

## Indexing & search architecture

Each opened project gets its **own** SQLite database (`chunks`, `symbols`, `chunk_embeddings`/`embeddings_vec` tables), stored at:

```text
{app data dir}/projects/{hash of canonicalized project root}/chunks.db
```

This means opening/scanning/searching one project never grows or slows down another project's index, and closing a project doesn't require cleanup. Its DB remains untouched until the project is reopened.

Chat conversation history and rejected-edit records are **not** project-scoped and continue to live in the original global:

```text
{app data dir}/chunks.db
```

The Gemini/local-embedding JSON vector cache:

```text
~/.rachna-ide/vector-cache/{hash}/vector-index.json
```

used by `semanticSearchManager`, follows the same per-project hashing scheme.

Semantic Ollama embedding is only triggered explicitly from:

```text
Settings → Re-embed repo
```

It is not run on every index.

Running it automatically on every scan previously doubled indexing time for no benefit because the old code re-ran a full repo scan while the Rust backend silently ignored the embedding flags.

If indexing feels slow, check whether re-embedding is being triggered unnecessarily.

---

## Troubleshooting

### `error: linker 'link.exe' not found`

The MSVC build tools are missing or not on PATH.

Re-run the Visual Studio Build Tools installer and make sure **Desktop development with C++** is selected. Then open a new terminal.

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

### `WebView2 is not installed`

This is only relevant when running:

```text
npm run tauri dev
```

on a development machine.

End users installing the shipped MSI have WebView2 handled by the prerequisite installation flow described above.

For a development machine, install the Microsoft Edge WebView2 Evergreen Runtime.

### `lib/repo-scanner/dist/ not found` or bundling error

The scanner wasn't built before running Tauri.

Run:

```bash
npm run scanner:build
```

### `cannot find module '../../lib/repo-scanner/src/...'`

Run `npm install` inside `lib/repo-scanner`, or run:

```bash
npm run scanner:build
```

from the root so its dependencies and `dist/` output exist.

### Doctor panel shows Node.js found but npm/npx missing (Windows)

`npm`/`npx` ship as `.cmd` shim scripts on Windows rather than real `.exe` files.

Rust's `Command::new()` doesn't resolve `.cmd` extensions the same way a shell does, so it can find `node.exe` while failing to find `npm`.

If this appears after updating, confirm `commands.rs`'s `run_version_command`/`which_found` include the Windows `.cmd`/`.exe` fallback checks:

```text
src-tauri/src/commands.rs
```

### Rust compile errors after pulling changes

```bash
cd src-tauri
cargo clean
cd ..
npm run tauri dev
```

### Port 5173 already in use

Another Vite process is running.

Kill it or change the port in:

```text
vite.config.ts
```

and update `devUrl` in:

```text
tauri.conf.json
```

to match.

## License

Rachna Desktop is open source under the [MIT License](LICENSE).
Third-party dependencies retain their respective licenses.
