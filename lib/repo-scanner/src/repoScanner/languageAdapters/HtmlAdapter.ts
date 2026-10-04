// lib/repoScanner/languageAdapters/HtmlAdapter.ts
//
// LanguageAdapter for HTML and HTML-template files.
//
// Extracted as symbols (visible to AI semantic search):
//   - HTML element ids            → kind: 'variable'   e.g. #main-nav
//   - HTML element classes        → kind: 'style-rule'  e.g. .card, .btn-primary
//   - Custom elements / web comps → kind: 'component'   e.g. <my-button>
//   - <template id="...">         → kind: 'component'
//   - <form id/name/action>       → kind: 'variable'
//   - data-* attribute names      → kind: 'variable'
//   - Headings h1–h6              → kind: 'namespace'   (page structure)
//   - ARIA role="..."             → kind: 'variable'
//   - Semantic landmarks          → kind: 'namespace'   (nav, main, aside, header, footer)
//   - <meta name/property>        → kind: 'variable'
//   - Inline <style> blocks       → delegated class/id extraction
//   - Inline <script> function definitions → kind: 'function'
//   - <input name/id>, <select name/id>, <textarea name/id> → kind: 'variable'
//   - <a name="...">              → kind: 'variable'
//   - <slot name="...">           → kind: 'variable'    (web component slots)
//
// Extracted as imports (linked resources visible to graph):
//   - <script src="...">
//   - <link href="...">           (stylesheets)
//   - <img src="...">
//   - <source src="...">          (video/audio/picture)
//   - <use href="...">            (SVG sprite references)
//
// Extracted as exports:
//   - <script type="module" export> (web component registrations)
//
// CSS selector extraction in inline <style> blocks is handled here
// to avoid requiring a separate CSS pass for single-file HTML.

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

// Semantic landmark tags that represent page structure
const LANDMARK_TAGS = new Set(['main', 'nav', 'aside', 'header', 'footer', 'section', 'article', 'dialog', 'aside'])

export class HtmlAdapter implements LanguageAdapter {
  readonly name = 'HTML'
  readonly extensions = ['html', 'htm', 'xhtml', 'shtml'] as const

  // ── extractSymbols ──────────────────────────────────────────────────────
  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    // Normalise line-endings and work on the flattened string for multi-line
    // attribute matching, but also keep line-indexed array for line numbers.
    const normalised = content.replace(/\r\n?/g, '\n')
    const lines = normalised.split('\n')

    const seenIds      = new Set<string>()
    const seenClasses  = new Set<string>()
    const seenCustomEl = new Set<string>()
    const seenMisc     = new Set<string>()

    // Helper: push a symbol only if key not seen yet
    const push = (key: string, sym: Symbol) => {
      if (seenMisc.has(key)) return
      seenMisc.add(key)
      symbols.push(sym)
    }

    // ── Pass 1: line-by-line extraction ───────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      const line    = lines[i]

      let m: RegExpExecArray | null

