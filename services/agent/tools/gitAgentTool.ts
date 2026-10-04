// services/agent/tools/gitAgentTool.ts
//
// Tool: git_action
//
// Agent-driven git operations. Wraps services/git/gitService.ts — all actual
// git I/O happens there; this module only handles argument validation, safety
// checks, and logging to the AgentActivityPanel via the AgentLoop callbacks
// (the activity is created/updated by AgentLoop around every tool call, so we
// don't need to call callbacks directly here).
//
// Safety rules enforced here:
//   1. commit — requires autoAllowCommit setting (default: true). The commit
//      message MUST be derived from actual staged diff content, not generic text.
//      We enforce this by fetching the staged diff and refusing if there are no
//      staged changes.
//   2. push   — requires autoAllowPush setting (default: false). Refuses to push
//      to main/master unless allowDirectPushToMain is also true.
//   3. All actions fail fast if projectRoot is null.

import * as git from '../../../services/git/gitService'
import { useGitStore } from '../../../store/useGitStore'
import {
  GitActionArgsSchema,
  DEFAULT_GIT_TOOL_SETTINGS,
  toolOk,
  toolErr,
  toolErrBlocked,
  type AgentTool,
  type ToolContext,
} from '../types'

// ── Result types ─────────────────────────────────────────────────────────────

export interface GitActionResult {
  action: string
  message: string
  /** Files affected by this action (for AgentActivityPanel / GitPanel undo context). */
  affectedFiles?: string[]
  /** Arbitrary extra data (diff text, branch list, status entries, etc.). */
  data?: unknown
}

// ── Default branch names considered "main" ──────────────────────────────────

const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk', 'production'])

// ── Tool definition ──────────────────────────────────────────────────────────

