// lib/specialistMapping.ts
//
// Maps a user-selected SpecialistOption (store/useSpecialistStore.ts) onto
// the taxonomy lib/intentClassifier.ts / lib/intentRegistry.ts already
// understand. Two specialists — CHAT and AUTOMATION — never reach the Task
// Planner as a `TopIntent` at all (CHAT is answered directly; AUTOMATION
// schedules a job) so they're excluded from SPECIALIST_TOP_INTENT and
// handled as their own branches in useChat.ts::executeSend, exactly like
// the dedicated CHAT/AUTOMATION branches.
//
// The remaining five specialists resolve directly to the `topIntent` param
// already threaded through presentClarificationOrPlan → runIntentPlanner →
// generateExecutionPlan (lib/planGenerator.ts) — the SAME forced-topIntent
// mechanism the open-folder chip uses to force CODING_TASK. Once inside
// The Task Planner tags every step with its own (Intent,
// SubIntent), and lib/intentRegistry.ts resolves that pair to a narrow
// tool subset — so a DESKTOP specialist run never sees coding tools, a
// CODING specialist run never sees desktop-input-control tools, etc. This
// is the "don't send the whole tool block for an intent" narrowing the
// user asked for; it was already how AGENTIC-classified turns worked, this
// module just lets the specialist chip opt directly into it without a
// classification call.
import type { TopIntent } from './intentClassifier'
import type { SpecialistOption } from '../store/useSpecialistStore'

/** Every specialist that routes straight into the Task Planner. */
export type PlannableSpecialist = Exclude<SpecialistOption, 'CHAT' | 'AUTOMATION'>

export const SPECIALIST_TOP_INTENT: Record<PlannableSpecialist, Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>> = {
  CODING:  'CODING_TASK',
  DESIGN:  'DESIGN_TASK',
  DESKTOP: 'DESKTOP_TASK',
  MCP:     'MCP_TASK',
  BROWSER: 'BROWSER_TASK',
}

export function isPlannableSpecialist(specialist: SpecialistOption): specialist is PlannableSpecialist {
  return specialist !== 'CHAT' && specialist !== 'AUTOMATION'
}

/** Human-readable label + short description shown on each chip / tooltip. */
export const SPECIALIST_META: Record<SpecialistOption, { label: string; description: string; icon: string }> = {
  CODING:     { label: 'Coding',     description: 'Work with an open repo, or scaffold a new project',      icon: '</>' },
  DESIGN:     { label: 'Design',     description: 'Generate a new visual design/mockup project',             icon: '◨'  },
  DESKTOP:    { label: 'Desktop',    description: 'Local files, apps, system research, mouse/keyboard',       icon: '⌘'  },
  MCP:        { label: 'MCP',        description: 'Use a connected MCP service/connector',                    icon: '⧉'  },
  AUTOMATION: { label: 'Automation', description: 'Schedule a recurring/delayed/monitoring job',               icon: '⏱'  },
  BROWSER:    { label: 'Browser',    description: 'Headless public-web research or automation',                icon: '⌾'  },
  CHAT:       { label: 'Chat',       description: 'Plain conversation — no tools, no planning',                icon: '◌'  },
}
