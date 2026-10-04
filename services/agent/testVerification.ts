// services/agent/testVerification.ts
//
// Test verification runs the project's test command after an AI-generated
// edit is accepted, then surfaces failures in the UI and agent context.
//
// Design mirrors buildVerification.ts:
//   - Detects test command by inspecting package.json / Cargo.toml / go.mod
//   - Runs via Tauri `run_terminal_command`
//   - Result stored in EditStore via `setTestResult`
//   - On failure, agentContext is injected into the next agent prompt
//
// Supported test runners (in priority order):
//   - package.json scripts.test  → <pm> test
//   - Jest / Vitest / Mocha detected as devDependencies
//   - Cargo.toml                 → cargo test
//   - go.mod                     → go test ./...

import { invoke } from '@tauri-apps/api/core'

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'running'

export interface TestVerificationResult {
  editId: string
  status: TestStatus
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  /** One-line summary for UI display */
  summary: string
  /** Multi-line context to inject into agent on failure */
  agentContext: string
  /** Parsed test counts if available */
  counts?: {
    passed: number
    failed: number
    skipped: number
    total: number
  }
}

interface TauriCommandResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
}

interface DetectedTest {
  command: string
  reason: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_TIMEOUT_SECONDS = 120

// ── Test command detection ────────────────────────────────────────────────────

/**
 * Infers the best test command for the project at `root`.
 * Returns null when no recognisable test setup is found.
 */
export async function detectTestCommand(root: string): Promise<DetectedTest | null> {
  // 1. Try package.json
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat package.json',
      cwd: root,
      timeoutSeconds: 5,
    })

    if (r.exit_code === 0 && r.stdout) {
      const pkg = JSON.parse(r.stdout) as {
        scripts?: Record<string, string>
        devDependencies?: Record<string, string>
        dependencies?: Record<string, string>
      }

      const pm = await detectPackageManager(root)

      // Explicit test script wins
      if (pkg.scripts?.test && !isPlaceholderTestScript(pkg.scripts.test)) {
        return {
          command: `${pm} test`,
          reason: `package.json scripts.test via ${pm}`,
        }
      }

      // Fall back to known test runner binaries in devDependencies
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

      if (allDeps?.vitest) {
        return { command: `${pm} run test`, reason: 'Vitest detected' }
      }
      if (allDeps?.jest) {
        return {
          command: 'npx jest --passWithNoTests',
          reason: 'Jest detected in devDependencies',
        }
      }
      if (allDeps?.mocha) {
        return { command: 'npx mocha', reason: 'Mocha detected in devDependencies' }
      }
    }
  } catch {
    // package.json not found or invalid JSON
  }

  // 2. Cargo.toml → cargo test
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat Cargo.toml',
      cwd: root,
      timeoutSeconds: 5,
    })
    if (r.exit_code === 0 && r.stdout) {
      return { command: 'cargo test', reason: 'Cargo.toml detected' }
    }
  } catch {
    // no Cargo.toml
  }

  // 3. go.mod → go test ./...
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat go.mod',
      cwd: root,
      timeoutSeconds: 5,
    })
    if (r.exit_code === 0 && r.stdout) {
      return { command: 'go test ./...', reason: 'go.mod detected' }
    }
  } catch {
    // no go.mod
  }

  // 4. pyproject.toml → pytest
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat pyproject.toml',
      cwd: root,
      timeoutSeconds: 5,
    })
    if (r.exit_code === 0 && r.stdout) {
      return { command: 'python -m pytest -q', reason: 'pyproject.toml detected' }
    }
  } catch {
    // no pyproject.toml
  }

  // 5. *.csproj → dotnet test
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'find . -maxdepth 2 -iname "*.csproj" 2>/dev/null | head -n 1 || dir /b /s "*.csproj" 2>nul',
      cwd: root,
      timeoutSeconds: 5,
    })
    if (r.exit_code === 0 && r.stdout.trim()) {
      return { command: 'dotnet test', reason: '.csproj detected' }
    }
  } catch {
    // no .csproj
  }

  // 6. pom.xml → mvn test
  try {
    const r = await invoke<TauriCommandResult>('run_terminal_command', {
      command: 'cat pom.xml',
      cwd: root,
      timeoutSeconds: 5,
    })
    if (r.exit_code === 0 && r.stdout) {
      return { command: 'mvn -q -o test || mvn -q test', reason: 'pom.xml detected' }
    }
  } catch {
    // no pom.xml
  }

  return null
}

/** Returns true if the test script is the npm/yarn placeholder ("echo Error…"). */
function isPlaceholderTestScript(script: string): boolean {
  return script.toLowerCase().includes('echo') && script.toLowerCase().includes('error')
}

async function detectPackageManager(root: string): Promise<'pnpm' | 'yarn' | 'bun' | 'npm'> {
  const checks: Array<{ file: string; pm: 'pnpm' | 'yarn' | 'bun' }> = [
    { file: 'pnpm-lock.yaml', pm: 'pnpm' },
    { file: 'yarn.lock',      pm: 'yarn' },
    { file: 'bun.lockb',      pm: 'bun'  },
  ]
  for (const { file, pm } of checks) {
    try {
      const r = await invoke<TauriCommandResult>('run_terminal_command', {
        command: `cat ${file}`,
        cwd: root,
        timeoutSeconds: 3,
      })
      if (r.exit_code === 0) return pm
    } catch {
      // lock file not found
    }
  }
  return 'npm'
}

// ── Output parsing ────────────────────────────────────────────────────────────

interface TestCounts {
  passed: number
  failed: number
  skipped: number
  total: number
}

