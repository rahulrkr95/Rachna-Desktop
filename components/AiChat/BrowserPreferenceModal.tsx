// components/AiChat/BrowserPreferenceModal.tsx
//
// Custom in-app overlay shown by openDefaultBrowserTool the first time it
// runs (or when the user asks to change their browser) — replaces the old
// window.prompt()-based flow. Deliberately NOT the default Tauri dialog:
// this renders inside the app window so it can't appear behind/outside it
// and so the "keep the app focused" behavior (see useBrowserPreferenceStore)
// actually keeps this dialog in view.
//
// Driven entirely by useBrowserPreferenceStore, same shape as
// TerminalPermissionModal/BuildProjectDialog: it renders only while
// pendingRequest is set, and calls submit()/cancel() on that store when the
// user responds. The store's requestPreference() Promise is what
// openDefaultBrowserTool actually awaits, so the agent tool call is
// genuinely paused — no browser is launched until this modal resolves.
//
// Profile auto-discovery:
//   Whenever the selected browser is a recognized Chromium-family browser
//   (see discoverBrowserProfiles/list_browser_profiles), this queries its
//   actual installed profiles (by reading its "Local State" file) and
//   populates the Profile field as a dropdown of real profile names
//   instead of a free-text guess. If discovery is unsupported for the
//   chosen browser, or turns up nothing, the field gracefully falls back
//   to manual text entry with a short explanatory note — the user is
//   never blocked from continuing either way.
//
//   The launch flow itself is untouched: whatever profile identifier ends
//   up in `profile` (a discovered folder id or manually-typed text) is
//   passed straight through to submit()/openDefaultBrowserTool exactly as
//   before discovery existed.
//
// Matches the visual language of BuildProjectDialog.tsx/TerminalPermissionModal.tsx.

import React, { useState, useEffect, useRef } from 'react'
import { useBrowserPreferenceStore } from '../../store/useBrowserPreferenceStore'
import { discoverBrowserProfiles, type BrowserProfile } from '../../services/appRegistry/browserProfiles'
import styles from './BrowserPreferenceModal.module.css'

// Kept in sync with the browsers named in openDefaultBrowserTool's tool
// description. "Other…" reveals a free-text field for anything not listed
// (e.g. Arc variants, Vivaldi, Opera) without limiting the tool to this list.
const BROWSER_OPTIONS = ['System Default', 'Chrome', 'Edge', 'Firefox', 'Brave', 'Arc', 'Other…']

// Sentinel value for the profile <select>'s "type it myself" option — kept
// distinct from any real profile id so it can never collide with one.
const MANUAL_ENTRY_VALUE = '__manual__'

type ProfileDiscoveryStatus = 'idle' | 'loading' | 'found' | 'unavailable'

