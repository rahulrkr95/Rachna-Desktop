// src-tauri/src/input_control.rs
//
// Backing commands for the agent's `mouse_click` and `press_key` tools
// (services/agent/tools/inputControlTools.ts). Simulates real OS-level
// mouse and keyboard input via the `enigo` crate (cross-platform: Windows,
// macOS, Linux X11/Wayland).
//
// Security note: this module intentionally does NOT re-validate whether an
// action should be allowed — same threat model as `run_terminal_command` /
// `take_screenshot`. The TypeScript layer (inputControlTools.ts) gates
// every call behind the user's permission-approval flow
// (ctx.requestTerminalPermission / useTerminalPermissionStore) AND behind
// the screenshot-first guard (services/agent/desktopInputGuard.ts) before
// either of these commands is ever invoked.

use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

type CmdResult<T> = Result<T, String>;

// ── tiny safe math-expression evaluator ──────────────────────────────────────
//
// Backs `mouse_drag_path`'s xEquation/yEquation parameters. This is NOT a
// generic scripting engine — it's a minimal recursive-descent parser over a
// fixed grammar (numbers, the single variable `t`, +-*/^, unary +/-,
// parentheses, and a small allow-listed function table). There is no way to
// reach the filesystem, network, process spawning, or any other capability
// through it, so it's safe to evaluate an untrusted/model-supplied string
// directly — unlike `eval`, there's no code execution surface here at all.
mod expr {
    #[derive(Debug)]
    pub struct ParseError(pub String);

    #[derive(Debug, Clone)]
    enum Token {
        Num(f64),
        Ident(String),
        Plus,
        Minus,
        Star,
        Slash,
        Caret,
        Comma,
        LParen,
        RParen,
    }

