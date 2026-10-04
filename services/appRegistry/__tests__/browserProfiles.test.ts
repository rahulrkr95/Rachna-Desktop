import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { discoverBrowserProfiles } from '../browserProfiles'

const mockInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('discoverBrowserProfiles', () => {
  it('returns profiles found by the Rust command', async () => {
    mockInvoke.mockResolvedValue([
      { id: 'Default', name: 'Default' },
      { id: 'Profile 1', name: 'Work' },
    ])

    const result = await discoverBrowserProfiles('Chrome')

    expect(result).toEqual([
      { id: 'Default', name: 'Default' },
      { id: 'Profile 1', name: 'Work' },
    ])
    expect(mockInvoke).toHaveBeenCalledWith('list_browser_profiles', { browser: 'Chrome' })
  })

  it('skips discovery for System Default without calling the command', async () => {
    const result = await discoverBrowserProfiles('System Default')

    expect(result).toEqual([])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('skips discovery for an empty browser name', async () => {
    const result = await discoverBrowserProfiles('   ')

    expect(result).toEqual([])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('falls back to an empty array when the command throws', async () => {
    mockInvoke.mockRejectedValue(new Error('command not found'))

    const result = await discoverBrowserProfiles('Firefox')

    expect(result).toEqual([])
  })

  it('falls back to an empty array when the command returns something unexpected', async () => {
    mockInvoke.mockResolvedValue(null as unknown as [])

    const result = await discoverBrowserProfiles('Brave')

    expect(result).toEqual([])
  })
})
