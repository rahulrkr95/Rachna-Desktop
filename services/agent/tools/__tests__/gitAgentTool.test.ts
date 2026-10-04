// services/agent/tools/__tests__/gitAgentTool.test.ts
//
// Unit tests for the git_action agent tool.
// The Tauri `invoke` calls inside gitService.ts are mocked so these tests run
// in plain Node/vitest — no Tauri runtime needed.
//
// Strategy:
//   - vi.mock('@tauri-apps/api/core') stubs every invoke() call
//   - Each test configures the stub's return value for the specific command
//   - Safety rules (push-to-main guard, push-requires-opt-in, empty-staged guard)
//     are tested by injecting a ToolContext with the relevant GitToolSettings

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext, GitToolSettings } from '../../types'

// ── Mock @tauri-apps/api/core before importing anything that uses it ──────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock the git store refresh so it's a no-op in tests
vi.mock('../../../../store/useGitStore', () => ({
  useGitStore: {
    getState: () => ({ root: null, refreshAll: vi.fn() }),
  },
}))

import { invoke } from '@tauri-apps/api/core'
import { gitActionTool } from '../gitAgentTool'

const mockInvoke = invoke as ReturnType<typeof vi.fn>

// ── Shared helpers ────────────────────────────────────────────────────────────

function ctx(gitSettings?: Partial<GitToolSettings>): ToolContext {
  return {
    projectRoot: '/fake/project',
    gitSettings: {
      autoAllowCommit: true,
      autoAllowPush: false,       // push blocked by default
      allowDirectPushToMain: false,
      ...gitSettings,
    },
  }
}

function ctxNoRoot(): ToolContext {
  return { projectRoot: null }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── status ────────────────────────────────────────────────────────────────────

describe('git_action — status', () => {
  it('returns a list of changed files', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'src/index.ts', status: 'M', staged: false, original_path: null },
      { path: 'src/new.ts',   status: 'A', staged: true,  original_path: null },
    ])

    const result = await gitActionTool.execute({ action: 'status' }, ctx())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.affectedFiles).toEqual(['src/index.ts', 'src/new.ts'])
    expect(result.data.message).toMatch(/2 changed/i)
  })

  it('fails gracefully when no project root is set', async () => {
    const result = await gitActionTool.execute({ action: 'status' }, ctxNoRoot())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/projectRoot/i)
  })
})

// ── stage ─────────────────────────────────────────────────────────────────────

describe('git_action — stage', () => {
  it('stages the given files and returns them as affectedFiles', async () => {
    mockInvoke.mockResolvedValue(undefined) // git_stage returns void

    const result = await gitActionTool.execute(
      { action: 'stage', files: ['src/a.ts', 'src/b.ts'] },
      ctx()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.affectedFiles).toEqual(['src/a.ts', 'src/b.ts'])
    // Verify invoke was called with git_stage
    expect(mockInvoke).toHaveBeenCalledWith('git_stage', expect.objectContaining({
      paths: ['src/a.ts', 'src/b.ts'],
    }))
  })
})

// ── commit ────────────────────────────────────────────────────────────────────

describe('git_action — commit', () => {
  it('commits successfully when staged diff exists', async () => {
    mockInvoke
      .mockResolvedValueOnce('diff --git a/src/a.ts b/src/a.ts\n+added line') // git_diff (staged check)
      .mockResolvedValueOnce(undefined) // git_commit

    const result = await gitActionTool.execute(
      { action: 'commit', message: 'Add auth token refresh logic' },
      ctx()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.message).toMatch(/auth token refresh/i)
  })

  it('blocks commit when autoAllowCommit is false', async () => {
    const result = await gitActionTool.execute(
      { action: 'commit', message: 'Add something' },
      ctx({ autoAllowCommit: false })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/blocked/i)
    expect(mockInvoke).not.toHaveBeenCalled()
    // Regression: the failure must be tagged with the blocking setting so
    // the chat UI can render a one-click "enable & retry" toggle instead of
    // the agent asking in prose and the reply getting misrouted by intent
    // classification (see PendingToggleCard / useChat.resolvePendingToggle).
    expect(result.blockedSetting).toBe('autoAllowCommit')
  })

  it('blocks commit with a generic message', async () => {
    mockInvoke.mockResolvedValueOnce('diff --git a/src/a.ts ...\n+line') // staged diff

    const result = await gitActionTool.execute(
      { action: 'commit', message: 'fix' },
      ctx()
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/generic/i)
  })

  it('blocks commit when nothing is staged', async () => {
    mockInvoke.mockResolvedValueOnce('') // empty staged diff

    const result = await gitActionTool.execute(
      { action: 'commit', message: 'Add login button component' },
      ctx()
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/nothing is staged/i)
  })
})

// ── push ──────────────────────────────────────────────────────────────────────

describe('git_action — push', () => {
  it('blocks push when autoAllowPush is false (default)', async () => {
    const result = await gitActionTool.execute(
      { action: 'push' },
      ctx({ autoAllowPush: false })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/blocked/i)
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result.blockedSetting).toBe('autoAllowPush')
  })

  it('blocks push to main when allowDirectPushToMain is false', async () => {
    // Simulate current branch = "main"
    mockInvoke.mockResolvedValueOnce([
      { name: 'main', is_current: true, is_remote: false },
    ])

    const result = await gitActionTool.execute(
      { action: 'push' },
      ctx({ autoAllowPush: true, allowDirectPushToMain: false })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/main/i)
    expect(result.error).toMatch(/blocked/i)
    expect(result.blockedSetting).toBe('allowDirectPushToMain')
  })

  it('allows push to main when allowDirectPushToMain is true', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ name: 'main', is_current: true, is_remote: false }]) // getBranches
      .mockResolvedValueOnce('Everything up-to-date') // git_push

    const result = await gitActionTool.execute(
      { action: 'push' },
      ctx({ autoAllowPush: true, allowDirectPushToMain: true })
    )

    expect(result.ok).toBe(true)
  })

  it('allows push to a feature branch without allowDirectPushToMain', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ name: 'feat/login', is_current: true, is_remote: false }])
      .mockResolvedValueOnce('Pushed to feat/login')

    const result = await gitActionTool.execute(
      { action: 'push' },
      ctx({ autoAllowPush: true, allowDirectPushToMain: false })
    )

    expect(result.ok).toBe(true)
  })
})

// ── branch_create / branch_switch ─────────────────────────────────────────────

describe('git_action — branches', () => {
  it('creates a new branch', async () => {
    mockInvoke.mockResolvedValue(undefined) // git_create_branch

    const result = await gitActionTool.execute(
      { action: 'branch_create', name: 'feat/new-feature' },
      ctx()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.message).toMatch(/feat\/new-feature/)
  })

  it('switches to an existing branch', async () => {
    mockInvoke.mockResolvedValue(undefined) // git_switch_branch

    const result = await gitActionTool.execute(
      { action: 'branch_switch', name: 'develop' },
      ctx()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.message).toMatch(/develop/)
  })
})
