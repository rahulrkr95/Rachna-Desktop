// lib/browser-tool/web-task.js
//
// General-purpose headless-browser automation sidecar, used by the agent's
// `web_task` tool (services/agent/tools/webTaskTool.ts) for BROWSER_TASK-intent
// requests — i.e. work on the OPEN web that doesn't need the user's own
// logged-in session (search results pages, public docs, public forms,
// scraping a public page, repeatedly polling a page for a change, etc).
//
// Unlike run.js (which just loads one URL to verify a local dev build),
// this runs an ordered LIST of steps against a single browser session, so
// the model can compose small automations — e.g.
//   [ {goto}, {click}, {fill}, {click}, {extractText} ]
// — instead of only ever loading one page. This is also what "write an
// automation script for a repetitive web task" means in practice: the
// model produces a `steps` array once, and the SAME array can be re-run
// unattended (e.g. from a scheduled/automation flow) without regenerating
// it each time.
//
// Usage:
//   node web-task.js '<json args>'
//
// Args (JSON):
//   {
//     "steps": [
//       { "action": "goto",        "url": "https://example.com" },
//       { "action": "click",       "selector": "#accept-cookies" },
//       { "action": "fill",        "selector": "input[name=q]", "value": "hello" },
//       { "action": "press",       "selector": "input[name=q]", "key": "Enter" },
//       { "action": "pressSequence", "keys": ["ArrowDown","ArrowDown","Enter"], "selector": "#menu", "delayMs": 30 },
//       { "action": "waitFor",     "selector": ".results", "timeoutMs": 8000 },
//       { "action": "extractText", "selector": ".results", "as": "results" },
//       { "action": "extractAttr", "selector": "a.result-link", "attr": "href", "as": "links" },
//       { "action": "screenshot",  "fullPage": true },
//       { "action": "wait",        "ms": 500 }
//     ],
//     "width": 1280,
//     "height": 800,
//     "timeoutMs": 30000
//   }
//
// Prints exactly one line of JSON to stdout (everything else goes to
// stderr, mirroring run.js):
//   {
//     "ok": true,
//     "finalUrl": "https://example.com/search?q=hello",
//     "title": "Search results",
//     "extracted": { "results": ["...", "..."], "links": ["https://...", ...] },
//     "screenshotBase64": "...",     // present only if a "screenshot" step ran
//     "stepLog": [ { "action": "goto", "ok": true }, ... ],
//     "consoleErrors": ["..."],
//     "durationMs": 842
//   }
// On failure of an individual step, execution stops there (subsequent
// steps are skipped) and `ok` is false with `error` describing which step
// failed and why — everything extracted up to that point is still
// returned so the caller isn't left with nothing.

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
  console.log(JSON.stringify({
    ok: false,
    error:
      "Playwright is not installed. Run: cd lib/browser-tool && npm install && npx playwright install chromium",
  }));
  process.exit(0);
}

const MAX_STEPS = 25;
const MAX_TEXT_ITEMS = 200;
const MAX_TEXT_LEN = 4000;
const MAX_SEQUENCE_KEYS = 2000;

function clampTimeout(ms, fallback, max) {
  return Number.isFinite(ms) ? Math.max(500, Math.min(ms, max)) : fallback;
}

