// store/useAuthStore.ts
//
// Rachna ACCOUNT state — used ONLY for Rachna Cloud AI.
//
// The IDE itself never requires an account: it opens straight to the
// workspace, and every non-cloud feature (your own API keys, local models,
// MCP, terminal, git, ...) works signed out. Signing in is requested lazily,
// at the moment someone actually tries to use Rachna Cloud — via
// `openLoginDialog()` (see components/LoginScreen.tsx, mounted once in
// App.tsx, and lib/providers/RachnaCloudProvider.ts).
//
// The token minted by the backend on login is an opaque UUID, not a JWT —
// it has no embedded expiry the app could decode locally. So "is the token
// still good" can only be answered by asking the backend: `verify_session`
// (GET /api/auth/me) with the cached token.
//
// After a successful sign-in (email/password via the Rust `login` command, or
// Google via `google_sign_in`) `setSession()` caches the token + user info in
// the OS-native credential store (Keychain / Credential Manager / Secret
// Service) via `save_cached_session`, so the person stays signed in across
// launches.
//
// On every launch, `initAuth()`:
//   1. Asks Rust for whatever's cached (`load_cached_session`) — a local
//      keychain read, so startup never waits on the network.
//   2. Nothing cached → signed out; the app is fully usable regardless.
//   3. Cached → treated as signed in immediately (last-known user info), then
//      re-verified in the background. ONLY an explicit rejection
//      (`INVALID_TOKEN`, i.e. 401/403) signs the person out; a backend that's
//      asleep, offline or erroring never does.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface UserInfo {
  email: string
  plan: 'FREE' | 'HOBBY' | 'PRO' | 'BUSINESS' | string
  coins: number
  canConfigureActions?: boolean
  canConfigurePermissions?: boolean
}

interface CachedSession {
  token: string
  user: UserInfo | null
}

interface AuthState {
  sessionToken: string | null
  userInfo: UserInfo | null
  isAuthenticated: boolean
  /** True on mount only while the cached session is read from the OS
   *  keychain (a local read — never a network round-trip). */
  isLoading: boolean
  /** Whether the Rachna Cloud sign-in dialog is showing. */
  loginDialogOpen: boolean

  /** Called once on app mount. Restores a cached session (see module doc
   *  above) and re-verifies it in the background. */
  initAuth: () => Promise<void>
  /** Ask the person to sign in to Rachna Cloud. Safe to call from anywhere
   *  (including non-React code); a no-op if already signed in. */
  openLoginDialog: () => void
  closeLoginDialog: () => void
  /** Called after a successful login (see components/LoginScreen.tsx).
   *  Sets in-memory state AND persists the token + user info to the OS
   *  keychain so the next launch can skip sign-in.
   *
   *  Awaits the keychain write before resolving, so the token is
   *  guaranteed to be persisted once the promise settles. Callers that only
   *  need the in-memory session are unaffected — this just delays the
   *  promise, not the `set()`. Also closes the sign-in dialog. */
  setSession: (token: string, userInfo: UserInfo) => Promise<void>

  /** Refresh account data (including the server-authoritative coin balance). */
  refreshUserInfo: () => Promise<void>

  /** Resets in-memory state AND clears the persisted session. The IDE keeps
   *  working; Rachna Cloud will ask for sign-in again when next used. */
  logout: () => Promise<void>
}

// ── Store ─────────────────────────────────────────────────────────────────────

let refreshInFlight: Promise<void> | null = null

/** True when a `verify_session` rejection means "this token is dead" (401/403)
 *  as opposed to a transient backend/network problem. See auth.rs. */
function isInvalidTokenError(e: unknown): boolean {
  return String(e).includes('INVALID_TOKEN')
}

export const useAuthStore = create<AuthState>((set, get) => ({
  sessionToken: null,
  userInfo: null,
  isAuthenticated: false,
  isLoading: true,
  loginDialogOpen: false,

  initAuth: async () => {
    let cached: CachedSession | null = null
    try {
      cached = await invoke<CachedSession | null>('load_cached_session')
    } catch (e) {
      console.warn('[auth] Failed to read cached session:', e)
    }

    if (!cached) {
      set({ isLoading: false, isAuthenticated: false })
      return
    }

    // Trust the cache immediately so startup never waits on the network.
    const { token } = cached
    set({
      sessionToken: token,
      userInfo: cached.user ?? null,
      isAuthenticated: true,
      isLoading: false,
    })

    // Re-verify in the background. Only a real auth rejection signs out.
    void (async () => {
      try {
        const userInfo = await invoke<UserInfo>('verify_session', { token })
        if (get().sessionToken !== token) return // signed out / changed meanwhile
        set({ userInfo })
        invoke('save_cached_session', { token, userInfo }).catch(() => {/* best-effort */})
      } catch (e) {
        if (isInvalidTokenError(e)) {
          console.warn('[auth] Session no longer valid, signing out:', e)
          if (get().sessionToken !== token) return
          invoke('clear_cached_session').catch(() => {/* best-effort */})
          set({ sessionToken: null, userInfo: null, isAuthenticated: false })
        } else {
          // Backend asleep/offline/erroring — keep the last-known session.
          console.warn('[auth] Could not re-verify session (keeping it):', e)
        }
      }
    })()
  },

  openLoginDialog: () => {
    if (get().isAuthenticated) return
    set({ loginDialogOpen: true })
  },

  closeLoginDialog: () => set({ loginDialogOpen: false }),

  setSession: async (token: string, userInfo: UserInfo) => {
    set({
      sessionToken: token,
      userInfo,
      isAuthenticated: true,
      isLoading: false,
      loginDialogOpen: false,
    })
    // Awaited so the token is in the OS keychain by the time this resolves. A
    // failure to persist only means the next launch asks for sign-in again
    // (when Rachna Cloud is next used), not that this session is broken.
    try {
      await invoke('save_cached_session', { token, userInfo })
    } catch (e) {
      console.warn('[auth] Failed to persist session to keychain:', e)
    }
  },

  refreshUserInfo: async () => {
    if (refreshInFlight) return refreshInFlight
    const token = get().sessionToken
    if (!token) return
    refreshInFlight = (async () => {
      try {
        const userInfo = await invoke<UserInfo>('verify_session', { token })
        // Ignore a late response belonging to a session that signed out or changed.
        if (get().sessionToken !== token) return
        set({ userInfo })
        invoke('save_cached_session', { token, userInfo }).catch(() => {/* best-effort */})
      } catch (error) {
        // A balance refresh must never turn a successful generation into a
        // failed call or mutate the cached balance speculatively.
        console.warn('[auth] Failed to refresh account info:', error)
      }
    })().finally(() => { refreshInFlight = null })
    return refreshInFlight
  },

  logout: async () => {
    set({ sessionToken: null, userInfo: null, isAuthenticated: false, isLoading: false })
    invoke('clear_cached_session').catch(e => {
      console.warn('[auth] Failed to clear cached session:', e)
    })
  },
}))
