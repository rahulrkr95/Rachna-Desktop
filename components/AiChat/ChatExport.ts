// components/AiChat/ChatExport.ts
//
// PDF export logic — completely decoupled from React.
// Call exportChatAsPdf(messages) to generate and download a chat PDF.

import type { ChatMessage, StepStatus } from '../../types'
import { isTauri } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { describeIntentLabel, describeSubIntentLabel } from '../../lib/intentClassifier'

// ── Structured, non-`body` message content ─────────────────────────────────
//
// A chat message is more than its `body` string — MessageList also renders
// several structured, intent-tagged pieces of UI (IntentPlanCard,
// ClarificationCard,
// PendingToggleCard, attached images) that live in their own ChatMessage
// fields (see types/index.ts). The exporter used to only ever read `body`,
// so any turn that paused on one of these — most commonly an execution
// plan awaiting approval — exported as a single one-line placeholder like
// "Proposed a 1-step plan." with none of the actual steps. renderExtras
// below mirrors what MessageList shows for each of these fields, in plain
// HTML, so the PDF/print output matches what the user actually saw in the
// chat.

const STEP_STATUS_META: Record<StepStatus, string> = {
  pending:          '○ Pending',
  running:          '◐ Running',
  completed:        '✓ Completed',
  failed:           '✕ Failed',
  completed_manual: '✓ Completed (Manual)',
  cancelled:        '⊘ Cancelled',
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildExportHtml(messages: ChatMessage[]): string {
  const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgba?|hsla?)\([^)]+\)/g

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function colorize(text: string): string {
    COLOR_RE.lastIndex = 0
    return text.replace(COLOR_RE, (c) => {
      const e = esc(c)
      return (
        `<span class="color-swatch" style="display:inline-flex;align-items:center;gap:3px;cursor:default;" title="${e}">` +
        `<span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${e};border:1px solid rgba(0,0,0,0.18);vertical-align:middle;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></span>` +
        `<span style="font-family:monospace;font-size:11px;">${e}</span>` +
        `</span>`
      )
    })
  }

  function inlineFormat(text: string): string {
    let out = esc(text)
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    out = out.replace(
      /(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?=[^a-fA-F0-9]|$))|(?:rgba?\([^)]+\))|(?:hsla?\([^)]+\))/g,
      (c) =>
        `<span style="display:inline-flex;align-items:center;gap:3px;vertical-align:middle;">` +
        `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};border:1px solid rgba(0,0,0,0.2);-webkit-print-color-adjust:exact;print-color-adjust:exact;"></span>` +
        `<span style="font-family:monospace;">${c}</span>` +
        `</span>`
    )
    return out
  }

  function renderText(text: string): string {
    const paras = text.split(/\n{2,}/)
    return paras.map(para => {
      const trimmed = para.trim()
      if (!trimmed) return ''

      const headingM = trimmed.match(/^(#{1,4})\s+(.+)$/)
      if (headingM) {
        const level   = headingM[1].length
        const content = inlineFormat(headingM[2])
        return `<h${level} class="md-h${level}">${content}</h${level}>`
      }

      if (/^[\*\-]\s+/.test(trimmed)) {
        const items  = trimmed.split('\n').filter(l => /^[\*\-]\s+/.test(l.trim()))
        const liHtml = items.map(li => `<li>${inlineFormat(li.replace(/^[\*\-]\s+/, ''))}</li>`).join('')
        return `<ul class="md-ul">${liHtml}</ul>`
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        const items  = trimmed.split('\n').filter(l => /^\d+\.\s+/.test(l.trim()))
        const liHtml = items.map(li => `<li>${inlineFormat(li.replace(/^\d+\.\s+/, ''))}</li>`).join('')
        return `<ol class="md-ol">${liHtml}</ol>`
      }

      if (trimmed.includes('|') && trimmed.includes('\n')) {
        const rows = trimmed.split('\n').filter(r => r.includes('|'))
        if (rows.length >= 2) {
          const headers  = rows[0].split('|').filter(c => c.trim())
          const bodyRows = rows.slice(2)
          const thead    = `<tr>${headers.map(h => `<th>${inlineFormat(h.trim())}</th>`).join('')}</tr>`
          const tbody    = bodyRows.map(r => {
            const cells = r.split('|').filter(c => c.trim())
            return `<tr>${cells.map(c => `<td>${inlineFormat(c.trim())}</td>`).join('')}</tr>`
          }).join('')
          return `<table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`
        }
      }

      const lines = trimmed.split('\n').map(l => inlineFormat(l))
      return `<p class="md-p">${lines.join('<br>')}</p>`
    }).join('')
  }

  function renderBody(body: string): string {
    const lines: string[] = []
    const fenceRe         = /```(\w*)\n?([\s\S]*?)```/g
    let last = 0
    let m: RegExpExecArray | null

    fenceRe.lastIndex = 0
    while ((m = fenceRe.exec(body)) !== null) {
      if (m.index > last) lines.push(renderText(body.slice(last, m.index)))
      const codeLang    = esc(m[1] || 'code')
      const codeContent = colorize(esc(m[2].trimEnd()))
      lines.push(
        `<div class="code-block">` +
        `<div class="code-header">${codeLang}</div>` +
        `<pre class="code-body">${codeContent}</pre>` +
        `</div>`
      )
      last = m.index + m[0].length
    }
    if (last < body.length) lines.push(renderText(body.slice(last)))
    return lines.join('')
  }

  // Renders the structured, non-`body` parts of a message — see the
  // "Structured, non-`body` message content" comment above the imports.
  function renderExtras(m: ChatMessage): string {
    const parts: string[] = []

    if (m.images?.length) {
      parts.push(
        `<div class="extra-block">${m.images.map(() =>
          `<span class="extra-tag">📎 Attached image</span>`).join(' ')}</div>`
      )
    }

    if (m.isDesign) {
      parts.push(`<div class="extra-block"><span class="extra-tag design-tag">🎨 Design</span></div>`)
    }

    if (m.clarification) {
      const c = m.clarification
      const rows: string[] = []
      if (c.correctedText) {
        rows.push(`<p class="md-p"><em>Did you mean:</em> ${inlineFormat(c.correctedText)}${c.useOriginal ? ' <em>(user kept original wording)</em>' : ''}</p>`)
      }
      if (c.questions?.length) {
        rows.push('<ol class="md-ol">' + c.questions.map((q, i) =>
          `<li>${inlineFormat(q)}${c.answers?.[i] ? `<br><strong>Answer:</strong> ${inlineFormat(c.answers[i])}` : ''}</li>`
        ).join('') + '</ol>')
      }
      if (!c.resolved) rows.push(`<p class="md-p"><em>Awaiting user response…</em></p>`)
      parts.push(`<div class="extra-block card-block"><div class="card-title">💬 Clarification</div>${rows.join('')}</div>`)
    }

    if (m.intentPlan) {
      const plan  = m.intentPlan
      const badge = m.planCancelled
        ? '<span class="plan-badge plan-badge-cancelled">✕ Cancelled</span>'
        : m.planApproved
          ? `<span class="plan-badge plan-badge-approved">${m.autoApproved ? '⚡ Auto-approved' : '✓ Approved'}</span>`
          : '<span class="plan-badge plan-badge-pending">Awaiting approval</span>'

      const stepsHtml = plan.steps.map((step, i) => {
        const status = m.planApproved ? (m.stepStatuses?.[step.id] ?? 'pending') : undefined
        const subLabel = describeSubIntentLabel(step.subIntent)
        return `
          <li class="plan-step">
            <div class="plan-step-head">
              <span class="plan-step-index">${i + 1}</span>
              <span class="plan-step-intent">${esc(describeIntentLabel(step.intent))}</span>
              ${subLabel ? `<span class="plan-step-sub">${esc(subLabel)}</span>` : ''}
              ${status ? `<span class="plan-step-status">${STEP_STATUS_META[status]}</span>` : ''}
            </div>
            <p class="plan-step-task">${inlineFormat(step.task)}</p>
            ${step.dependsOn?.length ? `<p class="plan-step-depends">Depends on: ${esc(step.dependsOn.join(', '))}</p>` : ''}
          </li>`
      }).join('')

      parts.push(
        `<div class="extra-block card-block">
          <div class="card-title">📋 Execution Plan (${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'}) ${badge}</div>
          <ol class="plan-steps">${stepsHtml}</ol>
          ${m.executionCancelled ? '<p class="md-p"><em>⊘ Execution was cancelled.</em></p>' : ''}
        </div>`
      )
    }



    if (m.pendingToggle) {
      parts.push(`<div class="extra-block card-block"><div class="card-title">⚙️ Setting confirmation</div>
        <p class="md-p">${esc(m.pendingToggle.label)} — ${m.pendingToggle.resolved ? 'Enabled.' : 'Awaiting user.'}</p></div>`)
    }

    return parts.join('')
  }

  const rows = messages.map(m => {
    const role      = m.role === 'ai' ? '✦ AI Assistant' : '👤 You'
    const roleClass = m.role === 'ai' ? 'ai' : 'user'
    return `
      <div class="msg ${roleClass}">
        <div class="msg-header">
          <span class="msg-role">${role}</span>
          <span class="msg-time">${esc(m.time)}</span>
        </div>
        <div class="msg-body">${renderBody(m.body)}${renderExtras(m)}</div>
      </div>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat Export – Rachna AI Studio</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #ffffff;
    color: #1a1a2e;
    padding: 40px 48px;
    max-width: 860px;
    margin: 0 auto;
    font-size: 13.5px;
    line-height: 1.65;
  }
  .export-header { display:flex;align-items:center;gap:10px;margin-bottom:6px;border-bottom:2px solid #1a56c4;padding-bottom:12px; }
  .export-title  { font-size:18px;font-weight:700;color:#1a56c4; }
  .export-meta   { font-size:11px;color:#888;margin-bottom:28px;margin-top:6px; }
  .msg { margin-bottom:22px;border-radius:10px;overflow:hidden;border:1px solid #e0e6f0;page-break-inside:avoid; }
  .msg-header { display:flex;justify-content:space-between;align-items:center;padding:8px 14px;background:#f4f6fa;border-bottom:1px solid #e0e6f0; }
  .msg.ai .msg-header { background:#e8f0fe; }
  .msg-role { font-size:12px;font-weight:700;color:#2c3e50; }
  .msg.ai .msg-role { color:#1a56c4; }
  .msg-time { font-size:10px;color:#999;font-family:monospace; }
  .msg-body { padding:14px 16px;background:#ffffff; }
  .msg.ai .msg-body { background:#fafcff; }
  .md-p  { margin:6px 0;white-space:pre-wrap;word-break:break-word; }
  .md-h1 { font-size:18px;font-weight:700;margin:12px 0 6px;color:#1a1a2e; }
  .md-h2 { font-size:15px;font-weight:700;margin:10px 0 5px;color:#2c3e50; }
  .md-h3 { font-size:13px;font-weight:700;margin:8px 0 4px;color:#34495e; }
  .md-h4 { font-size:12px;font-weight:700;margin:6px 0 3px;color:#555; }
  .md-ul,.md-ol { padding-left:22px;margin:6px 0; }
  .md-ul li,.md-ol li { margin:3px 0; }
  .md-table { border-collapse:collapse;width:100%;margin:10px 0;font-size:12px; }
  .md-table th,.md-table td { border:1px solid #dde3ed;padding:6px 10px;text-align:left; }
  .md-table th { background:#eef2fa;font-weight:700; }
  .md-table tr:nth-child(even) { background:#f7f9fd; }
  .code-block { background:#1e1e2e;border-radius:6px;overflow:hidden;margin:8px 0;border:1px solid #2d3250;page-break-inside:avoid; }
  .code-header { background:#16162a;color:#6272a4;padding:4px 12px;font-size:10px;font-family:monospace;letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid #2d3250; }
  .code-body { padding:12px 14px;font-family:'Courier New',Courier,monospace;font-size:12px;line-height:1.75;color:#cdd6f4;overflow-x:auto;white-space:pre;-webkit-print-color-adjust:exact;print-color-adjust:exact; }
  .inline-code { font-family:'Courier New',monospace;font-size:11.5px;background:#eef2fa;color:#1a56c4;padding:1px 5px;border-radius:3px;border:1px solid #d0daf0; }
  .extra-block { margin-top:10px; }
  .extra-tag { display:inline-block;font-size:11px;font-weight:600;color:#555;background:#f0f2f7;border:1px solid #dde3ed;border-radius:6px;padding:3px 8px;margin-right:6px; }
  .extra-tag.design-tag { color:#7c3aed;background:rgba(124,58,237,0.08);border-color:rgba(124,58,237,0.3); }
  .card-block { border:1px solid #dde3ed;border-radius:8px;padding:10px 12px;background:#f9fafc;page-break-inside:avoid; }
  .card-title { font-size:12px;font-weight:700;color:#2c3e50;margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
  .plan-badge { font-size:10px;font-weight:700;border-radius:10px;padding:2px 8px;letter-spacing:.02em; }
  .plan-badge-approved { color:#1a7f37;background:rgba(26,127,55,0.1); }
  .plan-badge-cancelled { color:#b42318;background:rgba(180,35,24,0.1); }
  .plan-badge-pending { color:#a35a00;background:rgba(163,90,0,0.1); }
  .plan-steps { list-style:none;padding:0;margin:0; }
  .plan-step { border:1px solid #e0e6f0;border-radius:6px;padding:8px 10px;margin:6px 0;background:#ffffff;page-break-inside:avoid; }
  .plan-step-head { display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px; }
  .plan-step-index { display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#1a56c4;color:#fff;font-size:10px;font-weight:700; }
  .plan-step-intent { font-size:10.5px;font-weight:700;color:#1a56c4;background:rgba(26,86,196,0.1);border-radius:5px;padding:2px 6px; }
  .plan-step-sub { font-size:10.5px;color:#555;background:#eef1f6;border-radius:5px;padding:2px 6px; }
  .plan-step-status { margin-left:auto;font-size:10.5px;font-weight:700;color:#444; }
  .plan-step-task { font-size:12.5px;margin:2px 0 0; }
  .plan-step-depends { font-size:10.5px;color:#888;margin-top:3px; }
  @media print {
    body { padding:24px 32px; }
    .msg,.code-block { page-break-inside:avoid; }
    * { -webkit-print-color-adjust:exact !important;print-color-adjust:exact !important; }
  }
</style>
</head>
<body>
<div class="export-header">
  <span class="export-title">✦ Rachna AI Studio – Chat Export</span>
</div>
<div class="export-meta">Exported on ${new Date().toLocaleString()} · ${messages.length} messages</div>
${rows}
</body>
</html>`
}

// ── exportChatAsPdf ────────────────────────────────────────────────────────────

export async function exportChatAsPdf(messages: ChatMessage[]): Promise<void> {
  if (messages.length === 0) return

  const html    = buildExportHtml(messages)
  // `window.__TAURI__` is only injected when `app.withGlobalTauri` is set
  // in tauri.conf.json (it isn't here), so that check was always false —
  // meaning every export, even inside the built desktop app, silently fell
  // through to the browser `window.open()` + `print()` path below. That
  // path calls `window.open()`, which the app has no window-creation
  // permission for, so it returns null/does nothing — the button appeared
  // to do nothing. `isTauri()` from `@tauri-apps/api/core` reads
  // `globalThis.isTauri`, which the Tauri runtime always sets regardless
  // of `withGlobalTauri`, so this correctly routes to the html2canvas +
  // jsPDF path (which saves a real PDF via a Blob download, no new window
  // needed) whenever the app is actually running inside Tauri.
  const runningInTauri = typeof window !== 'undefined' && isTauri()

  if (runningInTauri) {
    try {
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      const iframe = document.createElement('iframe')
      iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:860px;height:1px;opacity:0;border:none;'
      document.body.appendChild(iframe)

      await new Promise<void>((resolve) => {
        iframe.onload = () => resolve()
        iframe.srcdoc = html
      })
      await new Promise(r => setTimeout(r, 600))

      const doc        = iframe.contentDocument!
      const body       = doc.body
      const fullHeight = body.scrollHeight
      iframe.style.height = fullHeight + 'px'
      await new Promise(r => setTimeout(r, 200))

      const canvas = await html2canvas(body, {
        scale: 2, useCORS: true, logging: false,
        width: 860, height: fullHeight,
        windowWidth: 860, windowHeight: fullHeight,
      })
      document.body.removeChild(iframe)

      const PDF_WIDTH_MM  = 210
      const PDF_HEIGHT_MM = 297
      const imgWidthPx    = canvas.width
      const imgHeightPx   = canvas.height
      const ratio         = PDF_WIDTH_MM / imgWidthPx

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      let yOffset = 0

      while (yOffset < imgHeightPx) {
        const pageHeightPx = PDF_HEIGHT_MM / ratio
        const sliceHeight  = Math.min(pageHeightPx, imgHeightPx - yOffset)
        const sliceCanvas  = document.createElement('canvas')
        sliceCanvas.width  = imgWidthPx
        sliceCanvas.height = sliceHeight
        sliceCanvas.getContext('2d')!.drawImage(
          canvas, 0, yOffset, imgWidthPx, sliceHeight, 0, 0, imgWidthPx, sliceHeight
        )
        if (yOffset > 0) pdf.addPage()
        pdf.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', 0, 0, PDF_WIDTH_MM, sliceHeight * ratio)
        yOffset += pageHeightPx
      }

      // Let the user choose where the PDF goes, instead of jsPDF's default
      // `.save()` (which silently drops it into the OS downloads folder
      // with no picker). Falls back to that default only if the user's
      // Tauri version can't show the dialog for some reason.
      const defaultName = `rachna-chat-${Date.now()}.pdf`
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
      })

      if (!targetPath) {
        // User cancelled the save dialog — nothing to do.
        return
      }

      const bytes = new Uint8Array(pdf.output('arraybuffer'))
      await writeFile(targetPath, bytes)
    } catch (err) {
      console.error('[exportChatAsPdf] Tauri PDF export failed:', err)
      alert('PDF export failed. Please try again.\n\n' + String(err))
    }
  } else {
    const win = window.open('', '_blank', 'width=900,height=700')
    if (!win) {
      alert('Unable to open PDF preview. Please allow pop-ups for this site.')
      return
    }
    win.document.open()
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => {
      try { win.print() } catch { /* blocked */ }
    }, 500)
  }
}
