import '../../__tests__/_localStoragePolyfill'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../../../appRegistry/openApp', () => ({ resolveAndOpenApp: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { resolveAndOpenApp } from '../../../appRegistry/openApp'
import {
  DEFAULT_BROWSER_PREFERENCE_KEY,
  openDefaultBrowserTool,
} from '../openDefaultBrowserTool'

const mockResolveAndOpenApp = vi.mocked(resolveAndOpenApp)
const mockInvoke = vi.mocked(invoke)

beforeEach(() => {
  localStorage.clear()
  mockResolveAndOpenApp.mockReset()
  mockInvoke.mockReset()
})

describe('openDefaultBrowser', () => {
  it('launches the saved Chrome profile without prompting again', async () => {
    localStorage.setItem(DEFAULT_BROWSER_PREFERENCE_KEY, JSON.stringify({
      browser: 'Google Chrome',
      profile: 'Profile 2',
    }))
    mockResolveAndOpenApp.mockResolvedValue({
      status: 'launched',
      match: { name: 'Google Chrome', path: 'chrome.exe', source: 'app_paths' },
    })
    const requestBrowserPreference = vi.fn()

    const result = await openDefaultBrowserTool.execute({}, {
      projectRoot: null,
      requestBrowserPreference,
    })

    expect(result.ok).toBe(true)
    expect(requestBrowserPreference).not.toHaveBeenCalled()
    expect(mockResolveAndOpenApp).toHaveBeenCalledWith(
      'Google Chrome',
      undefined,
      ['--profile-directory=Profile 2']
    )
  })

  it('asks for and saves a replacement when the saved profile cannot launch', async () => {
    localStorage.setItem(DEFAULT_BROWSER_PREFERENCE_KEY, JSON.stringify({
      browser: 'Chrome',
      profile: 'Removed Profile',
    }))
    mockResolveAndOpenApp
      .mockRejectedValueOnce(new Error('profile unavailable'))
      .mockResolvedValueOnce({
        status: 'launched',
        match: { name: 'Chrome', path: 'chrome.exe', source: 'app_paths' },
      })
    const requestBrowserPreference = vi.fn().mockResolvedValue({
      browser: 'Chrome',
      profile: 'Default',
    })

    const result = await openDefaultBrowserTool.execute({}, {
      projectRoot: null,
      requestBrowserPreference,
    })

    expect(result.ok).toBe(true)
    expect(requestBrowserPreference).toHaveBeenCalledOnce()
    expect(mockResolveAndOpenApp).toHaveBeenLastCalledWith(
      'Chrome',
      undefined,
      ['--profile-directory=Default']
    )
    expect(JSON.parse(localStorage.getItem(DEFAULT_BROWSER_PREFERENCE_KEY)!)).toEqual({
      browser: 'Chrome',
      profile: 'Default',
    })
  })

  it('does not add Chromium profile arguments to Firefox', async () => {
    localStorage.setItem(DEFAULT_BROWSER_PREFERENCE_KEY, JSON.stringify({
      browser: 'Firefox',
      profile: 'Personal',
    }))
    mockResolveAndOpenApp.mockResolvedValue({
      status: 'launched',
      match: { name: 'Firefox', path: 'firefox.exe', source: 'app_paths' },
    })

    await openDefaultBrowserTool.execute({}, { projectRoot: null })

    expect(mockResolveAndOpenApp).toHaveBeenCalledWith('Firefox', undefined, [])
  })
})
