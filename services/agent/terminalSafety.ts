/**
 * OS terminal applications are never valid launch targets. Shell commands must
 * stay inside the embedded terminal, where their process is created without a
 * console window. Keep this predicate shared by every agent app-launch surface.
 */
const TERMINAL_EXECUTABLES = new Set([
  'cmd', 'cmd.exe',
  'powershell', 'powershell.exe',
  'pwsh', 'pwsh.exe',
  'wt', 'wt.exe',
  'conhost', 'conhost.exe',
  'windowsterminal', 'windowsterminal.exe',
])

export const TERMINAL_BLOCK_MESSAGE =
  'Opening an OS-level terminal (Command Prompt, PowerShell, or Windows Terminal) is disabled. ' +
  'Use run_terminal_command to run shell commands in the in-app terminal instead.'

export function isBlockedTerminalTarget(value: string | undefined | null): boolean {
  if (!value) return false
  const normalized = value.trim().replace(/\\/g, '/').toLowerCase()
  const basename = normalized.split('/').pop() ?? normalized
  const stem = basename.replace(/\.(?:lnk|url)$/i, '')

  return TERMINAL_EXECUTABLES.has(stem)
    || /^(?:windows\s*terminal|command\s*prompt)(?:\.exe)?$/i.test(stem)
    || normalized.startsWith('ms-terminal:')
    || normalized.includes('microsoft.windowsterminal_')
}
