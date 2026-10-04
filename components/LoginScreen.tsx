// components/LoginScreen.tsx
//
// Rachna Cloud sign-in dialog.
//
// A Rachna account is needed ONLY for Rachna Cloud AI — the rest of the IDE
// never asks. This dialog is therefore not a screen the app boots into: it is
// mounted once in App.tsx and shown on demand when someone tries to use Rachna
// Cloud while signed out (see `openLoginDialog()` in store/useAuthStore.ts,
// called from lib/providers/RachnaCloudProvider.ts, the model picker, and the
// account menu in components/Header.tsx).
//
// Two ways in, both ending in `useAuthStore.setSession()`:
//   • Email + password — the Rust `login` command → POST /api/auth/login.
//   • Continue with Google — the Rust `google_sign_in` command (browser +
//     loopback redirect → POST /api/auth/google; see src-tauri/src/auth.rs).
//     Only shown when a Google OAuth client id is configured at build time
//     (VITE_RACHNA_GOOGLE_CLIENT_ID — see .env.example).
//
// A 426 UPGRADE_REQUIRED from the backend is shown inline in the dialog. It
// no longer blocks the whole app: the IDE stays usable, only Cloud sign-in is
// refused until the app is updated.

import React, { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import { getCurrentAppVersion } from '../lib/appVersion'
import { useAuthStore } from '../store/useAuthStore'
import type { UserInfo } from '../store/useAuthStore'
import { deriveCodeChallenge, generateRandomString } from '../services/oauth/pkce'
import styles from './LoginScreen.module.css'

interface LoginResult {
  token: string
  user: UserInfo
}

// Shape of the 426 UPGRADE_REQUIRED body from POST /api/auth/login and
// /api/auth/google (see AuthHandler.blockIfUnsupported in the Go backend).
interface UpgradeRequiredPayload {
  message?: string
  latestVersion?: string
  minSupportedVersion?: string
}

const DOWNLOAD_URL = 'https://www.rachna-ai.in/download'
const WEBSITE_URL = 'https://www.rachna-ai.in'

function buildEnv(key: string): string {
  try {
    // Vite injects `import.meta.env` at build time; guarded for non-Vite contexts.
    return ((import.meta as unknown as { env?: Record<string, string> }).env?.[key] ?? '').trim()
  } catch {
    return ''
  }
}

// Google OAuth "Desktop app" client used ONLY to sign in to a Rachna account.
// Deliberately separate from VITE_GOOGLE_OAUTH_CLIENT_ID (the Gmail/Drive/
// Calendar connector) — different client, different scopes. The backend must
// list this id in GOOGLE_CLIENT_IDS. Google issues a (non-confidential)
// secret for Desktop clients and still requires it at the token endpoint.
const GOOGLE_CLIENT_ID = buildEnv('VITE_RACHNA_GOOGLE_CLIENT_ID')
const GOOGLE_CLIENT_SECRET = buildEnv('VITE_RACHNA_GOOGLE_CLIENT_SECRET')

/** Returns null for "the person backed out" — nothing to show. */
function friendlyError(error: unknown): string | null {
  const code = String(error)
  if (code.includes('GOOGLE_SIGNIN_CANCELLED')) return null
  if (code.includes('GOOGLE_SIGNIN_TIMEOUT')) return 'Google sign-in timed out. Please try again.'
  if (code.includes('GOOGLE_NOT_CONFIGURED')) return 'Google sign-in is not configured in this build.'
  if (code.includes('GOOGLE_STATE_MISMATCH')) return 'Google sign-in could not be verified. Please try again.'
  if (code.includes('GOOGLE_REJECTED')) return 'Rachna could not verify your Google account. Please try again.'
  if (code.includes('GOOGLE_TOKEN_ERROR')) return 'Google sign-in failed. Please try again.'
  if (code.includes('GOOGLE_SIGNIN_FAILED')) return 'Google sign-in failed. Please try again.'
  if (code === 'INVALID_CREDENTIALS') return 'Incorrect email or password.'
  if (code === 'ACCOUNT_SUSPENDED') return 'This account has been suspended.'
  if (code.startsWith('NETWORK_ERROR')) return 'Could not reach Rachna. Check your connection and try again.'
  if (code.startsWith('PARSE_ERROR')) return 'Rachna returned an unexpected response. Please try again.'
  return 'Sign-in failed. Please try again.'
}

function SignInDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'password' | 'google' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [upgrade, setUpgrade] = useState<UpgradeRequiredPayload | null>(null)

  const setSession = useAuthStore(s => s.setSession)

  const close = () => {
    // Stop a pending Google sign-in from waiting on the browser.
    if (busy === 'google') invoke('google_sign_in_cancel').catch(() => {/* best-effort */})
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  /** Shared failure handling for both sign-in paths. */
  const handleFailure = (e: unknown) => {
    const code = String(e)
    if (code.startsWith('UPGRADE_REQUIRED:')) {
      let payload: UpgradeRequiredPayload = {}
      try { payload = JSON.parse(code.slice('UPGRADE_REQUIRED:'.length)) } catch { /* best-effort */ }
      setUpgrade(payload)
      return
    }
    const message = friendlyError(e)
    if (message) {
      console.error('[LoginScreen] Sign-in failed:', e)
      setError(message)
    }
  }

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy('password')
    setError(null)
    try {
      const appVersion = await getCurrentAppVersion()
      const result = await invoke<LoginResult>('login', { email: trimmedEmail, password, appVersion })
      await setSession(result.token, result.user)
    } catch (err) {
      handleFailure(err)
    } finally {
      setBusy(null)
    }
  }

  const handleGoogle = async () => {
    if (busy) return
    setBusy('google')
    setError(null)
    try {
      const verifier = generateRandomString()
      const [codeChallenge, appVersion] = await Promise.all([
        deriveCodeChallenge(verifier),
        getCurrentAppVersion(),
      ])
      const result = await invoke<LoginResult>('google_sign_in', {
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET || null,
        codeChallenge,
        codeVerifier: verifier,
        state: generateRandomString(),
        appVersion,
      })
      await setSession(result.token, result.user)
    } catch (err) {
      handleFailure(err)
    } finally {
      setBusy(null)
    }
  }

  const openUrl = (url: string) => {
    openExternal(url).catch(err => console.error('[LoginScreen] Failed to open URL:', err))
  }

  return (
    <div className={styles.container} role="dialog" aria-modal="true" aria-label="Sign in to Rachna Cloud">
      <div className={styles.card}>
        <button className={styles.closeBtn} onClick={close} aria-label="Close" title="Close">✕</button>

        {/* Logo */}
        <div className={styles.logoRow}>
          <div className={styles.logoIcon} aria-hidden>✦</div>
          <span className={styles.logoText}>Rachna</span>
          <span className={styles.logoAccent}>Cloud</span>
        </div>

        <p className={styles.tagline}>
          Sign in to use Rachna Cloud AI.
          <br />
          Everything else in Rachna IDE works without an account.
        </p>

        {upgrade ? (
          <div className={styles.form}>
            <p className={styles.error}>
              {upgrade.message || 'Your Rachna IDE version is outdated.'}
              {upgrade.latestVersion ? ` Please update to ${upgrade.latestVersion} to sign in.` : ' Please update to sign in.'}
            </p>
            <button type="button" className={styles.signInBtn} onClick={() => openUrl(DOWNLOAD_URL)}>
              Download update
            </button>
            <button type="button" className={styles.linkBtn} onClick={close}>
              Not now
            </button>
          </div>
        ) : (
          <>
            {GOOGLE_CLIENT_ID && (
              <>
                <button
                  type="button"
                  className={styles.googleBtn}
                  onClick={handleGoogle}
                  disabled={busy !== null}
                >
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                  </svg>
                  {busy === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
                </button>
                {busy === 'google' && (
                  <p className={styles.hint}>Finish signing in in your browser, then come back here.</p>
                )}
                <div className={styles.divider}><span>or</span></div>
              </>
            )}

            <form className={styles.form} onSubmit={handlePasswordSubmit}>
              <input
                className={styles.input}
                type="email"
                placeholder="Email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={busy !== null}
                autoFocus
                required
              />
              <input
                className={styles.input}
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={busy !== null}
                required
              />

              {error && <p className={styles.error}>{error}</p>}

              <button type="submit" className={styles.signInBtn} disabled={busy !== null}>
                {busy === 'password' ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <p className={styles.hint}>
              No account?{' '}
              <button type="button" className={styles.inlineLink} onClick={() => openUrl(WEBSITE_URL)}>
                Create one at rachna-ai.in
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** Mounted once in App.tsx; renders nothing unless Cloud sign-in was requested. */
export default function LoginScreen() {
  const open = useAuthStore(s => s.loginDialogOpen)
  const closeLoginDialog = useAuthStore(s => s.closeLoginDialog)
  if (!open) return null
  return <SignInDialog onClose={closeLoginDialog} />
}
