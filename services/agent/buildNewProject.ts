// services/agent/buildNewProject.ts
import type { AIProvider } from '../../lib/providers/types'
import { useEditStore } from '../edits/EditStore'
import { useUnsavedProjectStore } from '../../store/useUnsavedProjectStore'
import { resolveWorkspacePath } from './pathUtils'
import {
  FILE_TREE_SYSTEM_PROMPT,
  FILE_CONTENT_SYSTEM_PROMPT,
  DESIGN_FILE_TREE_SYSTEM_PROMPT,
  DESIGN_FILE_CONTENT_SYSTEM_PROMPT,
  buildFileTreeUserPrompt,
  buildFileContentUserPrompt,
  parseFileTreeResponse,
  stripCodeFences,
  type ProposedFileTreeEntry,
} from '../../components/AiChat/prompts'
import { loggedStream } from '../../lib/llmCallLogger'

const MAX_FILES = 60
const CONTENT_CONCURRENCY = 5
const TREE_TIMEOUT_MS = 45_000
const CONTENT_TIMEOUT_MS = 90_000
const PLACEHOLDER_CONTENT = '// ⏳ Generating content for this file…\n'

export interface BuildNewProjectParams {
  originalRequest: string
  projectName: string
  projectPath: string | null
  provider: AIProvider
  apiKey: string
  model?: string
  mode?: 'code' | 'design'
  onProgress: (body: string) => void
  /**
   * When true (the only case this flow is ever invoked from — see
   * runDecomposedSteps/handleSend in useChat.ts, both of which only route
   * build_new_project/design_project here, never work_with_repo) and a real
   * project path is involved (isUnsavedDesign false), the proposed batch is
   * accepted/written to disk automatically instead of being left pending
   * for a manual "Merge Batch" click. Creating the project/design IS the
   * request itself for these intents — there's no separate review step to
   * defer to, and no way to ask the user again mid-flow. Has no effect for
   * an unsaved in-memory project (isUnsavedDesign true), which never goes
   * through the EditStore review pipeline in the first place.
   */
  autoAccept?: boolean
}

export interface BuildNewProjectResult {
  ok: boolean
  fileCount: number
  error?: string
}

function runCompletion(
  provider: AIProvider,
  apiKey: string,
  model: string | undefined,
  systemInstruction: string,
  userText: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('completion timeout')),
      timeoutMs,
    )
    loggedStream(
      'new_project_generation',
      provider,
      apiKey,
      [{ role: 'user', content: userText }],
      {
        onChunk: () => {},
        onDone: (fullText) => {
          clearTimeout(timeout)
          resolve(fullText)
        },
        onError: (err) => {
          clearTimeout(timeout)
          reject(err)
        },
      },
      { model, systemInstruction, temperature: 0.3 },
    ).catch((err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        await worker(items[index], index)
      }
    },
  )
  await Promise.all(runners)
}