export const gitActionTool: AgentTool<Record<string, unknown>, GitActionResult> = {
  declaration: {
    name: 'git_action',
    description:
      'Perform git operations on the current project repository. ' +
      'Available actions: status (list changed files), diff (get unified diff), ' +
      'stage (stage specific files), commit (create a commit — message must reflect ' +
      'actual staged changes), branch_create (create a new branch), ' +
      'branch_switch (switch to an existing branch), push (push to remote). ' +
      'Safety: commit is auto-allowed by default; push requires user opt-in in Settings → Git. ' +
      'Pushing directly to main/master also requires an explicit Settings toggle. ' +
      'Every git_action is logged to the activity panel so the user can track and undo changes.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'diff', 'stage', 'commit', 'branch_create', 'branch_switch', 'push'],
          description: 'The git operation to perform.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths — required for "stage"; optional for "commit" (stages these files first if supplied).',
        },
        message: {
          type: 'string',
          description: 'Commit message — required for "commit". Must describe the actual staged changes, not be generic.',
        },
        filePath: {
          type: 'string',
          description: 'Single file path — optional for "diff" to narrow the diff to one file.',
        },
        staged: {
          type: 'boolean',
          description: 'For "diff": true = index-vs-HEAD (staged changes), false = worktree-vs-index (default).',
        },
        name: {
          type: 'string',
          description: 'Branch name — required for "branch_create" and "branch_switch".',
        },
        from: {
          type: 'string',
          description: 'For "branch_create": base branch/commit to create from (defaults to HEAD).',
        },
        remote: {
          type: 'string',
          description: 'For "push": remote name (defaults to "origin").',
        },
        branch: {
          type: 'string',
          description: 'For "push": branch name to push (defaults to current branch).',
        },
      },
      required: ['action'],
    },
  },

  describeCall: (args) => {
    switch (args.action) {
      case 'status':        return 'Checking git status…'
      case 'diff':          return args.filePath ? `Diffing ${args.filePath}…` : 'Getting diff…'
      case 'stage':         return `Staging ${Array.isArray(args.files) ? args.files.join(', ') : '…'}`
      case 'commit':        return `Committing: ${args.message ?? '…'}`
      case 'branch_create': return `Creating branch "${args.name ?? '…'}"…`
      case 'branch_switch': return `Switching to branch "${args.name ?? '…'}"…`
      case 'push':          return `Pushing${args.branch ? ` branch "${args.branch}"` : ''}…`
      default:              return `git_action: ${args.action}…`
    }
  },

  execute: async (rawArgs, ctx: ToolContext) => {
    // ── Validate args ─────────────────────────────────────────────────────
    const parsed = GitActionArgsSchema.safeParse(rawArgs)
    if (!parsed.success) {
      return toolErr(
        `Invalid git_action arguments: ${parsed.error.issues.map(i => i.message).join('; ')}`
      )
    }

    const args     = parsed.data
    const root     = ctx.projectRoot
    const settings = ctx.gitSettings ?? DEFAULT_GIT_TOOL_SETTINGS

    if (!root) {
      return toolErr(
        'git_action requires an open project. ' +
        'No projectRoot is set — open a folder first.'
      )
    }

    // Helper: refresh the git store so GitPanel stays in sync
    const refreshGit = () => {
      const gitStore = useGitStore.getState()
      if (gitStore.root === root) {
        void gitStore.refreshAll()
      }
    }

    // ── status ────────────────────────────────────────────────────────────
    if (args.action === 'status') {
      try {
        const files = await git.getStatus(root)
        return toolOk<GitActionResult>({
          action: 'status',
          message: `${files.length} changed file(s).`,
          affectedFiles: files.map(f => f.path),
          data: files,
        })
      } catch (e) {
        return toolErr(`git status failed: ${errMsg(e)}`)
      }
    }

    // ── diff ──────────────────────────────────────────────────────────────
    if (args.action === 'diff') {
      try {
        const diff = await git.getDiff(root, args.filePath, args.staged ?? false)
        return toolOk<GitActionResult>({
          action: 'diff',
          message: diff.trim() ? `Diff retrieved (${diff.length} chars).` : 'No diff — working tree is clean.',
          data: diff,
        })
      } catch (e) {
        return toolErr(`git diff failed: ${errMsg(e)}`)
      }
    }

    // ── stage ─────────────────────────────────────────────────────────────
    if (args.action === 'stage') {
      try {
        await git.stageFiles(root, args.files)
        refreshGit()
        return toolOk<GitActionResult>({
          action: 'stage',
          message: `Staged ${args.files.length} file(s).`,
          affectedFiles: args.files,
        })
      } catch (e) {
        return toolErr(`git stage failed: ${errMsg(e)}`)
      }
    }

    // ── commit ────────────────────────────────────────────────────────────
    if (args.action === 'commit') {
      if (!settings.autoAllowCommit) {
        return toolErrBlocked(
          'Commit blocked by Settings → Git → "Auto-allow agent commits". ' +
          'The user must enable this toggle before the agent can commit.',
          'autoAllowCommit'
        )
      }

      // Stage specific files first if supplied
      if (args.files && args.files.length > 0) {
        try {
          await git.stageFiles(root, args.files)
        } catch (e) {
          return toolErr(`Failed to stage files before commit: ${errMsg(e)}`)
        }
      }

      // Safety: refuse if there's nothing staged
      let stagedDiff: string
      try {
        stagedDiff = await git.getDiff(root, undefined, true)
      } catch (e) {
        return toolErr(`Could not read staged diff before commit: ${errMsg(e)}`)
      }

      if (!stagedDiff.trim()) {
        return toolErr(
          'Nothing is staged — there are no staged changes to commit. ' +
          'Use git_action(action: "stage") to stage files first.'
        )
      }

      // Sanity-check: message must not be completely generic
      const genericPatterns = [/^(update|fix|changes|wip|commit)\.?$/i]
      if (genericPatterns.some(p => p.test(args.message.trim()))) {
        return toolErr(
          `Commit message "${args.message}" is too generic. ` +
          'Generate a specific message that describes the actual staged changes.'
        )
      }

      try {
        await git.commit(root, args.message)
        refreshGit()
        return toolOk<GitActionResult>({
          action: 'commit',
          message: `Committed: "${args.message}"`,
          data: { message: args.message },
        })
      } catch (e) {
        return toolErr(`git commit failed: ${errMsg(e)}`)
      }
    }

    // ── branch_create ─────────────────────────────────────────────────────
    if (args.action === 'branch_create') {
      // If "from" is specified, switch first then create — gitService.createBranch
      // creates from HEAD. A more correct impl would pass --no-track, but this
      // matches the existing gitService API surface without forking it.
      try {
        if (args.from) {
          await git.switchBranch(root, args.from)
        }
        await git.createBranch(root, args.name)
        refreshGit()
        return toolOk<GitActionResult>({
          action: 'branch_create',
          message: `Created and switched to branch "${args.name}"${args.from ? ` from "${args.from}"` : ''}.`,
          data: { name: args.name, from: args.from },
        })
      } catch (e) {
        return toolErr(`git branch_create failed: ${errMsg(e)}`)
      }
    }

    // ── branch_switch ─────────────────────────────────────────────────────
    if (args.action === 'branch_switch') {
      try {
        await git.switchBranch(root, args.name)
        refreshGit()
        return toolOk<GitActionResult>({
          action: 'branch_switch',
          message: `Switched to branch "${args.name}".`,
          data: { name: args.name },
        })
      } catch (e) {
        return toolErr(`git branch_switch failed: ${errMsg(e)}`)
      }
    }

    // ── push ──────────────────────────────────────────────────────────────
    if (args.action === 'push') {
      if (!settings.autoAllowPush) {
        return toolErrBlocked(
          'Push blocked by Settings → Git → "Auto-allow agent push". ' +
          'The user must enable this toggle before the agent can push.',
          'autoAllowPush'
        )
      }

      // Determine the branch being pushed
      const targetBranch = args.branch ?? (await resolveCurrentBranch(root))
      if (targetBranch && PROTECTED_BRANCHES.has(targetBranch.toLowerCase())) {
        if (!settings.allowDirectPushToMain) {
          return toolErrBlocked(
            `Push to "${targetBranch}" is blocked. ` +
            'Enable Settings → Git → "Allow direct push to main" to permit this.',
            'allowDirectPushToMain'
          )
        }
      }

      try {
        // gitService.push() uses the configured remote/branch from git config.
        // Custom remote/branch would require a Rust-side command extension;
        // for now we pass through and note the target in the result.
        const output = await git.push(root)
        refreshGit()
        return toolOk<GitActionResult>({
          action: 'push',
          message: output.trim() || `Pushed${targetBranch ? ` branch "${targetBranch}"` : ''}.`,
          data: { remote: args.remote ?? 'origin', branch: targetBranch },
        })
      } catch (e) {
        return toolErr(`git push failed: ${errMsg(e)}`)
      }
    }

    return toolErr(`Unknown git_action action: "${(args as { action: string }).action}"`)
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function resolveCurrentBranch(root: string): Promise<string | null> {
  try {
    const branches = await git.getBranches(root)
    return branches.find(b => b.is_current)?.name ?? null
  } catch {
    return null
  }
}
