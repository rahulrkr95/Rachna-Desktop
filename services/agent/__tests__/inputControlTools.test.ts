import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { mouseClickTool, mouseDragPathTool, pressKeyTool, typeLinkInBrowserTool } from '../tools/inputControlTools'
import { recordScreenshot, _resetDesktopInputGuardForTests } from '../desktopInputGuard'
import { DEFAULT_MOUSE_POSITION_TOLERANCE_PX } from '../../../store/useMousePositionToleranceStore'
import type { ToolContext } from '../types'

const ctx: ToolContext = { projectRoot: null }

describe('input control tools — required focus recovery', () => {
  beforeEach(() => {
    invoke.mockReset()
    _resetDesktopInputGuardForTests()
    recordScreenshot()
  })

  it('always (re)focuses the required app before clicking, not just when a pre-check fails', async () => {
    invoke.mockImplementation(async () => undefined)

    const result = await mouseClickTool.execute({ x: 10, y: 20, button: 'left', requiredPid: 20244 }, ctx)

    expect(result.ok).toBe(true)
    // Focus happens unconditionally right before the click — approving the
    // permission dialog itself would have refocused the Rachna IDE window,
    // so there's no "check first, only focus if the check failed" step.
    expect(invoke).toHaveBeenNthCalledWith(1, 'focus_app', { pid: 20244, appName: undefined })
    expect(invoke).toHaveBeenNthCalledWith(2, 'mouse_click', {
      x: 10,
      y: 20,
      button: 'left',
      double: false,
      requiredPid: 20244,
      requiredAppName: undefined,
      tolerancePx: DEFAULT_MOUSE_POSITION_TOLERANCE_PX,
    })
  })

  it('re-focuses and retries once when native key input loses focus at execution time', async () => {
    invoke.mockImplementationOnce(async () => undefined) // focus_app (proactive, before press_key)
    invoke.mockImplementationOnce(async () => {
      throw new Error('Required window is not focused. Expected pid 20244, but foreground pid is 23024.')
    }) // press_key (fails)
    invoke.mockImplementationOnce(async () => 20244) // focus_app (reactive retry)
    invoke.mockImplementationOnce(async () => undefined) // press_key retry (succeeds)

    const result = await pressKeyTool.execute({ keys: ['enter'], requiredPid: 20244 }, ctx)

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenNthCalledWith(1, 'focus_app', { pid: 20244, appName: undefined })
    expect(invoke).toHaveBeenNthCalledWith(3, 'focus_app', { pid: 20244, appName: undefined })
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it('falls back to the screenshot-remembered target when requiredPid/requiredAppName are omitted', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'get_foreground_app') return { pid: 555, name: 'notepad.exe' }
      return undefined
    })

    // Simulate take_screenshot having recorded the foreground app as the target.
    recordScreenshot({ pid: 555, appName: 'notepad.exe' })

    const result = await mouseClickTool.execute({ x: 5, y: 5, button: 'left' }, ctx)

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('focus_app', { pid: 555, appName: 'notepad.exe' })
    expect(invoke).toHaveBeenCalledWith(
      'mouse_click',
      expect.objectContaining({ requiredPid: 555, requiredAppName: 'notepad.exe' })
    )
  })
})