export async function runBuildNewProjectFlow(
  params: BuildNewProjectParams,
): Promise<BuildNewProjectResult> {
  const {
    originalRequest,
    projectName,
    projectPath,
    provider,
    apiKey,
    model,
    onProgress,
  } = params
  const mode = params.mode ?? 'code'
  const noun = mode === 'design' ? 'page' : 'file'
  // Whenever there's no real project folder yet (build_new_project and
  // design_project both start this way now — see the classifier's
  // NEW_PROJECT flow in useChat.ts), every generated file is written
  // straight into the in-memory unsaved-project store instead of the
  // EditStore review-batch pipeline. This is mode-agnostic on purpose:
  // code projects get the exact same "generate into memory, review in the
  // Unsaved file tree, dialog only appears on Save" flow design projects
  // always had.
  const isUnsavedDesign = !projectPath

  onProgress(
    `Planning the ${mode === 'design' ? 'page' : 'file'} structure for **${projectName}**…`,
  )

  let treeRaw: string
  try {
    treeRaw = await runCompletion(
      provider,
      apiKey,
      model,
      mode === 'design'
        ? DESIGN_FILE_TREE_SYSTEM_PROMPT
        : FILE_TREE_SYSTEM_PROMPT,
      buildFileTreeUserPrompt(originalRequest, projectName, mode),
      TREE_TIMEOUT_MS,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    onProgress(`⚠ Failed to plan the project file structure: ${message}`)
    return { ok: false, fileCount: 0, error: message }
  }

  const tree = parseFileTreeResponse(treeRaw)
  if (!tree || tree.files.length === 0) {
    onProgress(
      `⚠ Could not parse a valid file tree from the model's response. Please try again.`,
    )
    return { ok: false, fileCount: 0, error: 'unparseable file tree' }
  }

  const files = tree.files.slice(0, MAX_FILES)
  const resolved: Array<{
    entry: ProposedFileTreeEntry
    absPath: string
  }> = []

  for (const entry of files) {
    if (isUnsavedDesign) {
      resolved.push({
        entry,
        absPath: `unsaved://${entry.path}`,
      })
      continue
    }

    if (!projectPath) continue

    const r = resolveWorkspacePath(entry.path, projectPath)
    if (r.ok) {
      resolved.push({
        entry,
        absPath: r.path,
      })
    }
  }

  if (resolved.length === 0) {
    onProgress(`⚠ The model returned no valid file paths. Please try again.`)
    return { ok: false, fileCount: 0, error: 'no resolvable paths' }
  }

  const treeList = resolved
    .map(
      ({ entry }) =>
        `- \`${entry.path}\`${entry.description ? ` — ${entry.description}` : ''}`,
    )
    .join('\n')

  // Hoisted so the auto-accept step (after content generation) can still
  // reach the batchId — only ever set in the `!isUnsavedDesign` branch.
  let batchId: string | null = null

  if (isUnsavedDesign) {
    const unsavedStore = useUnsavedProjectStore.getState()
    for (const { entry } of resolved) {
      unsavedStore.setFile(entry.path, PLACEHOLDER_CONTENT)
    }
  } else {
    batchId = `build-${Date.now()}`
    useEditStore.getState().proposeBatch({
      batchId,
      batchName: projectName,
      entries: resolved.map(({ entry, absPath }) => ({
        filePath: absPath,
        originalContent: '',
        proposedContent: PLACEHOLDER_CONTENT,
        description: entry.description || entry.path,
      })),
      // build_new_project/design_project own this batch's whole lifecycle
      // when autoAccept is set (see buildCompletionNote's autoAccept branch
      // below) — there's no separate review step for the user to act on, so
      // it's excluded from the manual EditReviewBar/Merge All/Reject All
      // surface entirely (see PendingEdit.autoManaged in EditStore.ts) while
      // that holds. It still writes to disk and re-indexes through the
      // exact same acceptBatch() path as any other batch — just never via a
      // manual click. Tied to `autoAccept` itself (not hardcoded true) so a
      // caller that passes autoAccept: false still gets the normal,
      // reviewable batch behavior it always had.
      autoManaged: !!params.autoAccept,
    })
  }

  onProgress(
    (tree.projectSummary ? `${tree.projectSummary}\n\n` : '') +
      `Proposed **${resolved.length} ${noun}${resolved.length !== 1 ? 's' : ''}**:\n${treeList}\n\n` +
      `Generating content… (0/${resolved.length})`,
  )

  let completed = 0
  let failedCount = 0

  await runWithConcurrency(
    resolved,
    CONTENT_CONCURRENCY,
    async ({ entry, absPath }) => {
      try {
        const raw = await runCompletion(
          provider,
          apiKey,
          model,
          mode === 'design'
            ? DESIGN_FILE_CONTENT_SYSTEM_PROMPT
            : FILE_CONTENT_SYSTEM_PROMPT,
          buildFileContentUserPrompt({
            originalRequest,
            projectName,
            projectSummary: tree.projectSummary,
            targetPath: entry.path,
            targetDescription: entry.description,
            allFiles: files,
            mode,
          }),
          CONTENT_TIMEOUT_MS,
        )

        const content = stripCodeFences(raw)
        const finalContent =
          content || `// (model returned empty content for ${entry.path})\n`

        if (isUnsavedDesign) {
          useUnsavedProjectStore.getState().setFile(entry.path, finalContent)
        } else {
          useEditStore.getState().proposeEdit({
            filePath: absPath,
            originalContent: '',
            proposedContent: finalContent,
            description: entry.description || entry.path,
          })
        }
      } catch (err) {
        failedCount++
        const message = err instanceof Error ? err.message : String(err)
        const errorContent =
          `// ⚠ Failed to generate content for ${entry.path}: ${message}\n`

        if (isUnsavedDesign) {
          useUnsavedProjectStore.getState().setFile(entry.path, errorContent)
        } else {
          useEditStore.getState().proposeEdit({
            filePath: absPath,
            originalContent: '',
            proposedContent: errorContent,
            description: entry.description || entry.path,
          })
        }
      } finally {
        completed++
        onProgress(
          (tree.projectSummary ? `${tree.projectSummary}\n\n` : '') +
            `Proposed **${resolved.length} ${noun}${resolved.length !== 1 ? 's' : ''}**:\n${treeList}\n\n` +
            `Generating content… (${completed}/${resolved.length})`,
        )
      }
    },
  )

  const summary =
    (tree.projectSummary ? `${tree.projectSummary}\n\n` : '') +
    `✅ Generated **${resolved.length} ${noun}${resolved.length !== 1 ? 's' : ''}** for **${projectName}**` +
    (failedCount > 0 ? ` (${failedCount} failed)` : '') +
    `:\n${treeList}\n\n` +
    (await buildCompletionNote({ isUnsavedDesign, autoAccept: params.autoAccept, batchId }))

  onProgress(summary)
  return {
    ok: failedCount < resolved.length,
    fileCount: resolved.length,
  }
}

// ── buildCompletionNote ──────────────────────────────────────────────────
// The trailing line of the progress message, once every file has been
// generated. Also where auto-accept actually happens (see autoAccept's doc
// comment on BuildNewProjectParams above): build_new_project/design_project
// are never gated behind a manual Merge Batch click when a real project
// path is involved — that review step only makes sense for
// SOFTWARE:WORK_WITH_REPO, where the user has an existing project they didn't
// ask to have changed. Here, generating the batch IS the request, so it's
// written to disk immediately and indexed once, right after that single
// write — see EditStore.acceptBatch. If the auto-merge itself fails partway
// (or autoAccept was never requested), the batch is handed back to the
// user via clearAutoManaged() so it shows up in the normal EditReviewBar —
// autoManaged batches are otherwise invisible there (see
// PendingEdit.autoManaged), so silently leaving a failed one flagged
// autoManaged would strand it with no visible way to retry.
async function buildCompletionNote(opts: {
  isUnsavedDesign: boolean
  autoAccept?: boolean
  batchId: string | null
}): Promise<string> {
  const { isUnsavedDesign, autoAccept, batchId } = opts

  if (isUnsavedDesign) {
    return `The project is currently **Unsaved**. Save it (Ctrl/Cmd+S) when you want to choose a name and location and write it to disk.`
  }

  if (!batchId) {
    return `Review the proposed changes above and click **Merge Batch** to write them to disk. The project will be indexed automatically as soon as you accept.`
  }

  if (!autoAccept) {
    // Never flagged autoManaged in the first place (see proposeBatch call
    // above) — already a normal, visible batch.
    return `Review the proposed changes above and click **Merge Batch** to write them to disk. The project will be indexed automatically as soon as you accept.`
  }

  try {
    const { accepted, failed } = await useEditStore.getState().acceptBatch(batchId)
    if (failed > 0) {
      useEditStore.getState().clearAutoManaged(batchId)
      return `⚠ ${accepted} file${accepted !== 1 ? 's' : ''} merged, ${failed} failed to write — the remaining proposed change${failed !== 1 ? 's' : ''} above ${failed !== 1 ? 'are' : 'is'} now ready for you to review; click **Merge Batch** to retry.`
    }
    return `✓ Merged automatically — ${accepted} file${accepted !== 1 ? 's' : ''} written to disk and indexed.`
  } catch (err) {
    console.warn('[buildNewProject] auto-accept failed:', err)
    useEditStore.getState().clearAutoManaged(batchId)
    return `⚠ Auto-merge failed — the proposed changes above are now ready for you to review; click **Merge Batch** to write them to disk.`
  }
}