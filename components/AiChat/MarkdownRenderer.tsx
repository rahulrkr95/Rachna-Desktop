// components/AiChat/MarkdownRenderer.tsx
//
// Renders AI response bodies as actual formatted Markdown (headings, bold/
// italic, lists, links, blockquotes, tables, fenced code blocks, etc.)
// instead of dumping the raw Markdown source into the chat — plus the
// studio-specific extras layered on top: inline color swatches, clickable
// file-path references, the "long code as attachment/collapsible card"
// treatment, and the message copy button.

import React, { useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ColorSwatch } from '../ColorSwatch'
import styles from '../AiChat.module.css'
import { useOpenFileLink, useFileLinkStatus } from './useFileLink'
import { useAttachmentViewer, hashContent } from '../../store/useAttachmentViewer'

// ── Color regex (stateless factory) ───────────────────────────────────────────

function colorRe() {
  return /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgba?|hsla?)\([^)]+\)/g
}

// ── File Reference Link ──────────────────────────────────────────────────────

function FileReference({ path }: { path: string }) {
  // Split on the LAST colon that is followed only by digits (line number)
  // so Windows absolute paths like C:\foo\bar.ts are not broken.
  const lineMatch = path.match(/^(.*):(\d+)$/)
  const filePath  = lineMatch ? lineMatch[1] : path
  const line      = lineMatch ? parseInt(lineMatch[2], 10) : undefined

  const openFile = useOpenFileLink()
  const status   = useFileLinkStatus(filePath)

  // While we haven't confirmed the file exists yet, render as plain text
  // to avoid showing a clickable link that goes nowhere.
  if (status === 'missing') {
    return <span className={styles.fileRefMissing}>{path}</span>
  }

  const handleClick = () => {
    if (status !== 'exists') return
    openFile(filePath, line)
  }

  return (
    <span
      className={
        status === 'exists'
          ? styles.fileRef
          : styles.fileRefPending
      }
      onClick={handleClick}
      title={
        status === 'exists'
          ? `Open ${filePath}${line ? ` at line ${line}` : ''}`
          : 'Checking file…'
      }
    >
      {path}
    </span>
  )
}

// ── Plain-text inline extras: file references + color swatches ──────────────
// Applied to the raw string children of block-level Markdown elements (p,
// li, headings, table cells). Nested inline formatting produced by Markdown
// itself (bold/italic/links/inline-code) is left as react-markdown renders
// it — only literal text runs get the file-ref/color treatment.

function renderColorSwatches(text: string, key: string): React.ReactNode {
  const re = colorRe()
  re.lastIndex = 0
  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(<ColorSwatch key={`cs-${key}-${m.index}`} color={m[0]} />)
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

function processTextSegment(text: string, key: number | string): React.ReactNode {
  // Regex to detect file references like src/App.tsx or components/Button.tsx:42
  const fileRefRe = /((?:\w[\w.-]*\/)*\w[\w.-]+\.(?:ts|tsx|js|jsx|css|md|json|html|go|py|sh|txt))(?::(\d+))?/g

  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null

  while ((m = fileRefRe.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(renderColorSwatches(text.slice(last, m.index), `${key}-${last}`))
    }
    nodes.push(<FileReference key={`fr-${key}-${m.index}`} path={m[0]} />)
    last = m.index + m[0].length
  }
  if (last < text.length) {
    nodes.push(renderColorSwatches(text.slice(last), `${key}-${last}`))
  }
  return <React.Fragment key={key}>{nodes}</React.Fragment>
}

/** Walk the top-level children of a Markdown block element, running plain
 *  string runs through file-ref/color processing and leaving any nested
 *  elements (produced by **bold**, _em_, links, inline code, …) untouched. */
function processChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child, i) =>
    typeof child === 'string' ? processTextSegment(child, i) : child
  )
}

// ── Extension guess for the collapsed "file" card ──────────────────────────

const LANG_EXT: Record<string, string> = {
  javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx', python: 'py',
  rust: 'rs', go: 'go', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs',
  html: 'html', css: 'css', json: 'json', yaml: 'yml', yml: 'yml',
  markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh',
  sql: 'sql', xml: 'xml', toml: 'toml', text: 'txt',
}