    fn tokenize(src: &str) -> Result<Vec<Token>, ParseError> {
        let mut out = Vec::new();
        let mut chars = src.chars().peekable();
        while let Some(&c) = chars.peek() {
            match c {
                ' ' | '\t' | '\n' | '\r' => {
                    chars.next();
                }
                '+' => {
                    chars.next();
                    out.push(Token::Plus);
                }
                '-' => {
                    chars.next();
                    out.push(Token::Minus);
                }
                '*' => {
                    chars.next();
                    out.push(Token::Star);
                }
                '/' => {
                    chars.next();
                    out.push(Token::Slash);
                }
                '^' => {
                    chars.next();
                    out.push(Token::Caret);
                }
                ',' => {
                    chars.next();
                    out.push(Token::Comma);
                }
                '(' => {
                    chars.next();
                    out.push(Token::LParen);
                }
                ')' => {
                    chars.next();
                    out.push(Token::RParen);
                }
                c if c.is_ascii_digit() || c == '.' => {
                    let mut s = String::new();
                    while let Some(&c) = chars.peek() {
                        if c.is_ascii_digit() || c == '.' {
                            s.push(c);
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    let n: f64 = s
                        .parse()
                        .map_err(|_| ParseError(format!("Invalid number \"{s}\".")))?;
                    out.push(Token::Num(n));
                }
                c if c.is_ascii_alphabetic() || c == '_' => {
                    let mut s = String::new();
                    while let Some(&c) = chars.peek() {
                        if c.is_ascii_alphanumeric() || c == '_' {
                            s.push(c);
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    out.push(Token::Ident(s));
                }
                other => {
                    return Err(ParseError(format!(
                        "Unexpected character '{other}' in equation."
                    )))
                }
            }
        }
        Ok(out)
    }

    /// Recursive-descent parser that evaluates directly against a given `t`
    /// (no AST is retained — the equation is short and re-evaluated once per
    /// path sample, so re-parsing per call is simpler and plenty fast for the
    /// step counts mouse_drag_path allows).
    struct Parser<'a> {
        tokens: &'a [Token],
        pos: usize,
        t: f64,
    }

    impl<'a> Parser<'a> {
        fn peek(&self) -> Option<&Token> {
            self.tokens.get(self.pos)
        }

        fn next(&mut self) -> Option<Token> {
            let tok = self.tokens.get(self.pos).cloned();
            self.pos += 1;
            tok
        }

        fn expr(&mut self) -> Result<f64, ParseError> {
            let mut value = self.term()?;
            loop {
                match self.peek() {
                    Some(Token::Plus) => {
                        self.next();
                        value += self.term()?;
                    }
                    Some(Token::Minus) => {
                        self.next();
                        value -= self.term()?;
                    }
                    _ => break,
                }
            }
            Ok(value)
        }

        fn term(&mut self) -> Result<f64, ParseError> {
            let mut value = self.power()?;
            loop {
                match self.peek() {
                    Some(Token::Star) => {
                        self.next();
                        value *= self.power()?;
                    }
                    Some(Token::Slash) => {
                        self.next();
                        let rhs = self.power()?;
                        value /= rhs;
                    }
                    _ => break,
                }
            }
            Ok(value)
        }

        // '^' is right-associative and binds tighter than unary minus on its
        // right side (so -2^2 == -4, 2^-1 == 0.5), handled via unary().
        fn power(&mut self) -> Result<f64, ParseError> {
            let base = self.unary()?;
            if matches!(self.peek(), Some(Token::Caret)) {
                self.next();
                let exponent = self.power()?;
                Ok(base.powf(exponent))
            } else {
                Ok(base)
            }
        }

        fn unary(&mut self) -> Result<f64, ParseError> {
            match self.peek() {
                Some(Token::Minus) => {
                    self.next();
                    Ok(-self.unary()?)
                }
                Some(Token::Plus) => {
                    self.next();
                    self.unary()
                }
                _ => self.primary(),
            }
        }

        fn primary(&mut self) -> Result<f64, ParseError> {
            match self.next() {
                Some(Token::Num(n)) => Ok(n),
                Some(Token::LParen) => {
                    let value = self.expr()?;
                    match self.next() {
                        Some(Token::RParen) => Ok(value),
                        _ => Err(ParseError("Expected closing ')'.".to_string())),
                    }
                }
                Some(Token::Ident(name)) => self.ident(name),
                other => Err(ParseError(format!("Unexpected token: {other:?}"))),
            }
        }

        fn ident(&mut self, name: String) -> Result<f64, ParseError> {
            let lower = name.to_lowercase();
            // Bare identifiers: the variable `t` and a couple of constants.
            if !matches!(self.peek(), Some(Token::LParen)) {
                return match lower.as_str() {
                    "t" => Ok(self.t),
                    "pi" => Ok(std::f64::consts::PI),
                    "e" => Ok(std::f64::consts::E),
                    other => Err(ParseError(format!(
                        "Unknown identifier \"{other}\" — use t, pi, e, or a supported function."
                    ))),
                };
            }
            // Function call: name '(' args ')'
            self.next(); // consume '('
            let mut args = vec![self.expr()?];
            while matches!(self.peek(), Some(Token::Comma)) {
                self.next();
                args.push(self.expr()?);
            }
            match self.next() {
                Some(Token::RParen) => {}
                _ => return Err(ParseError("Expected closing ')' after function args.".to_string())),
            }
            call_function(&lower, &args)
        }
    }

    fn call_function(name: &str, args: &[f64]) -> Result<f64, ParseError> {
        let arity_err = |want: usize| {
            ParseError(format!(
                "Function \"{name}\" expects {want} argument(s), got {}.",
                args.len()
            ))
        };
        match name {
            "sin" if args.len() == 1 => Ok(args[0].sin()),
            "cos" if args.len() == 1 => Ok(args[0].cos()),
            "tan" if args.len() == 1 => Ok(args[0].tan()),
            "sqrt" if args.len() == 1 => Ok(args[0].sqrt()),
            "abs" if args.len() == 1 => Ok(args[0].abs()),
            "exp" if args.len() == 1 => Ok(args[0].exp()),
            "ln" if args.len() == 1 => Ok(args[0].ln()),
            "log10" if args.len() == 1 => Ok(args[0].log10()),
            "floor" if args.len() == 1 => Ok(args[0].floor()),
            "ceil" if args.len() == 1 => Ok(args[0].ceil()),
            "round" if args.len() == 1 => Ok(args[0].round()),
            "sin" | "cos" | "tan" | "sqrt" | "abs" | "exp" | "ln" | "log10" | "floor" | "ceil"
            | "round" => Err(arity_err(1)),
            "pow" if args.len() == 2 => Ok(args[0].powf(args[1])),
            "min" if args.len() == 2 => Ok(args[0].min(args[1])),
            "max" if args.len() == 2 => Ok(args[0].max(args[1])),
            "pow" | "min" | "max" => Err(arity_err(2)),
            other => Err(ParseError(format!(
                "Unknown function \"{other}\" — supported: sin, cos, tan, sqrt, abs, exp, ln, \
                 log10, floor, ceil, round, pow, min, max."
            ))),
        }
    }

    /// Parses `src` once and returns a closure evaluating it for any `t`.
    /// Re-tokenizes on every call (not cached across calls) — simple, and the
    /// equation strings involved here are short, evaluated at most a couple
    /// thousand times per mouse_drag_path invocation.
    pub fn compile(src: &str) -> Result<impl Fn(f64) -> Result<f64, ParseError> + '_, ParseError> {
        let tokens = tokenize(src)?;
        Ok(move |t: f64| -> Result<f64, ParseError> {
            let mut parser = Parser {
                tokens: &tokens,
                pos: 0,
                t,
            };
            let value = parser.expr()?;
            if parser.pos != parser.tokens.len() {
                return Err(ParseError("Unexpected trailing input in equation.".to_string()));
            }
            if !value.is_finite() {
                return Err(ParseError("Equation produced a non-finite value (NaN/∞).".to_string()));
            }
            Ok(value)
        })
    }
}

fn new_enigo() -> CmdResult<Enigo> {
    Enigo::new(&Settings::default())
        .map_err(|e| format!("Failed to initialize input simulator: {e}"))
}

// ── mouse-position verification ──────────────────────────────────────────────
//
// Backs the "before every click/drag, confirm the cursor actually landed
// where it was told to" requirement. This is intentionally dumb and local:
// move the OS cursor, read the OS cursor back via `Enigo::location`, compare
// against the requested target within a small pixel tolerance, and retry the
// move a bounded number of times if it doesn't match. No model call, no
// heuristics — just a coordinate comparison, so it's fully deterministic and
// cheap enough to run before every single click and at the start of every
// drag.
//
// Why this can fail at all: `move_mouse` can silently land short of the
// target on multi-monitor setups with mismatched DPI/scaling, when the
// target coordinate falls outside any display, or (rarely) when another
// process/driver nudges the cursor between the move and the read. Rather
// than clicking wherever the cursor actually ended up in that case, we
// refuse and surface a clear error — a misplaced click on the wrong control
// is worse than an aborted action.

/// Pixel tolerance used when the caller doesn't specify one. Kept in the
/// middle of the 2–5px range called for — tight enough to catch a real
/// mismatch, loose enough to tolerate float→int rounding in `move_mouse`.
const DEFAULT_POSITION_TOLERANCE_PX: i32 = 3;
/// Hard floor/ceiling so a caller-supplied tolerance can't disable
/// verification (0 or negative) or make it meaningless (huge).
const MIN_POSITION_TOLERANCE_PX: i32 = 1;
const MAX_POSITION_TOLERANCE_PX: i32 = 25;

/// Number of move+verify attempts before giving up. 1 initial attempt plus
/// up to this many retries.
const POSITION_VERIFY_MAX_ATTEMPTS: u32 = 4;
/// Small pause between the move and reading the position back, giving the
/// OS a moment to actually apply the move before we ask it where the
/// cursor is.
const POSITION_VERIFY_SETTLE_MS: u64 = 12;
/// Pause before a retry attempt, distinct from the settle delay above so a
/// retry isn't launched back-to-back with the failed attempt.
const POSITION_VERIFY_RETRY_DELAY_MS: u64 = 30;

fn clamp_tolerance(tolerance_px: Option<i32>) -> i32 {
    tolerance_px
        .unwrap_or(DEFAULT_POSITION_TOLERANCE_PX)
        .clamp(MIN_POSITION_TOLERANCE_PX, MAX_POSITION_TOLERANCE_PX)
}

/// Moves the cursor to `(target_x, target_y)` and confirms — by reading the
/// OS cursor position back — that it actually landed within `tolerance_px`
/// of the target. Retries the move up to `POSITION_VERIFY_MAX_ATTEMPTS`
/// times total before returning an error. Never clicks or drags anything
/// itself — callers only proceed to the real click/press once this returns
/// `Ok`.
async fn move_and_verify_position(
    enigo: &mut Enigo,
    target_x: i32,
    target_y: i32,
    tolerance_px: Option<i32>,
) -> CmdResult<(i32, i32)> {
    let tolerance = clamp_tolerance(tolerance_px);
    let mut last_seen: Option<(i32, i32)> = None;

    for attempt in 1..=POSITION_VERIFY_MAX_ATTEMPTS {
        enigo
            .move_mouse(target_x, target_y, Coordinate::Abs)
            .map_err(|e| format!("Failed to move mouse to ({target_x}, {target_y}): {e}"))?;

        tokio::time::sleep(std::time::Duration::from_millis(POSITION_VERIFY_SETTLE_MS)).await;

        let (actual_x, actual_y) = enigo
            .location()
            .map_err(|e| format!("Failed to read cursor position: {e}"))?;
        last_seen = Some((actual_x, actual_y));

        let dx = (actual_x - target_x).abs();
        let dy = (actual_y - target_y).abs();
        if dx <= tolerance && dy <= tolerance {
            return Ok((actual_x, actual_y));
        }

        if attempt < POSITION_VERIFY_MAX_ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(POSITION_VERIFY_RETRY_DELAY_MS)).await;
        }
    }