async function runStep(page, step, extracted, stepLog) {
  const action = step && step.action;
  switch (action) {
    case 'goto': {
      if (!step.url || typeof step.url !== 'string') throw new Error('goto requires a "url" string.');
      if (!/^https?:\/\//i.test(step.url)) throw new Error('goto url must start with http:// or https://');
      const response = await page.goto(step.url, {
        waitUntil: 'load',
        timeout: clampTimeout(step.timeoutMs, 30000, 60000),
      });
      stepLog.push({ action, url: step.url, status: response ? response.status() : null, ok: true });
      return;
    }
    case 'click': {
      if (!step.selector) throw new Error('click requires a "selector".');
      await page.click(step.selector, { timeout: clampTimeout(step.timeoutMs, 10000, 30000) });
      stepLog.push({ action, selector: step.selector, ok: true });
      return;
    }
    case 'fill': {
      if (!step.selector) throw new Error('fill requires a "selector".');
      await page.fill(step.selector, String(step.value ?? ''), { timeout: clampTimeout(step.timeoutMs, 10000, 30000) });
      stepLog.push({ action, selector: step.selector, ok: true });
      return;
    }
    case 'press': {
      if (!step.selector) throw new Error('press requires a "selector".');
      if (!step.key) throw new Error('press requires a "key" (e.g. "Enter").');
      await page.press(step.selector, step.key, { timeout: clampTimeout(step.timeoutMs, 10000, 30000) });
      stepLog.push({ action, selector: step.selector, key: step.key, ok: true });
      return;
    }
    case 'pressSequence': {
      const keys = step.keys;
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error('pressSequence requires a non-empty "keys" array.');
      }
      if (keys.length > MAX_SEQUENCE_KEYS) {
        throw new Error(`pressSequence has too many keys (${keys.length}); max is ${MAX_SEQUENCE_KEYS}.`);
      }
      if (step.selector) {
        await page.focus(step.selector, { timeout: clampTimeout(step.timeoutMs, 10000, 30000) });
      }
      const delayMs = Number.isFinite(step.delayMs) ? Math.max(0, Math.min(step.delayMs, 2000)) : 30;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (typeof key !== 'string' || key.length === 0) {
          throw new Error(`pressSequence keys[${i}] must be a non-empty string.`);
        }
        await page.keyboard.press(key);
        if (i + 1 < keys.length && delayMs > 0) {
          await page.waitForTimeout(delayMs);
        }
      }
      stepLog.push({ action, selector: step.selector, count: keys.length, ok: true });
      return;
    }
    case 'waitFor': {
      if (!step.selector) throw new Error('waitFor requires a "selector".');
      await page.waitForSelector(step.selector, { timeout: clampTimeout(step.timeoutMs, 10000, 30000) });
      stepLog.push({ action, selector: step.selector, ok: true });
      return;
    }
    case 'wait': {
      const ms = clampTimeout(step.ms, 500, 15000);
      await page.waitForTimeout(ms);
      stepLog.push({ action, ms, ok: true });
      return;
    }
    case 'extractText': {
      if (!step.selector) throw new Error('extractText requires a "selector".');
      const key = step.as || 'text';
      const texts = await page.$$eval(step.selector, (els) => els.map((el) => el.textContent || ''));
      extracted[key] = texts
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, MAX_TEXT_ITEMS)
        .map((t) => (t.length > MAX_TEXT_LEN ? t.slice(0, MAX_TEXT_LEN) + '…' : t));
      stepLog.push({ action, selector: step.selector, as: key, count: extracted[key].length, ok: true });
      return;
    }
    case 'extractAttr': {
      if (!step.selector) throw new Error('extractAttr requires a "selector".');
      if (!step.attr) throw new Error('extractAttr requires an "attr" (e.g. "href").');
      const key = step.as || step.attr;
      const values = await page.$$eval(
        step.selector,
        (els, attr) => els.map((el) => el.getAttribute(attr) || ''),
        step.attr
      );
      extracted[key] = values.filter(Boolean).slice(0, MAX_TEXT_ITEMS);
      stepLog.push({ action, selector: step.selector, attr: step.attr, as: key, count: extracted[key].length, ok: true });
      return;
    }
    case 'screenshot': {
      const buf = await page.screenshot({ fullPage: !!step.fullPage });
      extracted.__screenshotBase64 = buf.toString('base64');
      stepLog.push({ action, ok: true });
      return;
    }
    default:
      throw new Error(`Unknown step action "${action}". Supported: goto, click, fill, press, pressSequence, waitFor, wait, extractText, extractAttr, screenshot.`);
  }
}

async function main() {
  const rawArgs = process.argv[2] || '{}';
  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `Invalid JSON args: ${e.message}` }));
    return;
  }

  const steps = Array.isArray(args.steps) ? args.steps : null;
  if (!steps || steps.length === 0) {
    console.log(JSON.stringify({ ok: false, error: 'steps must be a non-empty array.' }));
    return;
  }
  if (steps.length > MAX_STEPS) {
    console.log(JSON.stringify({ ok: false, error: `Too many steps (${steps.length}); max is ${MAX_STEPS}.` }));
    return;
  }
  // First step must establish a page — this tool doesn't have a notion of
  // "current URL" outside of what goto sets, and the whole point is to
  // stay unauthenticated/stateless per run.
  if (steps[0].action !== 'goto') {
    console.log(JSON.stringify({ ok: false, error: 'The first step must be a "goto" to load a starting page.' }));
    return;
  }

  const width = Number.isFinite(args.width) ? args.width : 1280;
  const height = Number.isFinite(args.height) ? args.height : 800;
  const started = Date.now();

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    console.log(JSON.stringify({
      ok: false,
      error:
        `Failed to launch headless Chromium: ${e.message}. ` +
        `If this is the first run, install the browser binary: ` +
        `cd lib/browser-tool && npx playwright install chromium`,
    }));
    return;
  }

  const consoleErrors = [];
  const stepLog = [];
  const extracted = {};

  try {
    // Deliberately never load stored cookies/storage state — BROWSER_TASK is
    // for unauthenticated, public-web work only. Anything needing the
    // user's own session belongs behind a real integration (MCP_TASK), not
    // this tool.
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    let failure = null;
    for (const step of steps) {
      try {
        await runStep(page, step, extracted, stepLog);
      } catch (e) {
        failure = `Step "${step && step.action}" failed: ${e.message || String(e)}`;
        stepLog.push({ action: step && step.action, ok: false, error: e.message || String(e) });
        break;
      }
    }

    let title = '';
    try { title = await page.title(); } catch { /* ignore */ }

    const screenshotBase64 = extracted.__screenshotBase64 || null;
    delete extracted.__screenshotBase64;

    const result = {
      ok: !failure,
      error: failure || undefined,
      finalUrl: page.url(),
      title,
      extracted,
      screenshotBase64,
      stepLog,
      consoleErrors: consoleErrors.slice(0, 50),
      durationMs: Date.now() - started,
    };
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message || String(e), stepLog }));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message || String(e) }));
  process.exit(0);
});