function guessFileName(lang: string): string {
  const ext = LANG_EXT[lang.toLowerCase()] || lang.toLowerCase() || 'txt'
  return `snippet.${ext}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

// ── Code block line (with color swatches) ─────────────────────────────────────

function CodeBlockLine({ text }: { text: string }) {
  const re = colorRe()
  if (!re.test(text)) return <>{text}</>
  re.lastIndex = 0
  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(<ColorSwatch key={m.index} color={m[0]} />)
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

// ── CodeBlock ─────────────────────────────────────────────────────────────────

// Long code blocks are collapsed into a compact "file" card by default —
// mirroring how ChatGPT/Claude embed long generated content as a file
// attachment rather than dumping hundreds of lines straight into the chat
// flow. Short snippets still render inline as before.
const LONG_CONTENT_LINE_THRESHOLD = 25
const LONG_CONTENT_CHAR_THRESHOLD = 1500

// Beyond this size a block stops being an inline-expandable card and
// becomes a true "attachment": a small, permanent chip that never dumps
// its content into the chat. Clicking it opens the AttachmentViewerPanel
// instead — same idea as Claude/ChatGPT surfacing long generated files as
// attachments rather than message clutter.
const ATTACHMENT_LINE_THRESHOLD = 100
const ATTACHMENT_CHAR_THRESHOLD = 6000

export function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false)
  const openAttachment = useAttachmentViewer(s => s.openAttachment)

  const lines = content.trimEnd().split('\n')
  const isAttachment = lines.length > ATTACHMENT_LINE_THRESHOLD || content.length > ATTACHMENT_CHAR_THRESHOLD
  const isLong = lines.length > LONG_CONTENT_LINE_THRESHOLD || content.length > LONG_CONTENT_CHAR_THRESHOLD
  const [expanded, setExpanded] = useState(!isLong)

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  if (isAttachment) {
    const fileName = guessFileName(lang)
    const id = hashContent(`${lang}:${content}`)
    const openPanel = () => openAttachment({ id, fileName, lang, content })

    return (
      <div className={styles.codeFileCard}>
        <div className={styles.codeFileHeader} onClick={openPanel}>
          <span className={styles.codeFileIcon}>📎</span>
          <div className={styles.codeFileInfo}>
            <span className={styles.codeFileName}>{fileName}</span>
            <span className={styles.codeFileMeta}>{lines.length} lines · {formatSize(content.length)} · attachment</span>
          </div>
          <div className={styles.codeFileActions}>
            <button
              className={styles.codeFileToggle}
              onClick={e => { e.stopPropagation(); handleCopy() }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              className={styles.codeFileToggle}
              onClick={e => { e.stopPropagation(); openPanel() }}
            >
              Open
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (isLong && !expanded) {
    return (
      <div className={styles.codeFileCard}>
        <div className={styles.codeFileHeader} onClick={() => setExpanded(true)}>
          <span className={styles.codeFileIcon}>📄</span>
          <div className={styles.codeFileInfo}>
            <span className={styles.codeFileName}>{guessFileName(lang)}</span>
            <span className={styles.codeFileMeta}>{lines.length} lines · {formatSize(content.length)}</span>
          </div>
          <div className={styles.codeFileActions}>
            <button
              className={styles.codeFileToggle}
              onClick={e => { e.stopPropagation(); handleCopy() }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              className={styles.codeFileToggle}
              onClick={e => { e.stopPropagation(); setExpanded(true) }}
            >
              Expand
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeLang}>{lang || 'code'}</span>
        <div className={styles.codeFileActions}>
          {isLong && (
            <button className={styles.copyBtn} onClick={() => setExpanded(false)}>
              Collapse
            </button>
          )}
          <button className={styles.copyBtn} onClick={handleCopy}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre className={styles.codeBlockBody}>
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            <CodeBlockLine text={line} />
            {i < lines.length - 1 && '\n'}
          </React.Fragment>
        ))}
      </pre>
    </div>
  )
}

// ── MessageCopyBtn ─────────────────────────────────────────────────────────────

export function MessageCopyBtn({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      className={styles.msgCopyBtn}
      onClick={handleCopy}
      title="Copy message"
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

// ── Markdown component overrides ─────────────────────────────────────────────
// Maps standard Markdown elements to the studio's styling, and — for the
// text-bearing ones — runs their content through the file-ref/color-swatch
// post-processing above.

const markdownComponents: Components = {
  p:  ({ children }) => <p className={styles.msgText}>{processChildren(children)}</p>,
  li: ({ children }) => <li>{processChildren(children)}</li>,
  h1: ({ children }) => <h1>{processChildren(children)}</h1>,
  h2: ({ children }) => <h2>{processChildren(children)}</h2>,
  h3: ({ children }) => <h3>{processChildren(children)}</h3>,
  h4: ({ children }) => <h4>{processChildren(children)}</h4>,
  h5: ({ children }) => <h5>{processChildren(children)}</h5>,
  h6: ({ children }) => <h6>{processChildren(children)}</h6>,
  th: ({ children }) => <th>{processChildren(children)}</th>,
  td: ({ children }) => <td>{processChildren(children)}</td>,
  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={styles.mdLink}>
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className={styles.mdTableWrap}>
      <table>{children}</table>
    </div>
  ),
  // react-markdown normally wraps code blocks in <pre><code>; CodeBlock
  // already supplies its own wrapper/chrome, so <pre> is a pass-through.
  pre: ({ children }) => <>{children}</>,
  code(props) {
    const { className, children } = props as { className?: string; children?: React.ReactNode }
    const match = /language-(\w+)/.exec(className || '')
    const raw = String(children ?? '')
    const isBlock = Boolean(match) || raw.includes('\n')
    if (!isBlock) {
      return <code className={styles.inlineCode}>{children}</code>
    }
    return <CodeBlock lang={match ? match[1] : 'text'} content={raw.replace(/\n$/, '')} />
  },
}

// ── MessageBody ────────────────────────────────────────────────────────────────

export function MessageBody({ body, streaming }: { body: string; streaming?: boolean }) {
  return (
    <div className={styles.msgBodyInner}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {body}
      </ReactMarkdown>
      {streaming && <span className={styles.cursor} />}
    </div>
  )
}
