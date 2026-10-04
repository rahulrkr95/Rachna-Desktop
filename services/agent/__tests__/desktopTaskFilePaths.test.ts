// services/agent/__tests__/desktopTaskFilePaths.test.ts
//
// Regression coverage for the DESKTOP_TASK:files filesystem fixes:
//   1. create_file must work with NO project open, for both an absolute OS
//      path and a home-relative path like "Desktop\...\test.txt".
//   2. open_file must resolve the same kinds of paths (including ones with
//      spaces) instead of handing a bare relative string straight to the OS.
// Both must continue to behave exactly as before for ordinary project
// turns (ctx.allowExternalPaths absent/false).

import './_localStoragePolyfill'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { homeDir } = vi.hoisted(() => ({ homeDir: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir }))

import { resolveSystemPath, resolveWorkspacePath } from '../pathUtils'
import { createFileTool } from '../tools/fileOpTools'
import { openFileTool, openInOsExplorerTool } from '../tools/desktopControlTools'
import { useEditStore } from '../../edits/EditStore'
import type { ToolContext } from '../types'

const WIN_HOME = 'C:\\Users\\Rahul'

describe('resolveSystemPath', () => {
  beforeEach(() => {
    homeDir.mockReset()
    homeDir.mockResolvedValue(WIN_HOME)
  })

  it('uses an absolute path as-is regardless of project state', async () => {
    const result = await resolveSystemPath('C:\\Users\\Rahul\\Desktop\\test.txt', null)
    expect(result).toEqual({ ok: true, path: 'C:\\Users\\Rahul\\Desktop\\test.txt' })
  })

  it('falls back to the OS home directory for a relative path with no project open', async () => {
    const result = await resolveSystemPath('Desktop\\RachnaSystemTest\\test.txt', null)
    expect(result).toEqual({ ok: true, path: 'C:\\Users\\Rahul\\Desktop\\RachnaSystemTest\\test.txt' })
  })

  it('still prefers an open project root over the home-dir fallback', async () => {
    const result = await resolveSystemPath('notes.txt', 'C:\\Projects\\Foo')
    expect(result).toEqual(resolveWorkspacePath('notes.txt', 'C:\\Projects\\Foo'))
  })

  it('rejects an empty path', async () => {
    const result = await resolveSystemPath('   ', null)
    expect(result.ok).toBe(false)
  })
})

describe('create_file — DESKTOP_TASK:files with no project open', () => {
  const sysCtx: ToolContext = { projectRoot: null, allowExternalPaths: true }

  beforeEach(() => {
    invoke.mockReset()
    homeDir.mockReset()
    homeDir.mockResolvedValue(WIN_HOME)
    useEditStore.setState({ edits: [] })
  })

  it('proposes a new file at an absolute Desktop path with no project open', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'path_info') return { exists: false, is_file: false, is_dir: false }
      return undefined
    })

    const result = await createFileTool.execute(
      {
        filePath: 'C:\\Users\\Rahul\\Desktop\\RachnaSystemTest\\test.txt',
        content: 'hello from system task',
        description: 'Create a test file on the Desktop',
      },
      sysCtx
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.filePath).toBe('C:\\Users\\Rahul\\Desktop\\RachnaSystemTest\\test.txt')
    }
  })

  it('proposes a new file at a home-relative Desktop path with no project open', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'path_info') return { exists: false, is_file: false, is_dir: false }
      return undefined
    })

    const result = await createFileTool.execute(
      {
        filePath: 'Desktop\\RachnaSystemTest\\test.txt',
        content: 'hello from system task',
        description: 'Create a test file on the Desktop',
      },
      sysCtx
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.filePath).toBe('C:\\Users\\Rahul\\Desktop\\RachnaSystemTest\\test.txt')
    }
  })

  it('still requires an open project for a relative path on ordinary coding turns', async () => {
    const codingCtx: ToolContext = { projectRoot: null }
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'path_info') return { exists: false, is_file: false, is_dir: false }
      return undefined
    })

    const result = await createFileTool.execute(
      { filePath: 'src/newFile.ts', content: '', description: 'x' },
      codingCtx
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/no project folder is open/i)
    }
  })
})

describe('open_file / open_in_os_explorer — DESKTOP_TASK:files with no project open', () => {
  const sysCtx: ToolContext = { projectRoot: null, allowExternalPaths: true }

  beforeEach(() => {
    invoke.mockReset()
    homeDir.mockReset()
    homeDir.mockResolvedValue(WIN_HOME)
  })

  it('resolves and opens an absolute Desktop path', async () => {
    invoke.mockImplementation(async () => undefined)

    const result = await openFileTool.execute(
      { path: 'C:\\Users\\Rahul\\Desktop\\RachnaSystemTest\\test.txt' },
      sysCtx
    )

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_path', {
      path: 'C:\\Users\\Rahul\\Desktop\\RachnaSystemTest\\test.txt',
    })
  })

  it('resolves a home-relative Desktop path (with spaces) instead of passing it straight through', async () => {
    invoke.mockImplementation(async () => undefined)

    const result = await openFileTool.execute(
      { path: 'Desktop\\Rachna System Test\\test file.txt' },
      sysCtx
    )

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_path', {
      path: 'C:\\Users\\Rahul\\Desktop\\Rachna System Test\\test file.txt',
    })
  })

  it('reveals a home-relative Desktop path in Explorer', async () => {
    invoke.mockImplementation(async () => undefined)

    const result = await openInOsExplorerTool.execute(
      { path: 'Desktop\\RachnaSystemTest' },
      sysCtx
    )

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('reveal_in_explorer', {
      path: 'C:\\Users\\Rahul\\Desktop\\RachnaSystemTest',
    })
  })

  it('falls back to the raw path on ordinary coding turns (unchanged legacy behavior)', async () => {
    invoke.mockImplementation(async () => undefined)
    const codingCtx: ToolContext = { projectRoot: null }

    const result = await openFileTool.execute({ path: 'Desktop\\test.txt' }, codingCtx)

    expect(result.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_path', { path: 'Desktop\\test.txt' })
  })
})