/**
 * Best-effort parsing of common test runner output formats:
 * - Jest:   "Tests: 2 failed, 10 passed, 12 total"
 * - Vitest: "✓ 10 | ✗ 2 | ↓ 1"  or  "10 passed | 2 failed"
 * - Go:     "ok  ./..."  /  "FAIL  ./..."
 * - Cargo:  "test result: ok. 5 passed; 0 failed"
 */
function parseTestOutput(stdout: string, stderr: string): TestCounts | undefined {
  const combined = `${stdout}\n${stderr}`

  // Jest / Vitest: "Tests: 2 failed, 10 passed, 12 total"
  const jestMatch = combined.match(
    /Tests?:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+passed(?:,\s*)?)?(\d+)\s+total/i
  )
  if (jestMatch) {
    const failed  = parseInt(jestMatch[1] ?? '0', 10)
    const skipped = parseInt(jestMatch[2] ?? '0', 10)
    const passed  = parseInt(jestMatch[3] ?? '0', 10)
    const total   = parseInt(jestMatch[4] ?? '0', 10)
    return { passed, failed, skipped, total }
  }

  // Vitest summary: "✓ 10 passed | ✗ 2 failed"
  const vitestMatch = combined.match(/(\d+)\s+passed.*?(\d+)\s+failed/i)
  if (vitestMatch) {
    const passed = parseInt(vitestMatch[1], 10)
    const failed = parseInt(vitestMatch[2], 10)
    return { passed, failed, skipped: 0, total: passed + failed }
  }

  // Cargo: "test result: ok. 5 passed; 0 failed; 0 ignored"
  const cargoMatch = combined.match(
    /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/i
  )
  if (cargoMatch) {
    const passed  = parseInt(cargoMatch[1], 10)
    const failed  = parseInt(cargoMatch[2], 10)
    const skipped = parseInt(cargoMatch[3], 10)
    return { passed, failed, skipped, total: passed + failed + skipped }
  }

  return undefined
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Runs project tests after an edit is accepted.
 * Never throws — always returns a TestVerificationResult.
 */
export async function verifyTests(
  projectRoot: string,
  editId: string
): Promise<TestVerificationResult> {
  const skipped = (reason: string): TestVerificationResult => ({
    editId,
    status: 'skipped',
    command: '',
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    summary: reason,
    agentContext: '',
  })

  let detected: DetectedTest | null
  try {
    detected = await detectTestCommand(projectRoot)
  } catch {
    return skipped('Could not detect test command — test verification skipped.')
  }

  if (!detected) {
    return skipped('No recognisable test setup found — test verification skipped.')
  }

  const { command } = detected

  let raw: TauriCommandResult
  try {
    raw = await invoke<TauriCommandResult>('run_terminal_command', {
      command,
      cwd: projectRoot,
      timeoutSeconds: TEST_TIMEOUT_SECONDS,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      editId,
      status: 'failed',
      command,
      exitCode: null,
      stdout: '',
      stderr: msg,
      durationMs: 0,
      timedOut: false,
      summary: `Test runner failed to start: ${msg}`,
      agentContext: testFailureContext(command, projectRoot, editId, '', msg, null, false, undefined),
    }
  }

  const durationSec = (raw.duration_ms / 1000).toFixed(1)
  const counts = parseTestOutput(raw.stdout, raw.stderr)
  const success = raw.exit_code === 0 && !raw.timed_out

  if (success) {
    const countStr = counts
      ? ` — ${counts.passed}/${counts.total} passed`
      : ''
    return {
      editId,
      status: 'passed',
      command,
      exitCode: raw.exit_code,
      stdout: raw.stdout,
      stderr: raw.stderr,
      durationMs: raw.duration_ms,
      timedOut: false,
      summary: `✅ Tests passed (${durationSec}s)${countStr}`,
      agentContext: '',
      counts,
    }
  }

  const summary = raw.timed_out
    ? `⏱ Tests timed out after ${TEST_TIMEOUT_SECONDS}s — ${command}`
    : counts && counts.failed > 0
      ? `❌ ${counts.failed} test(s) failed, ${counts.passed} passed (${durationSec}s)`
      : `❌ Tests failed (exit ${raw.exit_code ?? '?'}, ${durationSec}s) — ${command}`

  return {
    editId,
    status: 'failed',
    command,
    exitCode: raw.exit_code,
    stdout: raw.stdout,
    stderr: raw.stderr,
    durationMs: raw.duration_ms,
    timedOut: raw.timed_out,
    summary,
    agentContext: testFailureContext(
      command, projectRoot, editId,
      raw.stdout, raw.stderr, raw.exit_code, raw.timed_out, counts
    ),
    counts,
  }
}

// ── Agent context builder ─────────────────────────────────────────────────────

function testFailureContext(
  command: string,
  cwd: string,
  editId: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean,
  counts: TestCounts | undefined
): string {
  const lines: string[] = [
    '### ⚠️ Test Verification FAILED',
    '',
    `**Command:** \`${command}\``,
    `**Working directory:** ${cwd}`,
    `**Edit ID:** ${editId}`,
    `**Exit code:** ${timedOut ? 'killed (timeout)' : (exitCode ?? 'unknown')}`,
  ]

  if (counts) {
    lines.push(
      `**Results:** ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`,
    )
  }

  lines.push('')

  const trimLines = (text: string, max: number) =>
    text.split('\n').slice(-max).join('\n')

  if (stderr.trim()) {
    lines.push('**stderr:**', '```', trimLines(stderr, 80), '```', '')
  }
  if (stdout.trim()) {
    lines.push('**stdout:**', '```', trimLines(stdout, 80), '```', '')
  }

  lines.push(
    'Tests failed after your last edit. You MUST fix these failures before proceeding.',
    'Use `run_terminal_command` to re-run tests after each fix attempt.',
    'Do NOT silently ignore these failures.',
  )

  return lines.join('\n')
}
