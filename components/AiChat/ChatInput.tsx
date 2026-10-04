// components/AiChat/ChatInput.tsx

import React, { useCallback, useEffect, useRef, useState } from 'react'
import ModelPicker from '../ModelPicker'
import styles from '../AiChat.module.css'
import type { PendingImage } from '../../lib/providers/types'
import { useChatAppContextStore, appContextChipLabel } from '../../store/useChatAppContextStore'

/** An image staged for the next outgoing message. */
export interface PendingChatImage extends PendingImage {
  previewUrl: string
}

const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5MB

interface Props {
  input:         string
  streaming:     boolean
  hasKey:        boolean
  indexStatus:   string | null
  textareaRef:   React.RefObject<HTMLTextAreaElement>
  onInput:       (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown:     (e: React.KeyboardEvent) => void
  onSend:        (images: PendingChatImage[]) => void
  onStop:        () => void
  onHintClick:   (hint: string) => void
  /** Whether the active provider/model accepts image input. */
  visionSupported: boolean
  /** True while a no-project message is being routed by intent classification. */
  classifying?: boolean
  /** True once the active Gemini model has hit its free-tier daily request cap (FEATURE-001). Blocks sending. */
  quotaBlocked?: boolean
  /** Placeholder/tooltip text shown while quotaBlocked is true. */
  quotaMessage?: string
  /**
   * Chat View only (see ChatHeader's identical prop). When true, the
   * always-visible shortcut chips (@file, @sel, /fix, /doc, /test, …) are
   * replaced by a single "+" button that opens a small dropdown containing
   * the same shortcuts. Selecting one calls the same onHintClick handler
   * used today — no new behavior, just a different way to trigger it.
   * Full Studio View leaves this unset and keeps the chips inline.
   */
  compactDialogLayout?: boolean
}

const HINTS = ['@file', '@sel', '/fix', '/doc', '/test']

function base64FromDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(',')
  return idx === -1 ? dataUrl : dataUrl.slice(idx + 1)
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export function ChatInput({
  input,
  streaming,
  hasKey,
  indexStatus,
  textareaRef,
  onInput,
  onKeyDown,
  onSend,
  onStop,
  onHintClick,
  visionSupported,
  classifying = false,
  quotaBlocked = false,
  quotaMessage,
  compactDialogLayout = false,
}: Props) {
  const isIndexing = indexStatus === 'indexing' || indexStatus === 'refreshing'
  // NOTE: indexing no longer blocks the whole chat — only classification
  // (figuring out what a no-project message even means) does that. If the
  // message turns out to need the repo index (WORK_WITH_REPO/TERMINAL_TASK),
  // useChat.ts queues it and shows a "still indexing" notice instead of
  // freezing input for everything else (CHAT, RUN_PROJECT, etc.).
  const isBusy      = classifying

  const [images, setImages]       = useState<PendingChatImage[]>([])
  const [imageError, setImageErr] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const shortcutsRef = useRef<HTMLDivElement>(null)
  const appContextItems  = useChatAppContextStore(s => s.items)
  const removeAppContext = useChatAppContextStore(s => s.remove)

  useEffect(() => {
    if (!shortcutsOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (shortcutsRef.current && !shortcutsRef.current.contains(e.target as Node)) {
        setShortcutsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [shortcutsOpen])

  const addFiles = useCallback(async (files: File[]) => {
    if (!visionSupported) return
    setImageErr(null)

    const candidates = files.filter(f => ACCEPTED_MIME_TYPES.includes(f.type))
    if (candidates.length === 0) return

    let next = images
    const accepted: PendingChatImage[] = []
    let rejectedReason: string | null = null

    for (const file of candidates) {
      if (next.length + accepted.length >= MAX_IMAGES) {
        rejectedReason = `Only up to ${MAX_IMAGES} images per message are allowed.`
        break
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejectedReason = `"${file.name}" is larger than 5MB and was skipped.`
        continue
      }
      try {
        const dataUrl = await readFileAsDataUrl(file)
        accepted.push({
          base64:     base64FromDataUrl(dataUrl),
          mimeType:   file.type,
          previewUrl: dataUrl,
        })
      } catch {
        rejectedReason = `Could not read "${file.name}".`
      }
    }

    if (accepted.length > 0) {
      next = [...next, ...accepted]
      setImages(next)
    }
    if (rejectedReason) setImageErr(rejectedReason)
  }, [images, visionSupported])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!visionSupported) return
    const items = Array.from(e.clipboardData?.items ?? [])
    const files = items
      .filter(it => it.kind === 'file' && ACCEPTED_MIME_TYPES.includes(it.type))
      .map(it => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }, [addFiles, visionSupported])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!visionSupported) return
    e.preventDefault()
  }, [visionSupported])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!visionSupported) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }, [visionSupported])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!visionSupported) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }, [visionSupported])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!visionSupported) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    void addFiles(files)
  }, [addFiles, visionSupported])

  const removeImage = (previewUrl: string) => {
    setImages(prev => prev.filter(img => img.previewUrl !== previewUrl))
    setImageErr(null)
  }

  const handleSend = () => {
    onSend(images)
    setImages([])
    setImageErr(null)
  }

  const canSend = (!!input.trim() || images.length > 0) && hasKey && !isBusy && !quotaBlocked

  return (
    <div className={styles.inputArea}>
      <div
        className={`${styles.inputWrap} ${dragActive ? styles.dragActive : ''}`}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {appContextItems.length > 0 && (
          <div className={styles.appContextChipRow}>
            {appContextItems.map(item => (
              <div key={item.id} className={styles.appContextChip} title={item.details}>
                <span className={styles.appContextChipLabel}>{appContextChipLabel(item)}</span>
                <button
                  className={styles.appContextChipRemove}
                  onClick={() => removeAppContext(item.id)}
                  title="Remove from chat"
                  tabIndex={-1}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {images.length > 0 && (
          <div className={styles.imagePreviewRow}>
            {images.map(img => (
              <div key={img.previewUrl} className={styles.imagePreviewThumb}>
                <img src={img.previewUrl} alt="Pasted attachment" />
                <button
                  className={styles.imagePreviewRemove}
                  onClick={() => removeImage(img.previewUrl)}
                  title="Remove image"
                  tabIndex={-1}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {imageError && <div className={styles.imageError}>{imageError}</div>}

        <textarea
          ref={textareaRef}
          className={styles.textarea}
          rows={2}
          placeholder={
            !hasKey ? 'Add Gemini API key in Settings…' :
            quotaBlocked ? (quotaMessage ?? 'Daily request limit reached — try again later.') :
            classifying ? 'Figuring out how to start…' :
            isIndexing ? 'Indexing repository… (edits & terminal commands will queue until it finishes)' :
            'Ask about your code… (Enter to send)'
          }
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          disabled={!hasKey || isBusy || quotaBlocked}
        />
        <div className={styles.inputFooter}>
          <div className={styles.inputFooterLeft}>
            {/* Shortcut chips (@file, @sel, /fix, /doc, /test, …) now live
                only behind the "+" dropdown in every layout — they're
                redundant as always-visible chips since they're one click
                away here, and this keeps the footer from getting crowded
                now that the specialist selector has moved into the
                ACTIONS bar (see AiChat.tsx). */}
            <div className={styles.shortcutsMenu} ref={shortcutsRef}>
              <button
                type="button"
                className={styles.shortcutsPlusBtn}
                onClick={() => setShortcutsOpen(o => !o)}
                disabled={isBusy}
                title="Insert shortcut"
                aria-label="Insert shortcut"
                aria-expanded={shortcutsOpen}
              >
                +
              </button>
              {shortcutsOpen && (
                <div className={styles.shortcutsDropdown}>
                  {HINTS.map(h => (
                    <button
                      key={h}
                      className={styles.shortcutsDropdownItem}
                      onClick={() => {
                        onHintClick(h)
                        setShortcutsOpen(false)
                      }}
                      disabled={isBusy}
                    >
                      {h}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ModelPicker dropUp />
            {isIndexing && (
              <span
                className={styles.indexingWarning}
                title="Indexing in background — edits & terminal commands will queue until it finishes"
              >
                ⟳
              </span>
            )}
            {!visionSupported && (
              <span
                className={styles.imageHint}
                title="This model does not support images"
              >
                ⌗
              </span>
            )}
          </div>

          {streaming
            ? (
              <button className={styles.stopBtn} onClick={onStop} title="Stop generation">
                ■
              </button>
            )
            : (
              <button
                className={styles.sendBtn}
                onClick={handleSend}
                disabled={!canSend}
                title={quotaBlocked ? (quotaMessage ?? 'Daily request limit reached') : 'Send (Enter)'}
              >
                ↑
              </button>
            )
          }
        </div>
      </div>
    </div>
  )
}
