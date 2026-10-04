// components/AiChat/BuildProjectDialog.tsx
//
// Shown when intent classification routes a no-project message to
// BUILD_NEW. Collects a project name + a parent folder location, then
// creates "{location}/{projectName}" on disk and sets it as the project
// root. Once confirmed, useChat's projectRoot effect automatically fires
// the user's original message so the agent starts building right away.
//
// Matches the visual language of TerminalPermissionModal.tsx.

import React, { useState, useEffect, useRef } from 'react'
import styles from './BuildProjectDialog.module.css'

interface Props {
  open:        boolean
  /**
   * 'design' when this dialog was opened by a DESIGN-classified request
   * (see lib/intentClassifier.ts) — same folder-creation flow, but the
   * copy/icon/default name reflect that the output will be static
   * Tailwind + Lucide HTML design pages rather than a coding project.
   */
  mode?:       'code' | 'design'
  submitting:  boolean
  error:       string | null
  /**
   * Default parent folder to pre-fill the "Location" field with —
   * `{Rachna AI Studio install dir}/data/projects` (see
   * lib/tauriFs.ts::getDefaultProjectsDir). Null while still resolving or
   * unresolvable; the field just starts empty in that case and the user
   * can Browse… manually.
   */
  defaultLocation: string | null
  /**
   * Pre-fills the "Project name" / "Design name" field with an existing
   * name (e.g. the in-memory project's current name) instead of the
   * generic 'my-new-project' / 'my-new-design' placeholder. Used by the
   * "Save" flow for unsaved (in-memory) projects — see
   * IDELayout.tsx::handleSave.
   */
  initialProjectName?: string
  /** Overrides the header/description copy — used by the Save flow so the
   * dialog reads as "save this project" rather than "build a new one". */
  headingOverride?: string
  descriptionOverride?: string
  confirmLabelOverride?: string
  onBrowse:    () => Promise<string | null>
  onConfirm:   (location: string, projectName: string) => Promise<void>
  onCancel:    () => void
}

function slugify(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9-_. ]+/g, '-')
    .replace(/\s+/g, '-')
}

export function BuildProjectDialog({ open, mode = 'code', submitting, error, defaultLocation, initialProjectName, headingOverride, descriptionOverride, confirmLabelOverride, onBrowse, onConfirm, onCancel }: Props) {
  const isDesign = mode === 'design'
  const defaultName = initialProjectName ?? (isDesign ? 'my-new-design' : 'my-new-project')
  const [projectName, setProjectName] = useState(defaultName)
  const [location,    setLocation]    = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Reset to sensible defaults each time the dialog opens — location
  // pre-fills with the install-dir default the moment it's known (it may
  // still be resolving right as the dialog opens; the effect below picks
  // it up as soon as it lands, as long as the user hasn't typed/browsed
  // their own value yet).
  useEffect(() => {
    if (open) {
      setProjectName(defaultName)
      setLocation(defaultLocation ?? '')
      setTimeout(() => nameInputRef.current?.focus(), 50)
    }
  }, [open, defaultLocation, defaultName])

  // Keyboard: Esc to cancel (Enter is handled by the form's onSubmit)
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, submitting, onCancel])

  if (!open) return null

  const handleBrowse = async () => {
    const picked = await onBrowse()
    if (picked) setLocation(picked)
  }

  const canSubmit = projectName.trim().length > 0 && location.trim().length > 0 && !submitting

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    onConfirm(location.trim(), slugify(projectName))
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={headingOverride ?? (isDesign ? 'Design a new project' : 'Build new project')}>
      <form className={styles.modal} onSubmit={handleSubmit}>

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className={styles.header}>
          <span className={styles.icon}>{isDesign ? '🎨' : '🚀'}</span>
          <span className={styles.title}>{headingOverride ?? (isDesign ? 'Design a new project' : 'Build a new project')}</span>
        </div>

        <p className={styles.description}>
          {descriptionOverride ?? (isDesign
            ? "Name your design and choose where it should live. We'll create the folder and start designing Tailwind + Lucide pages inside it right away."
            : "Name your project and choose where it should live. We'll create the folder and start building inside it right away.")}
        </p>

        {/* ── Project name ──────────────────────────────────────────── */}
        <label className={styles.fieldLabel} htmlFor="build-project-name">{isDesign ? 'Design name' : 'Project name'}</label>
        <input
          id="build-project-name"
          ref={nameInputRef}
          className={styles.textInput}
          type="text"
          value={projectName}
          onChange={e => setProjectName(e.target.value)}
          placeholder={isDesign ? 'my-new-design' : 'my-new-project'}
          autoComplete="off"
          disabled={submitting}
        />
        {projectName.trim() && slugify(projectName) !== projectName.trim() && (
          <span className={styles.fieldHint}>Will be created as: <code>{slugify(projectName)}</code></span>
        )}

        {/* ── Location ──────────────────────────────────────────────── */}
        <label className={styles.fieldLabel} htmlFor="build-project-location">Location</label>
        <div className={styles.locationRow}>
          <input
            id="build-project-location"
            className={styles.textInput}
            type="text"
            value={location}
            onChange={e => setLocation(e.target.value)}
            placeholder="Choose a folder…"
            autoComplete="off"
            disabled={submitting}
          />
          <button
            type="button"
            className={styles.browseBtn}
            onClick={handleBrowse}
            disabled={submitting}
          >
            📂 Browse…
          </button>
        </div>
        {defaultLocation && location !== defaultLocation && (
          <button
            type="button"
            className={styles.useDefaultBtn}
            onClick={() => setLocation(defaultLocation)}
            disabled={submitting}
          >
            Use default location (Rachna AI Studio/data/projects)
          </button>
        )}
        {location && (
          <span className={styles.fieldHint}>
            Will create: <code>{location.replace(/[\\/]+$/, '')}/{slugify(projectName) || '…'}</code>
          </span>
        )}

        {/* ── Error ─────────────────────────────────────────────────── */}
        {error && <div className={styles.errorBox}>⚠ {error}</div>}

        {/* ── Actions ───────────────────────────────────────────────── */}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={onCancel}
            disabled={submitting}
            title="Cancel (Esc)"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.createBtn}
            disabled={!canSubmit}
            title={confirmLabelOverride ? `${confirmLabelOverride} (Enter)` : (isDesign ? 'Create design (Enter)' : 'Create project (Enter)')}
          >
            {submitting
              ? (confirmLabelOverride ? 'Saving…' : 'Creating…')
              : (confirmLabelOverride ?? (isDesign ? '✓ Create & Start Designing' : '✓ Create & Start Building'))}
          </button>
        </div>
      </form>
    </div>
  )
}