export function BrowserPreferenceModal() {
  const pendingRequest = useBrowserPreferenceStore(s => s.pendingRequest)
  const submit         = useBrowserPreferenceStore(s => s.submit)
  const cancel          = useBrowserPreferenceStore(s => s.cancel)

  const [browser, setBrowser]           = useState('System Default')
  const [customBrowser, setCustomBrowser] = useState('')
  const [profile, setProfile]           = useState('Default')
  const [remember, setRemember]         = useState(true)
  const browserSelectRef = useRef<HTMLSelectElement>(null)

  // ── Profile auto-discovery state ──────────────────────────────────────
  const [discoveredProfiles, setDiscoveredProfiles] = useState<BrowserProfile[]>([])
  const [discoveryStatus, setDiscoveryStatus] = useState<ProfileDiscoveryStatus>('idle')
  // True once the user explicitly asks to type a profile name themselves,
  // even though discovery found real profiles to pick from.
  const [manualOverride, setManualOverride] = useState(false)
  // Guards against a slower, stale discovery call landing after the user
  // has already switched to a different browser.
  const discoveryRequestId = useRef(0)

  // Reset to sensible defaults every time a new request opens the modal.
  useEffect(() => {
    if (pendingRequest) {
      setBrowser('System Default')
      setCustomBrowser('')
      setProfile('Default')
      setRemember(true)
      setDiscoveredProfiles([])
      setDiscoveryStatus('idle')
      setManualOverride(false)
      setTimeout(() => browserSelectRef.current?.focus(), 50)
    }
  }, [pendingRequest])

  // Escape cancels, same as the other in-app dialogs.
  useEffect(() => {
    if (!pendingRequest) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pendingRequest, cancel])

  const isSystemDefault = browser === 'System Default'
  const isOther = browser === 'Other…'
  const resolvedBrowser = isOther ? customBrowser.trim() : browser

  // Re-discover profiles whenever the effective browser changes. Skipped
  // entirely for System Default (no profile concept) and for an empty
  // "Other…" name (nothing to look up yet).
  useEffect(() => {
    if (!pendingRequest || isSystemDefault || !resolvedBrowser) {
      setDiscoveredProfiles([])
      setDiscoveryStatus('idle')
      return
    }

    const requestId = ++discoveryRequestId.current
    setDiscoveryStatus('loading')
    setManualOverride(false)

    discoverBrowserProfiles(resolvedBrowser).then((found) => {
      // A newer request superseded this one (user changed the browser
      // again while this was in flight) — drop this stale result.
      if (discoveryRequestId.current !== requestId) return

      setDiscoveredProfiles(found)
      setDiscoveryStatus(found.length > 0 ? 'found' : 'unavailable')
      if (found.length > 0) {
        setProfile(found[0].id)
      } else {
        setProfile('Default')
      }
    })
    // discoverBrowserProfiles never rejects (see its own doc comment) —
    // no .catch needed.
  }, [pendingRequest, isSystemDefault, resolvedBrowser])

  if (!pendingRequest) return null

  const showProfileDropdown = discoveryStatus === 'found' && !manualOverride
  const canSubmit = resolvedBrowser.length > 0 && (isSystemDefault || profile.trim().length > 0)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    submit({
      browser: resolvedBrowser,
      profile: isSystemDefault ? 'Default' : (profile.trim() || 'Default'),
      remember,
    })
  }

  const handleProfileSelectChange = (value: string) => {
    if (value === MANUAL_ENTRY_VALUE) {
      setManualOverride(true)
      setProfile('Default')
    } else {
      setProfile(value)
    }
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Choose your browser">
      <form className={styles.modal} onSubmit={handleSubmit}>

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className={styles.header}>
          <span className={styles.icon}>🌐</span>
          <span className={styles.title}>Choose your browser</span>
        </div>

        <p className={styles.description}>
          The agent wants to open a browser. Pick which one (and profile) it should use — this
          is only asked again if you choose to change it later.
        </p>

        {/* ── Browser ───────────────────────────────────────────────── */}
        <label className={styles.fieldLabel} htmlFor="browser-pref-browser">Browser</label>
        <select
          id="browser-pref-browser"
          ref={browserSelectRef}
          className={styles.selectInput}
          value={browser}
          onChange={e => setBrowser(e.target.value)}
        >
          {BROWSER_OPTIONS.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {isOther && (
          <input
            className={styles.textInput}
            type="text"
            value={customBrowser}
            onChange={e => setCustomBrowser(e.target.value)}
            placeholder="Browser name (e.g. Vivaldi)"
            autoComplete="off"
            autoFocus
          />
        )}

        {/* ── Profile ───────────────────────────────────────────────── */}
        {!isSystemDefault && (
          <>
            <label className={styles.fieldLabel} htmlFor="browser-pref-profile">Profile</label>

            {discoveryStatus === 'loading' && (
              <p className={styles.discoveryHint}>Looking for installed profiles…</p>
            )}

            {showProfileDropdown ? (
              <>
                <select
                  id="browser-pref-profile"
                  className={styles.selectInput}
                  value={profile}
                  onChange={e => handleProfileSelectChange(e.target.value)}
                >
                  {discoveredProfiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name === p.id ? p.name : `${p.name} (${p.id})`}
                    </option>
                  ))}
                  <option value={MANUAL_ENTRY_VALUE}>Other… (type a profile name)</option>
                </select>
                <span className={styles.discoveryHint}>
                  Found {discoveredProfiles.length} profile{discoveredProfiles.length === 1 ? '' : 's'} for {resolvedBrowser}.
                </span>
              </>
            ) : (
              <>
                <input
                  id="browser-pref-profile"
                  className={styles.textInput}
                  type="text"
                  value={profile}
                  onChange={e => setProfile(e.target.value)}
                  placeholder="Default, Personal, Work…"
                  autoComplete="off"
                />
                {discoveryStatus === 'unavailable' && (
                  <span className={styles.discoveryHint}>
                    Couldn't automatically detect profiles for {resolvedBrowser} — enter the profile name manually.
                  </span>
                )}
                {discoveryStatus === 'found' && manualOverride && (
                  <button
                    type="button"
                    className={styles.useDiscoveredBtn}
                    onClick={() => { setManualOverride(false); setProfile(discoveredProfiles[0]?.id ?? 'Default') }}
                  >
                    ← Choose from detected profiles instead
                  </button>
                )}
              </>
            )}
          </>
        )}

        {/* ── Remember ──────────────────────────────────────────────── */}
        <label className={styles.rememberLabel}>
          <input
            type="checkbox"
            className={styles.rememberCheckbox}
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
          />
          <span>
            Remember this selection{' '}
            <span className={styles.rememberHint}>(skip this dialog next time)</span>
          </span>
        </label>

        {/* ── Actions ───────────────────────────────────────────────── */}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={cancel}
            title="Cancel (Esc)"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.continueBtn}
            disabled={!canSubmit}
            title="Continue (Enter)"
          >
            ✓ Continue
          </button>
        </div>
      </form>
    </div>
  )
}
