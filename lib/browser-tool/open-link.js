// lib/browser-tool/open-link.js
//
// Sidecar invoked by the Rust `open_terminal_link` Tauri command (see
// src-tauri/src/commands.rs), which is called when the user clicks a
// clickable link inside the in-app terminal (TerminalPanel.tsx).
//
// Unlike run.js (headless, used by the agent's browser_check tool), this
// script launches a *visible* Chromium window so the user can actually see
// and interact with the page the link points to.
//
// Usage:
//   node open-link.js '<url>' [--foreground|--background]
//
// By default (or with --foreground) the Chromium window opens normally,
// clearly visible and focused. With --background it's launched the same
// way but immediately minimized via CDP so it doesn't steal focus from the
// IDE — this is what backs the "Open links in the background" setting
// (Settings > Terminal, see useTerminalSettingsStore.ts / commands.rs).
//
// Prints exactly one line of JSON to stdout:
//   { "ok": true }
//   { "ok": false, "error": "Playwright is not installed..." }
//
// On success this process intentionally does NOT exit — it keeps running so
// the Chromium window it launched stays open. The Rust side only waits for
// the first line of stdout (or early exit) before deciding whether to fall
// back to the OS default browser; it does not wait for this process itself
// to terminate.

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
  console.log(JSON.stringify({
    ok: false,
    error:
      'Playwright is not installed. Run: cd lib/browser-tool && npm install && npx playwright install chromium',
  }));
  process.exit(0);
}

async function main() {
  const url = process.argv[2];
  const mode = process.argv[3];
  const background = mode === '--background';

  if (!url || typeof url !== 'string') {
    console.log(JSON.stringify({ ok: false, error: 'url is required.' }));
    process.exit(0);
    return;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: false });
  } catch (e) {
    console.log(JSON.stringify({
      ok: false,
      error:
        `Failed to launch Chromium: ${e.message}. ` +
        `If this is the first run, install the browser binary: ` +
        `cd lib/browser-tool && npx playwright install chromium`,
    }));
    process.exit(0);
    return;
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {
      // Navigation errors (DNS, timeout, etc.) still leave a usable window
      // open — the user can see the error page Chromium itself renders.
    });

    if (background) {
      // Minimize the window via CDP so it doesn't steal focus from the IDE.
      // This still opens a real, interactive window — just out of the way —
      // rather than running headless, so the user can restore it from the
      // taskbar at any time.
      try {
        const client = await context.newCDPSession(page);
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'minimized' },
        });
      } catch {
        // Best-effort — if minimizing fails for any reason, the window is
        // still usable in the foreground; not worth failing the whole call.
      }
    }

    // Report success once the window is up and navigation has settled (or
    // timed out) rather than immediately after launch, so a fast "playwright
    // not installed" failure and a real success are both single, final lines.
    console.log(JSON.stringify({ ok: true }));

    // Close the browser automatically when the user closes the window/tab,
    // rather than leaving an orphaned process behind.
    browser.on('disconnected', () => process.exit(0));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
    try { await browser.close(); } catch {}
    process.exit(0);
  }
}

main();
