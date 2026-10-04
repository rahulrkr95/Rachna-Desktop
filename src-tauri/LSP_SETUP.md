# LSP Server Setup

Rachna AI Studio does not bundle language servers with the application.

Language servers are resolved in this order:

1. Rachna-managed installation
2. System PATH

## Automatic setup

When a project is opened, Rachna Studio detects the languages used by the
project.

If a required language server is not installed, the Language Servers panel
prompts the user to install it.

Servers installed through Rachna Studio are stored under:

<app-data>/lsp-servers/<language>/

They are not stored inside the application installation directory.

## System-installed servers

If a compatible language server already exists on the user's PATH, Rachna
Studio can use it without downloading another copy.

Examples include:

- Python: pyright-langserver
- Go: gopls
- TypeScript/JavaScript: typescript-language-server
- Rust: rust-analyzer
- C/C++: clangd

## Resolution

src-tauri/src/lsp.rs resolves servers using:

Managed installation -> System PATH

If neither is available, the server is considered not installed.

The Language Servers UI can then offer installation when Rachna has an
automatic installer registered for that language.

## Adding another language

To add another language server:

1. Add the language to the LSP installer registry in
   src-tauri/src/lsp_install.rs.
2. Add language detection if it is not already supported.
3. Add the corresponding resolve_server_command handling in
   src-tauri/src/lsp.rs.
4. Define the appropriate automatic installation method or mark it as manual.

Language servers should not be added to lib/lsp-servers.