      // ── id="..." → variable ─────────────────────────────────────────────
      const idRe = /\bid=["']([^"']+)["']/g
      while ((m = idRe.exec(line)) !== null) {
        const id = m[1].trim()
        if (id && !seenIds.has(id)) {
          seenIds.add(id)
          symbols.push({ name: `#${id}`, kind: 'variable', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── class="..." → style-rule ────────────────────────────────────────
      const classRe = /\bclass=["']([^"']+)["']/g
      while ((m = classRe.exec(line)) !== null) {
        for (const cls of m[1].split(/\s+/).filter(Boolean)) {
          if (!seenClasses.has(cls)) {
            seenClasses.add(cls)
            symbols.push({ name: `.${cls}`, kind: 'style-rule', startLine: lineNum, endLine: lineNum })
          }
        }
      }

      // ── Custom elements: <my-element ...> ──────────────────────────────
      const customElRe = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g
      while ((m = customElRe.exec(line)) !== null) {
        const tag = m[1]
        if (!seenCustomEl.has(tag)) {
          seenCustomEl.add(tag)
          symbols.push({ name: tag, kind: 'component', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── <template id="..."> → component ────────────────────────────────
      const templateRe = /<template[^>]+\bid=["']([^"']+)["']/g
      while ((m = templateRe.exec(line)) !== null) {
        const key = `template:${m[1]}`
        push(key, { name: `template#${m[1]}`, kind: 'component', startLine: lineNum, endLine: lineNum })
      }

      // ── data-* attributes ───────────────────────────────────────────────
      const dataRe = /\b(data-[a-z][a-z0-9-]*)=["'][^"']*["']/g
      while ((m = dataRe.exec(line)) !== null) {
        push(`data:${m[1]}`, { name: m[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // ── <title>...</title> ──────────────────────────────────────────────
      const titleM = line.match(/<title[^>]*>([^<]+)<\/title>/i)
      if (titleM) {
        const title = titleM[1].trim()
        if (title) push(`title:${title}`, { name: `title: ${title}`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // ── Headings h1–h6 → namespace (page outline) ──────────────────────
      const headingM = line.match(/<(h[1-6])[^>]*>([^<]{1,120})/i)
      if (headingM) {
        const level = headingM[1].toLowerCase()
        const text  = headingM[2].replace(/<[^>]+>/g, '').trim()
        if (text) push(`heading:${text}`, { name: `${level}: ${text}`, kind: 'namespace', startLine: lineNum, endLine: lineNum })
      }

      // ── ARIA role="..." → variable ──────────────────────────────────────
      const ariaRoleRe = /\brole=["']([^"']+)["']/g
      while ((m = ariaRoleRe.exec(line)) !== null) {
        for (const role of m[1].split(/\s+/).filter(Boolean)) {
          push(`aria-role:${role}`, { name: `role="${role}"`, kind: 'variable', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── aria-label="..." → variable (accessible labels) ─────────────────
      const ariaLabelRe = /\baria-label=["']([^"']{1,80})["']/g
      while ((m = ariaLabelRe.exec(line)) !== null) {
        const label = m[1].trim()
        if (label) push(`aria-label:${label}`, { name: `aria-label: ${label}`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // ── Landmark tags: <nav>, <main>, <header>, <footer> etc. ──────────
      const landmarkTagRe = /<(main|nav|aside|header|footer|section|article|dialog)(?:\s[^>]*)?>/ 
      const landmarkM = line.match(landmarkTagRe)
      if (landmarkM) {
        const tag = landmarkM[1].toLowerCase()
        // Only record once per tag type unless it has an id (already captured)
        const idOnLine = line.match(/\bid=["']([^"']+)["']/)
        const label = idOnLine ? `${tag}#${idOnLine[1]}` : tag
        push(`landmark:${label}`, { name: `<${label}>`, kind: 'namespace', startLine: lineNum, endLine: lineNum })
      }

      // ── <meta name/property> → variable ────────────────────────────────
      const metaNameRe = /<meta[^>]+\b(?:name|property)=["']([^"']+)["']/gi
      while ((m = metaNameRe.exec(line)) !== null) {
        push(`meta:${m[1]}`, { name: `meta:${m[1]}`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // ── <form name="..." / action="..."> ────────────────────────────────
      const formM = line.match(/<form[^>]+>/)
      if (formM) {
        const nameM   = line.match(/\bname=["']([^"']+)["']/)
        const actionM = line.match(/\baction=["']([^"']+)["']/)
        if (nameM)   push(`form:${nameM[1]}`,   { name: `form[name="${nameM[1]}"]`,   kind: 'variable', startLine: lineNum, endLine: lineNum })
        if (actionM) push(`form-action:${actionM[1]}`, { name: `form[action="${actionM[1]}"]`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // ── Form inputs: <input>, <select>, <textarea> name/id ──────────────
      const inputTagRe = /<(?:input|select|textarea|button)[^>]+>/gi
      let inputM: RegExpExecArray | null
      while ((inputM = inputTagRe.exec(line)) !== null) {
        const tag     = inputM[0]
        const typeM   = tag.match(/\btype=["']([^"']+)["']/)
        const nameM   = tag.match(/\bname=["']([^"']+)["']/)
        const suffix  = typeM ? `[type="${typeM[1]}"]` : ''
        if (nameM) push(`input:${nameM[1]}`, { name: `input[name="${nameM[1]}"]${suffix}`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // ── <slot name="..."> → variable (Shadow DOM) ───────────────────────
      const slotRe = /<slot[^>]+\bname=["']([^"']+)["']/g
      while ((m = slotRe.exec(line)) !== null) {
        push(`slot:${m[1]}`, { name: `slot[name="${m[1]}"]`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // ── <a name="..."> → anchor variable ────────────────────────────────
      const anchorRe = /<a[^>]+\bname=["']([^"']+)["']/g
      while ((m = anchorRe.exec(line)) !== null) {
        push(`anchor:${m[1]}`, { name: `a[name="${m[1]}"]`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }
    }

    // ── Pass 2: inline <script> function extraction ────────────────────────
    // Handles function declarations/expressions in embedded scripts
    const scriptBlocks = [...normalised.matchAll(/<script(?:[^>](?!src=))*>([^]*?)<\/script>/gi)]
    for (const block of scriptBlocks) {
      const scriptStart = normalised.lastIndexOf(block[0])
      const scriptContent = block[1]
      const lineOffset = normalised.substring(0, scriptStart).split('\n').length

      const fnRe = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
      let fm: RegExpExecArray | null
      while ((fm = fnRe.exec(scriptContent)) !== null) {
        const fnLine = lineOffset + scriptContent.substring(0, fm.index).split('\n').length
        push(`jsfn:${fm[1]}`, { name: `function ${fm[1]}()`, kind: 'function', startLine: fnLine, endLine: fnLine })
      }

      // Arrow / const fn = () => {}
      const arrowRe = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\(/g
      while ((fm = arrowRe.exec(scriptContent)) !== null) {
        const fnLine = lineOffset + scriptContent.substring(0, fm.index).split('\n').length
        push(`jsfn:${fm[1]}`, { name: `function ${fm[1]}()`, kind: 'function', startLine: fnLine, endLine: fnLine })
      }
    }

    // ── Pass 3: inline <style> class/id extraction ─────────────────────────
    const styleBlocks = [...normalised.matchAll(/<style[^>]*>([^]*?)<\/style>/gi)]
    for (const block of styleBlocks) {
      const styleStart   = normalised.lastIndexOf(block[0])
      const styleContent = block[1]
      const lineOffset   = normalised.substring(0, styleStart).split('\n').length

      const cssClassRe = /\.([A-Za-z_-][A-Za-z0-9_-]*)(?:[:\s[{,]|$)/g
      let cm: RegExpExecArray | null
      while ((cm = cssClassRe.exec(styleContent)) !== null) {
        const cls     = cm[1]
        const cssLine = lineOffset + styleContent.substring(0, cm.index).split('\n').length
        if (!seenClasses.has(cls)) {
          seenClasses.add(cls)
          symbols.push({ name: `.${cls}`, kind: 'style-rule', startLine: cssLine, endLine: cssLine })
        }
      }

      const cssIdRe = /#([A-Za-z_-][A-Za-z0-9_-]*)(?:[:\s[{,]|$)/g
      while ((cm = cssIdRe.exec(styleContent)) !== null) {
        const id      = cm[1]
        const cssLine = lineOffset + styleContent.substring(0, cm.index).split('\n').length
        if (!seenIds.has(id)) {
          seenIds.add(id)
          symbols.push({ name: `#${id}`, kind: 'variable', startLine: cssLine, endLine: cssLine })
        }
      }

      const cssVarRe = /(--[A-Za-z_-][A-Za-z0-9_-]*)\s*:/g
      while ((cm = cssVarRe.exec(styleContent)) !== null) {
        const cssLine = lineOffset + styleContent.substring(0, cm.index).split('\n').length
        push(`cssvar:${cm[1]}`, { name: cm[1], kind: 'variable', startLine: cssLine, endLine: cssLine })
      }
    }

    return symbols
  }

  // ── extractImports ──────────────────────────────────────────────────────
  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const seen = new Set<string>()

    // <script src="...">
    const scriptRe = /<script[^>]+\bsrc=["']([^"']+)["']/gi
    let m: RegExpExecArray | null
    while ((m = scriptRe.exec(content)) !== null) {
      const src = m[1]
      if (!seen.has(src)) {
        seen.add(src)
        imports.push({
          specifier: src,
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: src.startsWith('.') || src.startsWith('/'),
        })
      }
    }

    // <link rel="stylesheet" href="..."> and <link href="...">
    const linkRe = /<link[^>]+\bhref=["']([^"']+)["'][^>]*>/gi
    while ((m = linkRe.exec(content)) !== null) {
      const href = m[1]
      // Only care about stylesheets and modulepreload, skip canonical/alternate
      const fullTag = m[0]
      const isStylesheet = /rel=["'][^"']*stylesheet[^"']*["']/i.test(fullTag)
      const isPreload = /rel=["'][^"']*(?:preload|modulepreload)[^"']*["']/i.test(fullTag)
      if ((isStylesheet || isPreload) && !seen.has(href)) {
        seen.add(href)
        imports.push({
          specifier: href,
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: href.startsWith('.') || href.startsWith('/'),
        })
      }
    }

    // <img src="..."> — track image dependencies
    const imgRe = /<img[^>]+\bsrc=["']([^"']+)["']/gi
    while ((m = imgRe.exec(content)) !== null) {
      const src = m[1]
      if (!seen.has(src) && !src.startsWith('data:') && !src.startsWith('http')) {
        seen.add(src)
        imports.push({
          specifier: src,
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: true,
        })
      }
    }

    // <source src="..."> / <source srcset="..."> — video/audio/picture deps
    const srcsetRe = /<source[^>]+\bsrc(?:set)?=["']([^"']+)["']/gi
    while ((m = srcsetRe.exec(content)) !== null) {
      // srcset can be comma-separated, grab first URL
      const first = m[1].split(',')[0].trim().split(/\s+/)[0]
      if (first && !seen.has(first) && !first.startsWith('data:') && !first.startsWith('http')) {
        seen.add(first)
        imports.push({
          specifier: first,
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: first.startsWith('.') || first.startsWith('/'),
        })
      }
    }

    // <use href="..."> / <use xlink:href="..."> — SVG sprite references
    const useRe = /<use[^>]+\b(?:xlink:)?href=["']([^"'#][^"']*)["']/gi
    while ((m = useRe.exec(content)) !== null) {
      const href = m[1]
      if (!seen.has(href)) {
        seen.add(href)
        imports.push({
          specifier: href,
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: href.startsWith('.') || href.startsWith('/'),
        })
      }
    }

    return imports
  }

  // ── extractExports ──────────────────────────────────────────────────────
  extractExports(content: string): Export[] {
    const exports: Export[] = []

    // customElements.define('my-element', ...) in inline scripts
    const defineRe = /customElements\.define\s*\(\s*["']([^"']+)["']/g
    let m: RegExpExecArray | null
    while ((m = defineRe.exec(content)) !== null) {
      exports.push({ name: m[1], kind: 'default' })
    }

    return exports
  }

  // ── extractReferences ───────────────────────────────────────────────────
  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // onclick="fnName()" / oninput="fnName()" etc. → JS function references
      const handlerRe = /\bon\w+=["']([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g
      let m: RegExpExecArray | null
      while ((m = handlerRe.exec(line)) !== null) {
        refs.push({ symbolName: m[1], line: i + 1, fromSpecifier: null })
      }

      // href="#id" → id references
      const hrefIdRe = /\bhref=["']#([^"']+)["']/g
      while ((m = hrefIdRe.exec(line)) !== null) {
        refs.push({ symbolName: `#${m[1]}`, line: i + 1, fromSpecifier: null })
      }
    }

    return refs
  }
}