    let (seen_x, seen_y) = last_seen.unwrap_or((target_x, target_y));
    Err(format!(
        "Cursor position verification failed after {POSITION_VERIFY_MAX_ATTEMPTS} attempt(s): \
         requested ({target_x}, {target_y}) but the OS reports the cursor at ({seen_x}, {seen_y}) \
         (tolerance {tolerance}px). Refusing to click/drag without a verified cursor position."
    ))
}

// ── mouse_click ────────────────────────────────────────────────────────────
//
// Moves the mouse to an absolute screen position (top-left of the primary
// display is 0,0) and clicks the given button. All buttons enigo exposes
// are supported: left, right, middle, and the back/forward "extra" buttons
// found on many mice. `double: true` fires two clicks in quick succession
// (within the OS double-click interval) to trigger double-click behavior.

fn parse_button(button: &str) -> CmdResult<Button> {
    match button.to_lowercase().as_str() {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        "back" => Ok(Button::Back),
        "forward" => Ok(Button::Forward),
        other => Err(format!(
            "Unsupported mouse button \"{other}\" — supported values are: \
             left, right, middle, back, forward."
        )),
    }
}

#[tauri::command]
pub async fn mouse_click(
    x: i32,
    y: i32,
    button: String,
    double: Option<bool>,
    required_pid: Option<u32>,
    required_app_name: Option<String>,
    tolerance_px: Option<i32>,
) -> CmdResult<()> {
    let btn = parse_button(&button)?;
    if required_pid.is_some()
        || required_app_name
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
    {
        crate::window_control::assert_focused_app(required_pid, required_app_name)?;
    }

    let mut enigo = new_enigo()?;

    // Move to the target and confirm the OS cursor actually landed there
    // before clicking anything — see move_and_verify_position's doc
    // comment. This returns an error (and never clicks) if verification
    // doesn't succeed within its retry budget.
    move_and_verify_position(&mut enigo, x, y, tolerance_px).await?;

    enigo
        .button(btn, Direction::Click)
        .map_err(|e| format!("Failed to click the {button} mouse button: {e}"))?;

    if double.unwrap_or(false) {
        // Short gap well within the OS double-click interval (~500ms default
        // on Windows/macOS/most Linux DEs) so the second click registers as
        // part of the same double-click, not a separate click.
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        enigo
            .button(btn, Direction::Click)
            .map_err(|e| format!("Failed to click the {button} mouse button: {e}"))?;
    }

    Ok(())
}

