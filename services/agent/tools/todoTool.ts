// services/agent/tools/todoTool.ts
//
// Tool: manage_todos
//
// Lets the agent maintain a self-managed plan/task list backed by
// store/useTodoStore.ts. The TodoPanel renders live updates from the store;
// formatTodosForPrompt() re-injects the list into each system prompt so the
// model stays aware of its own plan without burning re-read tokens.
//
// Usage rules enforced here:
//   - "write"         — full-list replacement; validates unique ids and at
//                       most one "in_progress" item.
//   - "update_status" — single-item patch; refuses to create a second
//                       "in_progress" item if one already exists.
//   - "read"          — returns current list, useful for id recovery.

import { useTodoStore } from '../../../store/useTodoStore'
import {
  ManageTodosArgsSchema,
  toolOk,
  toolErr,
  type AgentTool,
  type ToolContext,
  type TodoItem,
} from '../types'

export interface ManageTodosResult {
  message: string
  todos: TodoItem[]
}

// ── Validators ───────────────────────────────────────────────────────────────

function validateUniqueIds(todos: TodoItem[]): string | null {
  const seen = new Set<string>()
  for (const t of todos) {
    if (seen.has(t.id)) return `Invalid plan: duplicate todo id "${t.id}".`
    seen.add(t.id)
  }
  return null
}

function validateSingleInProgress(todos: TodoItem[]): string | null {
  const inProgress = todos.filter(t => t.status === 'in_progress')
  if (inProgress.length > 1) {
    return (
      `Invalid plan: ${inProgress.length} items marked "in_progress" ` +
      `(${inProgress.map(t => t.id).join(', ')}). ` +
      'Exactly one item may be in_progress at a time.'
    )
  }
  return null
}

// ── Tool definition ──────────────────────────────────────────────────────────

export const manageTodosTool: AgentTool<Record<string, unknown>, ManageTodosResult> = {
  declaration: {
    name: 'manage_todos',
    description:
      'Manage your own plan/task list for the current multi-step job. ' +
      'REQUIRED: call action "write" with the FULL plan BEFORE starting any work ' +
      'with more than 2 steps — before reading files, before making edits. ' +
      'Rules: (1) exactly one item may be "in_progress" at a time; ' +
      '(2) mark items "completed" immediately after finishing — never batch at the end; ' +
      '(3) use action "read" to recover current ids if you are unsure. ' +
      'The list is displayed live to the user as a checklist.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'update_status', 'read'],
          description:
            '"write" replaces the full plan list; ' +
            '"update_status" patches one item\'s status by id; ' +
            '"read" returns the current list.',
        },
        todos: {
          type: 'array',
          description: 'Full plan for action "write". Each item must have id, content, status, activeForm.',
          items: {
            type: 'object',
            properties: {
              id:         { type: 'string', description: 'Short stable id, e.g. "1" or "add-lsp".' },
              content:    { type: 'string', description: 'Imperative task description.' },
              status:     { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', description: 'Present-continuous label shown while in_progress.' },
            },
            required: ['id', 'content', 'status', 'activeForm'],
          } as { type: string },
        },
        id:     { type: 'string', description: 'Todo id — required for action "update_status".' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'New status — required for action "update_status".',
        },
      },
      required: ['action'],
    },
  },

  describeCall: (args) => {
    if (args.action === 'write') {
      const n = Array.isArray(args.todos) ? args.todos.length : 0
      return `Writing plan (${n} step${n === 1 ? '' : 's'})…`
    }
    if (args.action === 'update_status') {
      return `Updating todo "${args.id ?? ''}" → ${args.status ?? ''}…`
    }
    if (args.action === 'read') return 'Reading current plan…'
    return 'Managing todos…'
  },

  execute: async (rawArgs, _ctx: ToolContext) => {
    const parsed = ManageTodosArgsSchema.safeParse(rawArgs)
    if (!parsed.success) {
      return toolErr(
        `Invalid manage_todos arguments: ${parsed.error.issues.map(i => i.message).join('; ')}`
      )
    }

    const args  = parsed.data
    const store = useTodoStore.getState()

    // ── write ────────────────────────────────────────────────────────────────
    if (args.action === 'write') {
      const uniqueErr = validateUniqueIds(args.todos)
      if (uniqueErr) return toolErr(uniqueErr)

      const singleErr = validateSingleInProgress(args.todos)
      if (singleErr) return toolErr(singleErr)

      store.setTodos(args.todos)
      return toolOk<ManageTodosResult>({
        message: `Plan saved with ${args.todos.length} step(s). Start working now — mark items in_progress/completed as you go.`,
        todos: args.todos,
      })
    }

    // ── update_status ────────────────────────────────────────────────────────
    if (args.action === 'update_status') {
      // Guard: refuse second simultaneous in_progress
      if (args.status === 'in_progress') {
        const other = store.todos.find(
          t => t.status === 'in_progress' && t.id !== args.id
        )
        if (other) {
          return toolErr(
            `Cannot mark "${args.id}" in_progress — "${other.id}" is already in_progress. ` +
            'Mark it completed (or pending) first.'
          )
        }
      }

      const result = store.updateStatus(args.id, args.status)
      if (!result.ok) return toolErr(result.error)

      return toolOk<ManageTodosResult>({
        message: `Todo "${args.id}" → ${args.status}.`,
        todos: useTodoStore.getState().todos,
      })
    }

    // ── read ─────────────────────────────────────────────────────────────────
    return toolOk<ManageTodosResult>({
      message: `${store.todos.length} todo(s) in current plan.`,
      todos: store.todos,
    })
  },
}
