// services/agent/postMergeVerification.ts
//
// After a proposed edit (single or batch) is merged to disk, the agent
// previously had no forcing function to actually EXECUTE and VERIFY the
// result — it could (and sometimes did) just report the task as done from
// reading its own source diff. This module inspects the set of files that
// were just written and, if any of them are frontend/UI or backend/API
// surfaces, produces a mandatory verification instruction that is injected
// into the next agent turn via EditStore.verificationNudges → useChat's
// verificationContext pipeline (see components/AiChat/useChat.ts).
//
// This is deliberately conservative: it only fires for file types where a
// concrete, cheap verification action exists (browser_check for rendered
// UI, curl_request/run_terminal_command for API endpoints). It never
// blocks the merge itself — merging is still a single atomic action
// (see EditStore.acceptBatch / acceptAll) — it only shapes what the agent
// is told to do on its NEXT turn.

const FRONTEND_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'jsx', 'tsx', 'vue', 'svelte',
])

// Extensions that are only "frontend" in a narrower sense — plain .ts/.js
// files are counted as frontend ONLY when their path signals UI (components,
// pages, views, styles) rather than shared/backend logic.
const FRONTEND_PATH_HINTS = ['/components/', '/pages/', '/views/', '/src/', '/public/', '/styles/']

const BACKEND_EXTENSIONS = new Set(['go', 'py', 'rb', 'java', 'cs'])
const BACKEND_PATH_HINTS = [
  '/api/', '/routes/', '/route/', '/handlers/', '/handler/',
  '/controllers/', '/controller/', '/services/', '/endpoints/', 'src-tauri/src',
]

function ext(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? ''
}

function normalized(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

export interface MergedFileClassification {
  frontend: string[]
  backend: string[]
}

export function classifyMergedFiles(filePaths: string[]): MergedFileClassification {
  const frontend: string[] = []
  const backend: string[] = []

  for (const filePath of filePaths) {
    const e = ext(filePath)
    const p = normalized(filePath)

    if (FRONTEND_EXTENSIONS.has(e)) {
      frontend.push(filePath)
      continue
    }
    if ((e === 'ts' || e === 'js') && FRONTEND_PATH_HINTS.some(h => p.includes(h))) {
      frontend.push(filePath)
      continue
    }
    if (BACKEND_EXTENSIONS.has(e) || BACKEND_PATH_HINTS.some(h => p.includes(h))) {
      backend.push(filePath)
      continue
    }
  }

  return { frontend, backend }
}

/**
 * Builds a mandatory, tool-specific verification instruction for the files
 * that were just merged. Returns undefined if nothing in the change set
 * warrants an execution/verification step (e.g. only docs, config, or
 * pure-logic files with no rendered or served surface).
 */
export function buildPostMergeVerificationNudge(filePaths: string[]): string | undefined {
  if (filePaths.length === 0) return undefined

  const { frontend, backend } = classifyMergedFiles(filePaths)
  if (frontend.length === 0 && backend.length === 0) return undefined

  const lines: string[] = [
    '## ⚠️ Required Execution & Verification (do NOT skip)',
    'The following files were just merged to disk. Reading the diff back is NOT verification — ' +
    'you must actually RUN the change and confirm it works before telling the user it is done.',
  ]

  if (frontend.length > 0) {
    lines.push(
      '',
      `Frontend/UI files changed: ${frontend.join(', ')}`,
      '- If a dev server is not already running, start it with run_terminal_command.',
      '- Call browser_check against the affected page/route on the running dev server and read ' +
      'the screenshot plus console/network errors it returns.',
      '- If browser_check reports errors, fix them and re-check before concluding the task.',
    )
  }

  if (backend.length > 0) {
    lines.push(
      '',
      `Backend/API files changed: ${backend.join(', ')}`,
      '- If the service is not already running, start it with run_terminal_command.',
      '- Call curl_request (or run_terminal_command with curl) against the affected endpoint(s) ' +
      'and confirm the response status/body match what you intended.',
      '- If the call fails or returns unexpected output, fix it and re-verify before concluding.',
    )
  }

  lines.push(
    '',
    'Only report this task as complete once the above verification has actually been executed ' +
    'and passed.'
  )

  return lines.join('\n')
}