// ── mouse_drag_path ───────────────────────────────────────────────────────
//
// Backing command for the agent's `mouse_drag_path` tool
// (services/agent/tools/inputControlTools.ts). Presses a mouse button down,
// sweeps the cursor through a sequence of points sampled from two
// model-supplied parametric equations x(t)/y(t) over [tMin, tMax], and
// releases the button at the end — i.e. a single continuous click-and-drag
// along an arbitrary path, as opposed to mouse_click's single point-and-click.
//
// Same threat model note as mouse_click above: this command does not
// re-check permissions itself. The TypeScript layer gates the whole call
// behind ONE permission prompt (covering the entire drag, not one prompt per
// sample point — see inputControlTools.ts) plus the screenshot-first guard
// before invoking this at all.

const MOUSE_DRAG_PATH_MAX_STEPS: u32 = 2000;
const MOUSE_DRAG_PATH_MIN_STEPS: u32 = 2;
const MOUSE_DRAG_PATH_MAX_DURATION_MS: u64 = 30_000;
const MOUSE_DRAG_PATH_MAX_EQUATION_LEN: usize = 500;

#[derive(serde::Serialize)]
pub struct MouseDragPathSummary {
    steps: u32,
    start: (i32, i32),
    end: (i32, i32),
}

#[tauri::command]
pub async fn mouse_drag_path(
    x_equation: String,
    y_equation: String,
    t_min: f64,
    t_max: f64,
    steps: u32,
    duration_ms: Option<u64>,
    button: Option<String>,
    required_pid: Option<u32>,
    required_app_name: Option<String>,
    tolerance_px: Option<i32>,
) -> CmdResult<MouseDragPathSummary> {
    if x_equation.len() > MOUSE_DRAG_PATH_MAX_EQUATION_LEN
        || y_equation.len() > MOUSE_DRAG_PATH_MAX_EQUATION_LEN
    {
        return Err(format!(
            "xEquation/yEquation must be at most {MOUSE_DRAG_PATH_MAX_EQUATION_LEN} characters."
        ));
    }
    if !(MOUSE_DRAG_PATH_MIN_STEPS..=MOUSE_DRAG_PATH_MAX_STEPS).contains(&steps) {
        return Err(format!(
            "steps must be between {MOUSE_DRAG_PATH_MIN_STEPS} and {MOUSE_DRAG_PATH_MAX_STEPS}, got {steps}."
        ));
    }
    if !t_min.is_finite() || !t_max.is_finite() {
        return Err("tMin and tMax must be finite numbers.".to_string());
    }
    let duration_ms = duration_ms.unwrap_or(1000).min(MOUSE_DRAG_PATH_MAX_DURATION_MS);
    let btn = parse_button(button.as_deref().unwrap_or("left"))?;

    let x_fn = expr::compile(&x_equation).map_err(|e| format!("xEquation: {}", e.0))?;
    let y_fn = expr::compile(&y_equation).map_err(|e| format!("yEquation: {}", e.0))?;

    // Sample every point up front — a bad equation (e.g. divide-by-zero at
    // some t) should fail the whole call before the mouse button ever goes
    // down, rather than leaving a button stuck mid-drag on the user's screen.
    let mut points: Vec<(i32, i32)> = Vec::with_capacity(steps as usize + 1);
    for i in 0..=steps {
        let t = if steps == 0 {
            t_min
        } else {
            t_min + (t_max - t_min) * (i as f64 / steps as f64)
        };
        let x = x_fn(t).map_err(|e| format!("xEquation at t={t}: {}", e.0))?;
        let y = y_fn(t).map_err(|e| format!("yEquation at t={t}: {}", e.0))?;
        points.push((x.round() as i32, y.round() as i32));
    }

    let has_required = required_pid.is_some()
        || required_app_name
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
    if has_required {
        crate::window_control::assert_focused_app(required_pid, required_app_name.clone())?;
    }

    let mut enigo = new_enigo()?;
    let start = points[0];
    let end = *points.last().unwrap();

    // Move to the start point first, THEN press down — matches how a real
    // drag begins (cursor arrives at the start location before the button
    // goes down), and avoids dragging from wherever the cursor happened to
    // be resting. Verified the same way as mouse_click: move, read the OS
    // cursor back, and only proceed once it's confirmed within tolerance —
    // this is the point where the button actually goes down, so it's the
    // one spot in a drag that most needs to be right. The remaining
    // in-flight path samples are a continuous sweep rather than discrete
    // click targets, so they aren't re-verified individually (that would
    // both defeat the point of a smooth path and add up to thousands of
    // extra OS round-trips for a single call).
    move_and_verify_position(&mut enigo, start.0, start.1, tolerance_px).await?;
    enigo
        .button(btn, Direction::Press)
        .map_err(|e| format!("Failed to press the {} mouse button: {e}", button.as_deref().unwrap_or("left")))?;

    let per_step_delay = std::time::Duration::from_millis(duration_ms / steps.max(1) as u64);
    // Re-verify focus roughly every quarter-second of drag time so a window
    // that loses focus mid-drag doesn't keep dragging into whatever's
    // underneath — but not every single sample, which would be needless
    // overhead for a 2000-step path.
    let refocus_every = ((250 / per_step_delay.as_millis().max(1)) as usize).max(1);

    let drag_result = (|| -> CmdResult<()> {
        for (i, &(px, py)) in points.iter().enumerate().skip(1) {
            if has_required && i % refocus_every == 0 {
                crate::window_control::assert_focused_app(required_pid, required_app_name.clone())?;
            }
            enigo
                .move_mouse(px, py, Coordinate::Abs)
                .map_err(|e| format!("Failed to move mouse to ({px}, {py}) mid-drag: {e}"))?;
            if i + 1 < points.len() {
                std::thread::sleep(per_step_delay);
            }
        }
        Ok(())
    })();

    // Always release the button, even if a mid-drag step failed — leaving
    // the mouse button physically "held down" on the user's system would be
    // far worse than surfacing the drag error.
    let release_result = enigo
        .button(btn, Direction::Release)
        .map_err(|e| format!("Failed to release the {} mouse button: {e}", button.as_deref().unwrap_or("left")));

    drag_result?;
    release_result?;

    Ok(MouseDragPathSummary {
        steps,
        start,
        end,
    })
}

