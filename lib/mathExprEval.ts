// lib/mathExprEval.ts
//
// A tiny, safe, allow-listed math-expression evaluator — a TypeScript mirror
// of the Rust `expr` module in src-tauri/src/input_control.rs.
//
// Purpose: `mouse_drag_path` (services/agent/tools/inputControlTools.ts)
// takes xEquation/yEquation as functions of `t` and samples them on the
// Rust side to produce the actual drag. To draw the "outline/curve" preview
// on the InputActionOverlay *before* that native call runs, we need to
// sample the same equations on the frontend. This evaluator is NOT used to
// decide anything — it is purely cosmetic preview math, per the same
// grammar as the Rust evaluator: numbers, the variable `t`, the constants
// pi/e, +-*/^, unary +/-, parentheses, and a small function allow-list
// (sin, cos, tan, sqrt, abs, exp, ln, log10, floor, ceil, round, pow, min,
// max). No `eval`/`Function` is used, so there is no code-execution surface.

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '^' | ',' | '(' | ')' }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if ('+-*/^,()'.includes(c)) {
      out.push({ kind: 'op', value: c as any })
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      let s = ''
      while (i < src.length && /[0-9.]/.test(src[i])) {
        s += src[i]
        i++
      }
      const n = Number(s)
      if (!Number.isFinite(n)) throw new Error(`Invalid number "${s}".`)
      out.push({ kind: 'num', value: n })
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      let s = ''
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) {
        s += src[i]
        i++
      }
      out.push({ kind: 'ident', value: s })
      continue
    }
    throw new Error(`Unexpected character '${c}' in equation.`)
  }
  return out
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  pow: (a, b) => Math.pow(a, b),
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
}

class Parser {
  private pos = 0
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++]
  }
  private expectOp(op: string) {
    const t = this.next()
    if (!t || t.kind !== 'op' || t.value !== op) {
      throw new Error(`Expected "${op}" in equation.`)
    }
  }

  parse(t: number): number {
    const v = this.parseExpr(t)
    if (this.pos !== this.tokens.length) throw new Error('Unexpected trailing input in equation.')
    return v
  }

  // expr := term (('+' | '-') term)*
  private parseExpr(t: number): number {
    let v = this.parseTerm(t)
    for (;;) {
      const tok = this.peek()
      if (tok?.kind === 'op' && (tok.value === '+' || tok.value === '-')) {
        this.next()
        const rhs = this.parseTerm(t)
        v = tok.value === '+' ? v + rhs : v - rhs
      } else break
    }
    return v
  }

  // term := unary (('*' | '/') unary)*
  private parseTerm(t: number): number {
    let v = this.parseUnary(t)
    for (;;) {
      const tok = this.peek()
      if (tok?.kind === 'op' && (tok.value === '*' || tok.value === '/')) {
        this.next()
        const rhs = this.parseUnary(t)
        v = tok.value === '*' ? v * rhs : v / rhs
      } else break
    }
    return v
  }

  // unary := ('+' | '-') unary | power
  private parseUnary(t: number): number {
    const tok = this.peek()
    if (tok?.kind === 'op' && (tok.value === '+' || tok.value === '-')) {
      this.next()
      const v = this.parseUnary(t)
      return tok.value === '-' ? -v : v
    }
    return this.parsePower(t)
  }

  // power := atom ('^' unary)?  (right-associative)
  private parsePower(t: number): number {
    const base = this.parseAtom(t)
    const tok = this.peek()
    if (tok?.kind === 'op' && tok.value === '^') {
      this.next()
      const exp = this.parseUnary(t)
      return Math.pow(base, exp)
    }
    return base
  }

  // atom := number | ident | ident '(' args ')' | '(' expr ')'
  private parseAtom(t: number): number {
    const tok = this.next()
    if (!tok) throw new Error('Unexpected end of equation.')
    if (tok.kind === 'num') return tok.value
    if (tok.kind === 'op' && tok.value === '(') {
      const v = this.parseExpr(t)
      this.expectOp(')')
      return v
    }
    if (tok.kind === 'ident') {
      const name = tok.value
      const next = this.peek()
      if (next?.kind === 'op' && next.value === '(') {
        this.next()
        const args: number[] = []
        if (!(this.peek()?.kind === 'op' && this.peek()?.value === ')')) {
          args.push(this.parseExpr(t))
          while (this.peek()?.kind === 'op' && this.peek()?.value === ',') {
            this.next()
            args.push(this.parseExpr(t))
          }
        }
        this.expectOp(')')
        const fn = FUNCTIONS[name]
        if (!fn) throw new Error(`Unknown function "${name}" in equation.`)
        return fn(...args)
      }
      if (name === 't') return t
      if (name === 'pi') return Math.PI
      if (name === 'e') return Math.E
      throw new Error(`Unknown identifier "${name}" in equation.`)
    }
    throw new Error('Unexpected token in equation.')
  }
}

/** Evaluates `equation` at a given value of `t`. Throws on malformed input —
 *  callers doing best-effort preview rendering should catch and skip. */
export function evalExprAt(equation: string, t: number): number {
  const tokens = tokenize(equation)
  return new Parser(tokens).parse(t)
}

/** Samples xEquation/yEquation over [tMin, tMax] for preview purposes only.
 *  Caps the number of sampled points well below the real `steps` value
 *  (which can be up to 2000) since this only feeds a visual curve, not the
 *  actual drag. Returns an empty array (rather than throwing) on any
 *  parse/eval error, since a failed preview must never block or alter the
 *  real mouse_drag_path call. */
export function sampleParametricPath(
  xEquation: string,
  yEquation: string,
  tMin: number,
  tMax: number,
  steps: number,
  maxPoints = 120
): { x: number; y: number }[] {
  try {
    const n = Math.max(2, Math.min(steps, maxPoints))
    const points: { x: number; y: number }[] = []
    for (let i = 0; i < n; i++) {
      const t = tMin + ((tMax - tMin) * i) / (n - 1)
      points.push({ x: evalExprAt(xEquation, t), y: evalExprAt(yEquation, t) })
    }
    return points
  } catch {
    return []
  }
}
