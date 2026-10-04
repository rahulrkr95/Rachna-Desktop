# browser-tool

Playwright-driven browser sidecars used by Rachna IDE's agent and terminal.
Three scripts:

- **`run.js`** — powers the `browser_check` tool. Loads ONE url (typically
  your localhost dev server, e.g. `http://localhost:5173`, or a URL from the
  `live_server_preview` tool for plain static HTML/CSS/JS repos) in a real,
  VISIBLE Chromium window brought to the foreground (not headless), takes a
  screenshot, and reads back console output, uncaught exceptions, failed
  network requests, and HTTP error responses (4xx/5xx) — so the agent can
  confirm a frontend change actually rendered/ran instead of guessing from
  source code alone, and the user can watch it happen. Pass `"keepOpen":
  true` to leave the window open afterwards instead of it closing
  automatically. If Playwright can't launch at all, it reports `ok: false` +
  `error` and the TS-side `browser_check` tool falls back to opening the URL
  in the OS default desktop browser instead.
- **`open-link.js`** — powers clicking a link in the in-app terminal. Also
  opens a real, visible (or `--background`, minimized) Chromium window —
  `run.js` reuses the same "visible foreground window" shape for consistency.
- **`web-task.js`** — powers the `web_task` tool, used for the BROWSER_TASK
  intent (see `lib/intentClassifier.ts`): general, UNAUTHENTICATED work on
  the open web. Takes an ordered list of steps (`goto`, `click`, `fill`,
  `press`, `waitFor`, `wait`, `extractText`, `extractAttr`, `screenshot`)
  and drives one browser session through all of them, returning whatever
  text/attributes were extracted. This never loads cookies or saved
  sign-in state — it's always an anonymous visitor. Anything needing the
  user's own logged-in account on a specific service belongs behind a real
  MCP connector instead.

All three are thin wrappers around the same Chromium install — no separate
setup needed per script.

## One-time setup

```bash
cd lib/browser-tool
npm install
npx playwright install chromium
```

This downloads a private Chromium build into Playwright's cache
(~150-300MB) — it does not use any browser already installed on your system.
You only need to do this once per machine.

## How they're invoked

The Rust commands `run_browser_check`, `open_terminal_link`, and
`run_web_task` (in `src-tauri/src/commands.rs`) spawn these scripts as
`node run.js '<json-args>'` / `node open-link.js '<url>' [--foreground|--background]`
/ `node web-task.js '<json-args>'`, the same way `scan_repo` spawns
`lib/repo-scanner/dist/run.js`. Each prints a single line of JSON to stdout.

You generally don't need to run these directly — the agent calls them
through the `browser_check` / `web_task` tools, and the terminal calls
`open-link.js` when a link is clicked — but you can test them manually:

```bash
node run.js '{"url":"http://localhost:5173","fullPage":true}'

node web-task.js '{"steps":[
  {"action":"goto","url":"https://example.com"},
  {"action":"extractText","selector":"h1","as":"heading"}
]}'
```
