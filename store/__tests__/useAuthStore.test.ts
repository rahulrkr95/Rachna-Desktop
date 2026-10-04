// store/__tests__/useAuthStore.test.ts
//
// A Rachna account is only needed for Rachna Cloud AI, so the auth store must
// (a) never block or fail app startup, (b) only sign out on a real 401/403,
// and (c) open the sign-in dialog lazily, on demand.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { useAuthStore } from '../useAuthStore'
import { RachnaCloudProvider } from '../../lib/providers/RachnaCloudProvider'

const invokeMock = vi.mocked(invoke)
const user = { email: 'a@b.c', plan: 'FREE', coins: 5 }

function reset() {
  invokeMock.mockReset()
  useAuthStore.setState({
    sessionToken: null,
    userInfo: null,
    isAuthenticated: false,
    isLoading: true,
    loginDialogOpen: false,
  })
}

/** Lets the fire-and-forget background verify settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useAuthStore.initAuth', () => {
  beforeEach(reset)

  it('starts signed out and ready when nothing is cached (no network call)', async () => {
    invokeMock.mockResolvedValueOnce(null) // load_cached_session
    await useAuthStore.getState().initAuth()
    const s = useAuthStore.getState()
    expect(s.isLoading).toBe(false)
    expect(s.isAuthenticated).toBe(false)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('load_cached_session')
  })

  it('still starts signed out if the keychain read itself fails', async () => {
    invokeMock.mockRejectedValueOnce('keychain unavailable')
    await useAuthStore.getState().initAuth()
    expect(useAuthStore.getState().isLoading).toBe(false)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('trusts the cached session immediately, without waiting on the network', async () => {
    invokeMock.mockResolvedValueOnce({ token: 't1', user }) // load_cached_session
    invokeMock.mockReturnValueOnce(new Promise(() => {}))   // verify_session never resolves
    await useAuthStore.getState().initAuth()
    const s = useAuthStore.getState()
    expect(s.isLoading).toBe(false)
    expect(s.isAuthenticated).toBe(true)
    expect(s.sessionToken).toBe('t1')
    expect(s.userInfo).toEqual(user)
  })

  it('signs out ONLY when the backend explicitly rejects the token', async () => {
    invokeMock.mockResolvedValueOnce({ token: 't1', user })
    invokeMock.mockRejectedValueOnce('INVALID_TOKEN') // verify_session
    invokeMock.mockResolvedValue(undefined)           // clear_cached_session
    await useAuthStore.getState().initAuth()
    await flush()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().sessionToken).toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('clear_cached_session')
  })

  it.each(['NETWORK_ERROR:timeout', 'HTTP_ERROR:503'])(
    'keeps the session on a transient backend problem (%s)',
    async (err) => {
      invokeMock.mockResolvedValueOnce({ token: 't1', user })
      invokeMock.mockRejectedValueOnce(err) // verify_session
      await useAuthStore.getState().initAuth()
      await flush()
      expect(useAuthStore.getState().isAuthenticated).toBe(true)
      expect(invokeMock).not.toHaveBeenCalledWith('clear_cached_session')
    },
  )
})

describe('sign-in dialog', () => {
  beforeEach(reset)

  it('opens on request when signed out, and is a no-op when already signed in', () => {
    useAuthStore.getState().openLoginDialog()
    expect(useAuthStore.getState().loginDialogOpen).toBe(true)

    useAuthStore.setState({ loginDialogOpen: false, isAuthenticated: true })
    useAuthStore.getState().openLoginDialog()
    expect(useAuthStore.getState().loginDialogOpen).toBe(false)
  })

  it('closes itself once a session is set', async () => {
    invokeMock.mockResolvedValue(undefined)
    useAuthStore.setState({ loginDialogOpen: true })
    await useAuthStore.getState().setSession('t2', user)
    expect(useAuthStore.getState().loginDialogOpen).toBe(false)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })
})

describe('Rachna Cloud without an account', () => {
  beforeEach(reset)

  it('asks for sign-in (and never calls the backend) when signed out', async () => {
    const onError = vi.fn()
    await new RachnaCloudProvider().stream('', [{ role: 'user', content: 'Hi' }], {
      onChunk: () => {},
      onDone: () => {},
      onError,
    })
    expect(useAuthStore.getState().loginDialogOpen).toBe(true)
    expect(invokeMock).not.toHaveBeenCalledWith('cloud_ai_generate', expect.anything())
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toMatch(/Sign in to use Rachna Cloud AI/)
  })
})
