// lib/systemInfo.ts
//
// Detects the host operating system and shell so the agent can generate
// OS/shell-appropriate terminal commands (e.g. `Get-ChildItem` on
// PowerShell vs `ls` on Bash/Zsh).
//
// Primary source: the Tauri `get_system_info` command (src-tauri/src/commands.rs),
// which inspects the real host OS/shell. Falls back to a best-effort browser
// detection when running outside Tauri (e.g. `vite dev` in a plain browser tab).
//
// The result is cached for the lifetime of the session — OS/shell don't
// change mid-session, and re-detecting on every chat turn would be wasteful.

import { invoke } from '@tauri-apps/api/core'
import type { DetectedOS, DetectedShell, SystemInfo } from '../services/agent/types'

// ── Tauri IPC payload shape (snake_case, matches commands::SystemInfoResult) ──
interface RawSystemInfo {
  os: string
  os_label: string
  shell: string
  shell_label: string
}

const KNOWN_OS: readonly DetectedOS[] = ['windows', 'linux', 'macos']
const KNOWN_SHELLS: readonly DetectedShell[] = ['powershell', 'cmd', 'bash', 'zsh', 'sh']

const FALLBACK: SystemInfo = {
  os: 'unknown',
  osLabel: 'Unknown OS',
  shell: 'unknown',
  shellLabel: 'Unknown shell',
}

let cached: SystemInfo | null = null
let pending: Promise<SystemInfo> | null = null

/**
 * Returns the detected OS + shell for this session, caching the result.
 * Never throws — falls back to browser-based heuristics, then to FALLBACK.
 */
export async function getSystemInfo(): Promise<SystemInfo> {
  if (cached) return cached
  if (pending) return pending

  pending = (async () => {
    try {
      const raw = await invoke<RawSystemInfo>('get_system_info')
      cached = normalize(raw)
    } catch {
      // Not running under Tauri (e.g. `vite dev` in a browser tab), or the
      // command failed — fall back to browser-based detection.
      cached = detectFromBrowser()
    } finally {
      pending = null
    }
    return cached
  })()

  return pending
}

function normalize(raw: RawSystemInfo): SystemInfo {
  const os = (KNOWN_OS as readonly string[]).includes(raw.os) ? (raw.os as DetectedOS) : 'unknown'
  const shell = (KNOWN_SHELLS as readonly string[]).includes(raw.shell)
    ? (raw.shell as DetectedShell)
    : 'unknown'

  return {
    os,
    osLabel: raw.os_label || raw.os || FALLBACK.osLabel,
    shell,
    shellLabel: raw.shell_label || raw.shell || FALLBACK.shellLabel,
  }
}

/** Best-effort detection when the Tauri backend is unavailable. */
function detectFromBrowser(): SystemInfo {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const platform: string =
    (nav as unknown as { userAgentData?: { platform?: string } })?.userAgentData?.platform ||
    nav?.platform ||
    nav?.userAgent ||
    ''

  if (/win/i.test(platform)) {
    return { os: 'windows', osLabel: 'Windows', shell: 'powershell', shellLabel: 'PowerShell' }
  }
  if (/mac/i.test(platform)) {
    return { os: 'macos', osLabel: 'macOS', shell: 'zsh', shellLabel: 'Zsh' }
  }
  if (/linux/i.test(platform)) {
    return { os: 'linux', osLabel: 'Linux', shell: 'bash', shellLabel: 'Bash' }
  }
  return FALLBACK
}
