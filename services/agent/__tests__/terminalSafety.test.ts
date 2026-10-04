import { describe, expect, it } from 'vitest'
import { isBlockedTerminalTarget } from '../terminalSafety'

describe('isBlockedTerminalTarget', () => {
  it.each([
    'cmd.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'Windows Terminal',
    'Windows Terminal.lnk',
    'ms-terminal://new-tab',
    'shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
  ])('blocks OS terminal launch target %s', (target) => {
    expect(isBlockedTerminalTarget(target)).toBe(true)
  })

  it.each(['terminal-notes.txt', 'my-terminal-app.exe', 'C:\\work\\terminal\\report.pdf']) (
    'does not block an unrelated file or application %s',
    (target) => expect(isBlockedTerminalTarget(target)).toBe(false),
  )
})