// ── press_key ──────────────────────────────────────────────────────────────
//
// Three modes, mutually exclusive:
//   - `text`: types literal text (Unicode-aware) via Enigo::text — use for
//     typing content into a focused field.
//   - `keys`: presses one or more named keys together as a single chord
//     (e.g. ["ctrl", "c"] for copy, or ["enter"] alone) — all keys are
//     pressed down in order, then released in reverse order.
//   - `sequence`: presses multiple chords one after another, with a short
//     pause between each (e.g. [["ctrl","k"],["ctrl","s"]] for VS Code's
//     "save without formatting" chorded shortcut, or [["down"],["down"],
//     ["enter"]] to walk down a menu and select an item). Each inner array
//     is pressed/released exactly like `keys` before moving to the next.
// Exactly one of the three must be provided.

fn parse_key(name: &str) -> CmdResult<Key> {
    // Single printable character — send it directly as Unicode input so
    // layout-independent characters (letters, digits, punctuation) just work.
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Ok(Key::Unicode(c));
    }

    let key = match name.to_lowercase().replace(['_', '-'], "").as_str() {
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,
        "meta" | "cmd" | "command" | "super" | "win" | "windows" => Key::Meta,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" | "spacebar" => Key::Space,
        "up" | "uparrow" => Key::UpArrow,
        "down" | "downarrow" => Key::DownArrow,
        "left" | "leftarrow" => Key::LeftArrow,
        "right" | "rightarrow" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "capslock" => Key::CapsLock,
        "insert" => Key::Insert,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        other => {
            return Err(format!(
                "Unrecognized key name \"{other}\". Use a single character (e.g. \"a\") or one of: \
                 ctrl, alt, shift, meta, enter, tab, escape, backspace, delete, space, up, down, \
                 left, right, home, end, pageup, pagedown, capslock, insert, f1-f12."
            ))
        }
    };
    Ok(key)
}

