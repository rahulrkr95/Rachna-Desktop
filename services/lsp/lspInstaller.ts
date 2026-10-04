// services/lsp/lspInstaller.ts
//
// Thin wrapper around the lsp_installer_* Tauri commands (see
// src-tauri/src/lsp_install.rs). Used by components/LspSetupPanel.tsx.
//
// Status meanings (mirrors LspServerInfo in lsp_install.rs):
//   "bundled"       — shipped inside the app itself (only 5 languages have
//                     this possibility right now: python/go/typescript/
//                     rust/cpp)
//   "managed"       — downloaded by this panel, into the app's data dir
//   "path"          — found on the system PATH (user installed it some
//                     other way, e.g. a global npm/go/cargo install)
//   "not_installed" — nothing found anywhere

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface LspServerInfo {
  id: string
  label: string
  lsp_label: string
  relevant: boolean
  status: 'managed' | 'path' | 'not_installed'
  location: string | null
  version: string | null
  install_method: 'npm' | 'go' | 'cargo' | 'dotnet' | 'github-release' | 'manual'
  official_url: string
  can_uninstall: boolean
}

export async function listLspServers(projectRoot: string | null): Promise<LspServerInfo[]> {
  return invoke<LspServerInfo[]>('lsp_installer_list', { projectRoot })
}

export async function installLspServer(language: string): Promise<string> {
  return invoke<string>('lsp_installer_install', { language })
}

export async function uninstallLspServer(language: string): Promise<void> {
  return invoke<void>('lsp_installer_uninstall', { language })
}

/** Streams install progress lines for one language (npm/go/cargo/dotnet
 *  output, download progress messages, and the final ✓/✗ summary line). */
export function onLspInstallLog(language: string, handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<{ message: string }>(`lsp-install-log-${language}`, ({ payload }) => handler(payload.message))
}