describe('press_key — per-step sequence approval', () => {
  beforeEach(() => {
    invoke.mockReset()
    _resetDesktopInputGuardForTests()
    recordScreenshot()
  })

  it('requests a separate approval for every chord in a sequence, not just the first', async () => {
    invoke.mockImplementation(async () => undefined)
    const approvals: string[] = []
    const approvingCtx: ToolContext = {
      projectRoot: null,
      requestTerminalPermission: async (command: string) => {
        approvals.push(command)
        return 'approve'
      },
    }

    const result = await pressKeyTool.execute(
      { sequence: [['down'], ['down'], ['enter']] },
      approvingCtx
    )

    expect(result.ok).toBe(true)
    expect(approvals).toHaveLength(3)
    expect(approvals[0]).toContain('step 1 of 3')
    expect(approvals[1]).toContain('step 2 of 3')
    expect(approvals[2]).toContain('step 3 of 3')

    const pressKeyCalls = invoke.mock.calls.filter(([command]) => command === 'press_key')
    expect(pressKeyCalls).toHaveLength(3)
  })

  it('stops the sequence when a later step is denied, without silently continuing', async () => {
    invoke.mockImplementation(async () => undefined)
    let calls = 0
    const denyingCtx: ToolContext = {
      projectRoot: null,
      requestTerminalPermission: async () => {
        calls += 1
        return calls === 2 ? 'deny' : 'approve'
      },
    }

    const result = await pressKeyTool.execute(
      { sequence: [['down'], ['down'], ['enter']] },
      denyingCtx
    )

    expect(result.ok).toBe(false)
    const pressKeyCalls = invoke.mock.calls.filter(([command]) => command === 'press_key')
    // Only the first (approved) step should have actually run.
    expect(pressKeyCalls).toHaveLength(1)
  })
})

describe('type_link_in_browser', () => {
  beforeEach(() => {
    invoke.mockReset()
    _resetDesktopInputGuardForTests()
    recordScreenshot()
  })

  it('types the URL verbatim with one appended space and never presses Enter', async () => {
    invoke.mockImplementation(async () => undefined)

    const result = await typeLinkInBrowserTool.execute({ url: 'chatgpt.com/path?q=a%20b' }, ctx)

    expect(result).toMatchObject({ ok: true, data: { text: 'chatgpt.com/path?q=a%20b ' } })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('press_key', {
      text: 'chatgpt.com/path?q=a%20b ',
      requiredPid: undefined,
      requiredAppName: undefined,
    })
  })

  it('rejects an empty URL instead of typing', async () => {
    const result = await typeLinkInBrowserTool.execute({ url: '' }, ctx)

    expect(result.ok).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('mouse-position verification (local, deterministic — see input_control.rs)', () => {
  beforeEach(() => {
    invoke.mockReset()
    _resetDesktopInputGuardForTests()
    recordScreenshot()
  })

  it('sends the configured tolerance so the native side can move-then-verify before clicking', async () => {
    invoke.mockImplementation(async () => undefined)

    const result = await mouseClickTool.execute({ x: 100, y: 200, button: 'left' }, ctx)

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      'mouse_click',
      expect.objectContaining({ x: 100, y: 200, tolerancePx: DEFAULT_MOUSE_POSITION_TOLERANCE_PX })
    )
  })

  it('sends the configured tolerance for mouse_drag_path (verified at the drag start point)', async () => {
    invoke.mockImplementation(async () => ({ steps: 3, start: [0, 0], end: [10, 10] }))

    const result = await mouseDragPathTool.execute(
      { xEquation: 't', yEquation: 't', tMin: 0, tMax: 10, steps: 3 },
      ctx
    )

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      'mouse_drag_path',
      expect.objectContaining({ tolerancePx: DEFAULT_MOUSE_POSITION_TOLERANCE_PX })
    )
  })

  it('surfaces a clear action failure — not a click — when native position verification fails', async () => {
    // Simulates the Rust move_and_verify_position command giving up after
    // its retry budget and returning an error instead of clicking.
    invoke.mockRejectedValue(
      new Error(
        'Cursor position verification failed after 4 attempt(s): requested (100, 200) but the ' +
          'OS reports the cursor at (140, 200) (tolerance 3px). Refusing to click/drag without ' +
          'a verified cursor position.'
      )
    )

    const result = await mouseClickTool.execute({ x: 100, y: 200, button: 'left' }, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Cursor position verification failed')
      expect(result.error).toContain('Refusing to click/drag without a verified cursor position')
    }
  })
})