/// Presses one chord (one or more keys held together) and releases it in
/// reverse order, mirroring how a human releases a chord (e.g. Ctrl+C:
/// press Ctrl, press C, release C, release Ctrl).
fn press_chord(enigo: &mut Enigo, chord: &[String]) -> CmdResult<()> {
    let parsed: Vec<Key> = chord
        .iter()
        .map(|k| parse_key(k))
        .collect::<CmdResult<Vec<Key>>>()?;

    for key in &parsed {
        enigo
            .key(key.clone(), Direction::Press)
            .map_err(|e| format!("Failed to press key: {e}"))?;
    }
    for key in parsed.iter().rev() {
        enigo
            .key(key.clone(), Direction::Release)
            .map_err(|e| format!("Failed to release key: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn press_key(
    keys: Option<Vec<String>>,
    text: Option<String>,
    sequence: Option<Vec<Vec<String>>>,
    delay_ms: Option<u64>,
    required_pid: Option<u32>,
    required_app_name: Option<String>,
) -> CmdResult<()> {
    if required_pid.is_some()
        || required_app_name
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
    {
        crate::window_control::assert_focused_app(required_pid, required_app_name.clone())?;
    }

    let mut enigo = new_enigo()?;

    let has_text = text.as_deref().is_some_and(|t| !t.is_empty());
    let has_keys = keys.as_deref().is_some_and(|k| !k.is_empty());
    let has_sequence = sequence.as_deref().is_some_and(|s| !s.is_empty());

    let provided_count = [has_text, has_keys, has_sequence]
        .iter()
        .filter(|b| **b)
        .count();
    if provided_count > 1 {
        return Err("Provide exactly one of \"text\", \"keys\", or \"sequence\".".to_string());
    }

    if let Some(t) = text.filter(|t| !t.is_empty()) {
        return enigo
            .text(&t)
            .map_err(|e| format!("Failed to type text: {e}"));
    }

    if let Some(chords) = sequence.filter(|s| !s.is_empty()) {
        let gap = std::time::Duration::from_millis(delay_ms.unwrap_or(80));
        let has_required = required_pid.is_some()
            || required_app_name
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty());
        for (i, chord) in chords.iter().enumerate() {
            if chord.is_empty() {
                return Err(format!(
                    "sequence[{i}] is empty — each chord needs at least one key."
                ));
            }
            // Re-verify (not just once, up front) — a long sequence with
            // inter-chord delays gives plenty of time for focus to drift
            // away from the required window between steps.
            if has_required {
                crate::window_control::assert_focused_app(
                    required_pid,
                    required_app_name.clone(),
                )?;
            }
            press_chord(&mut enigo, chord)?;
            if i + 1 < chords.len() {
                tokio::time::sleep(gap).await;
            }
        }
        return Ok(());
    }

    let keys = keys.filter(|k| !k.is_empty()).ok_or_else(|| {
        "Provide one of: a non-empty \"text\" string, a non-empty \"keys\" array, or a \
         non-empty \"sequence\" array of key arrays."
            .to_string()
    })?;

    press_chord(&mut enigo, &keys)
}
