// services/agent/buildVerification.ts
//
// Build verification runs the project's build command after an AI-generated
// edit is accepted, then stamps the edit as "verified" or "failed".
//
// Design:
//   - Detects the build command by inspecting package.json / Cargo.toml at
//     the project root.
//   - Runs the command via the same Tauri `run_terminal_command` back-end used
//     by terminalTool so we get timeout protection for free.
//   - The result is stored in the EditStore via `setBuildVerification` so any
//     component can subscribe reactively.
//   - If the build fails, the full stdout + stderr are surfaced in the agent
//     context on the next turn, ensuring the agent never silently ignores
//     failures.
//
// Usage (called from EditStore.acceptEdit after the file is written):
//
//   import { verifyBuild } from '../agent/buildVerification'
//   const result = await verifyBuild(projectRoot, editId)
//   if (!result.success) {
//     // Inject result.summary into the next agent prompt
//   }

import { invoke } from '@tauri-apps/api/core'

// ── Types ─────────────────────────────────────────────────────────────────────

export type BuildStatus = 'verified' | 'failed' | 'skipped' | 'running'

export interface BuildVerificationResult {
  editId: string
  status: BuildStatus
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  /** One-line summary suitable for display in the UI */
  summary: string
  /** Multi-line context to inject into the agent if the build fails */
  agentContext: string
}

interface TauriCommandResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
}

// ── Build command detection ───────────────────────────────────────────────────

const BUILD_TIMEOUT_SECONDS = 120

interface DetectedBuild {
  command: string
  /** Why this command was chosen */
  reason: string
}

/**
 * Tries to infer the best build command for the project at `root`.
 * Returns null when no recognisable build system is found.
 */
export async function detectBuildCommand(root: string): Promise<DetectedBuild | null> {
  // 1. Try package.json → scripts.build
  try {
    const pkgJson = await invoke<{ stdout: string; stderr: string; exit_code: number | null; timed_out: boolean; duration_ms: number }>(
      'run_terminal_command',
      { command: 'cat package.json', cwd: root, timeoutSeconds: 5 }
    )
    if (pkgJson.exit_code === 0 && pkgJson.stdout) {
      const pkg = JSON.parse(pkgJson.stdout) as {
        scripts?: Record<string, string>
        devDependencies?: Record<string, string>
        dependencies?: Record<string, string>
      }

      if (pkg.scripts?.build) {
        // Detect package manager from lock files
        const pm = await detectPackageManager(root)
        return {
          command: `${pm} run build`,
          reason: `package.json scripts.build via ${pm}`,
        }
      }

      // TypeScript project without explicit build script → tsc
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (allDeps?.typescript) {
        return {
          command: 'npx tsc --noEmit',
          reason: 'TypeScript project (no build script) — type-check only',
        }
      }
    }
  } catch {
    // package.json not found or not JSON — continue
  }

  // 2. Cargo.toml → cargo build
  try {
    const cargoCheck = await invoke<TauriCommandResult>(
      'run_terminal_command',
      { command: 'cat Cargo.toml', cwd: root, timeoutSeconds: 5 }
    )
    if (cargoCheck.exit_code === 0 && cargoCheck.stdout) {
      return { command: 'cargo build', reason: 'Cargo.toml detected' }
    }
  } catch {
    // no Cargo.toml
  }

  // 3. go.mod → go build ./...
  try {
    const goCheck = await invoke<TauriCommandResult>(
      'run_terminal_command',
      { command: 'cat go.mod', cwd: root, timeoutSeconds: 5 }
    )
    if (goCheck.exit_code === 0 && goCheck.stdout) {
      return { command: 'go build ./...', reason: 'go.mod detected' }
    }
  } catch {
    // no go.mod
  }

  // 4. pyproject.toml → compileall (catches syntax errors across the project;
  //    there's no universal "build" step for Python, so this is the closest
  //    cheap, dependency-free equivalent — it will fail loudly on anything
  //    that doesn't even parse).
  try {
    const pyCheck = await invoke<TauriCommandResult>(
      'run_terminal_command',
      { command: 'cat pyproject.toml', cwd: root, timeoutSeconds: 5 }
    )
    if (pyCheck.exit_code === 0 && pyCheck.stdout) {
      return { command: 'python -m compileall -q .', reason: 'pyproject.toml detected' }
    }
  } catch {
    // no pyproject.toml
  }

  // 5. *.csproj → dotnet build
  try {
    const csCheck = await invoke<TauriCommandResult>(
      'run_terminal_command',
      { command: findFirstFileCommand('*.csproj'), cwd: root, timeoutSeconds: 5 }
    )
    if (csCheck.exit_code === 0 && csCheck.stdout.trim()) {
      return { command: 'dotnet build', reason: '.csproj detected' }
    }
  } catch {
    // no .csproj
  }

  // 6. pom.xml → mvn compile
  try {
    const mvnCheck = await invoke<TauriCommandResult>(
      'run_terminal_command',
      { command: 'cat pom.xml', cwd: root, timeoutSeconds: 5 }
    )
    if (mvnCheck.exit_code === 0 && mvnCheck.stdout) {
      return { command: 'mvn -q -o compile || mvn -q compile', reason: 'pom.xml detected' }
    }
  } catch {
    // no pom.xml
  }

  return null
}

