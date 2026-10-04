// lib/browser-tool/run.js
//
// Headless-browser sidecar invoked by the Rust `run_browser_check` Tauri
// command (see src-tauri/src/commands.rs), which is in turn called by the
// agent's `browser_check` tool (services/agent/tools/browserCheckTool.ts).
//
// Usage:
//   node run.js '<json args>'
//
// Args (JSON, all but `url` optional):
//   {
//     "url": "http://localhost:5173",
//     "waitMs": 1500,          // extra time to let the page settle after load
//     "fullPage": false,       // capture the full scrollable page vs viewport
//     "selector": null,        // if set, wait for this selector before screenshotting
//     "width": 1280,
//     "height": 800,
//     "timeoutMs": 30000,
//     "keepOpen": false,       // if true, leave the visible Chromium window open
//                               // after the check instead of closing it
//     "headless": false        // if true, launch headless instead of the usual
//                               // visible foreground window (used by the editor's
//                               // HTML Design preview, which renders silently)
//   }
//
// The check runs in a real, VISIBLE Chromium window (headless: false) that
// is brought to the foreground, the same way lib/browser-tool/open-link.js
// opens links clicked in the in-app terminal — so the user can actually
// watch the agent's verification happen instead of it running invisibly in
// the background. If Playwright itself isn't installed/launchable, this
// script reports that via `ok: false` + `error`; the caller
// (services/agent/tools/browserCheckTool.ts) falls back to opening the URL
// in the OS default desktop browser in that case.
//
// Prints exactly one line of JSON to stdout (everything else, including any
// Playwright/browser noise, goes to stderr so the Rust side can reliably
// find '{' as the start of the payload, mirroring how scan_repo's run.js
// output is parsed):
//   {
//     "ok": true,
//     "url": "http://localhost:5173",
//     "finalUrl": "http://localhost:5173/",
//     "title": "My App",
//     "status": 200,
//     "screenshotBase64": "...",       // PNG, base64-encoded
//     "consoleMessages": [
//       { "type": "error", "text": "...", "location": "App.tsx:42" }
//     ],
//     "pageErrors": ["Uncaught TypeError: ..."],
//     "failedRequests": [
//       { "url": "...", "method": "GET", "failure": "net::ERR_CONNECTION_REFUSED" }
//     ],
//     "httpErrors": [
//       { "url": "...", "status": 404, "statusText": "Not Found" }
//     ],
//     "durationMs": 842
//   }

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

async function main() {
  const rawArgs = process.argv[2] || '{}';
  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `Invalid JSON args: ${e.message}` }));
    return;
  }

  const url = args.url;
  if (!url || typeof url !== 'string') {
    console.log(JSON.stringify({ ok: false, error: 'url is required.' }));
    return;
  }

  const waitMs = Number.isFinite(args.waitMs) ? Math.max(0, Math.min(args.waitMs, 15000)) : 1000;
  const fullPage = !!args.fullPage;
  const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : null;
  const width = Number.isFinite(args.width) ? args.width : 1280;
  const height = Number.isFinite(args.height) ? args.height : 800;
  const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(1000, Math.min(args.timeoutMs, 300000)) : 30000;
  const keepOpen = !!args.keepOpen;
  const headless = !!args.headless;

  const started = Date.now();

  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];

  // Visible, foreground window — same launch shape as open-link.js — so the
  // user can watch the agent actually verify the page instead of it running
  // invisibly. If Chromium can't be launched at all (Playwright not
  // installed, missing system deps, etc.), we report that below and the
  // TS-side caller falls back to the OS default desktop browser instead.
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless });
  } catch (e) {
    console.log(JSON.stringify({
      ok: false,
      error:
        `Failed to launch Chromium: ${e.message}. ` +
        `If this is the first run, install the browser binary: ` +
        `cd lib/browser-tool && npx playwright install chromium`,
    }));
    return;
  }

  try {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    // Make sure the window is actually in front, not just open — a fresh
    // window is normally focused on launch, but bringToFront() makes that
    // explicit rather than relying on OS/window-manager defaults.
    try { await page.bringToFront(); } catch { /* best-effort */ }

    page.on('console', (msg) => {
      consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        location: (() => {
          const loc = msg.location();
          return loc && loc.url ? `${loc.url}:${loc.lineNumber ?? 0}` : undefined;
        })(),
      });
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err && err.message ? err.message : String(err));
    });

    page.on('requestfailed', (req) => {
      failedRequests.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure() ? req.failure().errorText : 'unknown failure',
      });
    });

    page.on('response', (res) => {
      const status = res.status();
      if (status >= 400) {
        httpErrors.push({ url: res.url(), status, statusText: res.statusText() });
      }
    });

    let status = null;
    let navError = null;
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      status = response ? response.status() : null;
    } catch (e) {
      navError = e.message || String(e);
    }

    if (!navError) {
      if (selector) {
        try {
          await page.waitForSelector(selector, { timeout: timeoutMs });
        } catch (e) {
          pageErrors.push(`Selector "${selector}" not found within ${timeoutMs}ms: ${e.message}`);
        }
      }
      if (waitMs > 0) {
        await page.waitForTimeout(waitMs);
      }
    }

    let screenshotBase64 = null;
    try {
      const buf = await page.screenshot({ fullPage });
      screenshotBase64 = buf.toString('base64');
    } catch (e) {
      pageErrors.push(`Screenshot failed: ${e.message}`);
    }

    let title = '';
    try {
      title = await page.title();
    } catch {
      // ignore
    }

    const result = {
      ok: !navError,
      url,
      finalUrl: page.url(),
      title,
      status,
      navError: navError || undefined,
      screenshotBase64,
      consoleMessages: consoleMessages.slice(0, 200),
      pageErrors: pageErrors.slice(0, 100),
      failedRequests: failedRequests.slice(0, 100),
      httpErrors: httpErrors.slice(0, 100),
      durationMs: Date.now() - started,
    };

    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message || String(e) }));
  } finally {
    // By default the check window closes once the screenshot/diagnostics
    // are captured. With keepOpen the window is left up so the user can
    // keep looking at what the agent just verified (closed by hand, or
    // automatically when the process is killed).
    if (!keepOpen) {
      await browser.close().catch(() => {});
    } else {
      browser.on('disconnected', () => process.exit(0));
    }
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message || String(e) }));
  process.exit(0);
});
