// components/ColorSwatch.tsx
// Detects and renders visual color previews for color values in text.

import React, { useState, useCallback } from 'react'
import styles from './ColorSwatch.module.css'

// ── Color detection regex ──────────────────────────────────────────────────
// Matches: #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(...), rgba(...), hsl(...), hsla(...)
const COLOR_REGEX =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgba?|hsla?)\([^)]+\)/g

// ── Luminance helpers ──────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '')
  let r: number, g: number, b: number

  if (clean.length === 3 || clean.length === 4) {
    r = parseInt(clean[0] + clean[0], 16)
    g = parseInt(clean[1] + clean[1], 16)
    b = parseInt(clean[2] + clean[2], 16)
  } else if (clean.length >= 6) {
    r = parseInt(clean.slice(0, 2), 16)
    g = parseInt(clean.slice(2, 4), 16)
    b = parseInt(clean.slice(4, 6), 16)
  } else {
    return null
  }
  return [r, g, b]
}

function parseRgb(str: string): [number, number, number] | null {
  const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return null
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]
}

function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function getSwatchBorder(color: string): 'light' | 'dark' | 'none' {
  let rgb: [number, number, number] | null = null

  if (color.startsWith('#')) {
    rgb = hexToRgb(color)
  } else if (color.startsWith('rgb')) {
    rgb = parseRgb(color)
  }

  if (!rgb) return 'none'

  const lum = relativeLuminance(...rgb)
  if (lum > 0.85) return 'light'   // Very light — needs dark border
  if (lum < 0.03) return 'dark'    // Very dark — needs light border
  return 'none'
}

// ── Individual ColorSwatch ─────────────────────────────────────────────────
interface ColorSwatchProps {
  color: string
  /** If true, only render the swatch square (no text label) */
  squareOnly?: boolean
}

export function ColorSwatch({ color, squareOnly = false }: ColorSwatchProps) {
  const [copied, setCopied] = useState(false)
  const borderType = getSwatchBorder(color)

  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(color).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }).catch(() => {
      // clipboard might not be available in all contexts
    })
  }, [color])

  return (
    <span
      className={styles.swatchWrapper}
      title={copied ? 'Copied!' : `Click to copy: ${color}`}
      onClick={handleClick}
      data-color={color}
    >
      <span
        className={`${styles.swatchSquare} ${
          borderType === 'light' ? styles.swatchBorderDark :
          borderType === 'dark'  ? styles.swatchBorderLight :
          ''
        }`}
        style={{ backgroundColor: color }}
      />
      {!squareOnly && (
        <span className={styles.swatchLabel}>
          {copied ? '✓' : color}
        </span>
      )}
    </span>
  )
}

// ── Color group row renderer ──────────────────────────────────────────────
// Renders a label + a row of color swatches (used for theme color tables)
interface ColorGroupRowProps {
  label: string
  colors: string[]
}

export function ColorGroupRow({ label, colors }: ColorGroupRowProps) {
  return (
    <span className={styles.colorGroupRow}>
      {label && <span className={styles.colorGroupLabel}>{label}</span>}
      {colors.map((c, i) => (
        <ColorSwatch key={i} color={c} />
      ))}
    </span>
  )
}

// ── Text node with embedded color swatches ─────────────────────────────────
// Parses a string and splits it into plain text + ColorSwatch elements.
interface ColorizedTextProps {
  text: string
  className?: string
}

export function ColorizedText({ text, className }: ColorizedTextProps) {
  // Use a fresh regex instance to avoid global state issues
  const re = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgba?|hsla?)\([^)]+\)/g

  if (!re.test(text)) {
    return <span className={className}>{text}</span>
  }

  re.lastIndex = 0
  const parts: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    // Push preceding text
    if (m.index > last) {
      parts.push(text.slice(last, m.index))
    }
    // Push color swatch
    parts.push(<ColorSwatch key={m.index} color={m[0]} />)
    last = m.index + m[0].length
  }

  // Push remaining text
  if (last < text.length) {
    parts.push(text.slice(last))
  }

  return <span className={className}>{parts}</span>
}

// ── Export the regex for reuse ─────────────────────────────────────────────
export { COLOR_REGEX }