// Cross-platform "does a file matching this glob exist in the project root"
// probe. Uses find on POSIX shells; falls back to a dir-based glob on
// Windows via the terminal tool's own shell detection (run_terminal_command
// executes through the user's real shell, so a plain `find`/`dir` pair
// covers the common cases without needing OS branching here).
function findFirstFileCommand(glob: string): string {
  return `find . -maxdepth 2 -iname "${glob}" 2>/dev/null | head -n 1 || dir /b /s "${glob}" 2>nul`
}

async function detectPackageManager(root: string): Promise<'pnpm' | 'yarn' | 'bun' | 'npm'> {
  const checks: Array<{ file: string; pm: 'pnpm' | 'yarn' | 'bun' }> = [
    { file: 'pnpm-lock.yaml', pm: 'pnpm' },
    { file: 'yarn.lock',      pm: 'yarn' },
    { file: 'bun.lockb',      pm: 'bun' },
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
      // not found
    }
  }
  return 'npm'
}

// ── Main verification entry point ─────────────────────────────────────────────

/**
 * Runs the project build after an edit is accepted.
 *
 * @param projectRoot  Absolute path to the project root
 * @param editId       The EditStore id of the accepted edit (used for storage)
 * @returns            BuildVerificationResult — never throws
 */
export async function verifyBuild(
  projectRoot: string,
  editId: string
): Promise<BuildVerificationResult> {
  const skipped = (reason: string): BuildVerificationResult => ({
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

  // ── Detect build command ──────────────────────────────────────────────────
  let detected: DetectedBuild | null
  try {
    detected = await detectBuildCommand(projectRoot)
  } catch {
    return skipped('Could not detect build command — build verification skipped.')
  }

  if (!detected) {
    return skipped('No recognisable build system found — build verification skipped.')
  }

  const { command } = detected

  // ── Run the build ─────────────────────────────────────────────────────────
  let raw: TauriCommandResult
  try {
    raw = await invoke<TauriCommandResult>('run_terminal_command', {
      command,
      cwd: projectRoot,
      timeoutSeconds: BUILD_TIMEOUT_SECONDS,
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
      summary: `Build command failed to start: ${msg}`,
      agentContext: buildFailureContext(command, projectRoot, editId, '', msg, null, false),
    }
  }

  const success = raw.exit_code === 0 && !raw.timed_out
  const durationSec = (raw.duration_ms / 1000).toFixed(1)

  if (success) {
    return {
      editId,
      status: 'verified',
      command,
      exitCode: raw.exit_code,
      stdout: raw.stdout,
      stderr: raw.stderr,
      durationMs: raw.duration_ms,
      timedOut: false,
      summary: `✅ Build verified (${durationSec}s) — ${command}`,
      agentContext: '',  // no context needed on success
    }
  }

  // ── Build failed ──────────────────────────────────────────────────────────
  const summary = raw.timed_out
    ? `⏱ Build timed out after ${BUILD_TIMEOUT_SECONDS}s — ${command}`
    : `❌ Build failed (exit ${raw.exit_code ?? '?'}, ${durationSec}s) — ${command}`

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
    agentContext: buildFailureContext(
      command, projectRoot, editId,
      raw.stdout, raw.stderr, raw.exit_code, raw.timed_out
    ),
  }
}

// ── Agent context builder ─────────────────────────────────────────────────────

function buildFailureContext(
  command: string,
  cwd: string,
  editId: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean
): string {
  const lines: string[] = [
    '### ⚠️ Build Verification FAILED',
    '',
    `**Command:** \`${command}\``,
    `**Working directory:** ${cwd}`,
    `**Edit ID:** ${editId}`,
    `**Exit code:** ${timedOut ? 'killed (timeout)' : (exitCode ?? 'unknown')}`,
    '',
  ]

  // Trim output to avoid flooding context — keep last 80 lines of each stream
  const trimLines = (text: string, max: number) =>
    text.split('\n').slice(-max).join('\n')

  if (stderr.trim()) {
    lines.push('**stderr:**', '```', trimLines(stderr, 80), '```', '')
  }

  if (stdout.trim()) {
    lines.push('**stdout:**', '```', trimLines(stdout, 80), '```', '')
  }

  lines.push(
    'The build failed after your last edit. You MUST fix these errors before proceeding.',
    'Use `run_terminal_command` to re-run the build after each fix attempt.',
    'Do NOT silently ignore these errors.',
  )

  return lines.join('\n')
}
