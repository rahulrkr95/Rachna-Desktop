// services/agent/tools/verificationTools.ts
//
// Tool: skip_verification
//
// Part of the enforced Agent Verification Loop (see ../verificationGate.ts).
// After any file-modifying tool call, AgentLoop.ts will not let the agent
// finalize its turn until a verification round has run for those changes.
// That round always runs — the agent cannot silently do nothing — but there
// are legitimate cases where actually executing build/lint/test is not
// warranted (e.g. a comment-only tweak the diagnostics step already proved
// harmless, or the user explicitly asked to skip checks for this change).
//
// This tool lets the agent request that skip, but the request is NOT a
// silent no-op: the verification gate still runs a round and records every
// step as 'skipped' with the reason attached, so the skip — and why — is
// always visible in the transcript. This satisfies "explicitly skipped with
// a valid reason" without letting the agent quietly opt out of the loop.

import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

export interface SkipVerificationArgs {
  reason: string
}

export interface SkipVerificationResult {
  acknowledged: true
  reason: string
  message: string
}

export const skipVerificationTool: AgentTool<SkipVerificationArgs, SkipVerificationResult> = {
  declaration: {
    name: 'skip_verification',
    description:
      'Explicitly skip the automatic build/lint/test verification round for the files you just ' +
      'changed, with a reason. Use this ONLY when you are confident verification is unnecessary ' +
      '(e.g. a comment/whitespace-only change, or the user explicitly told you not to run checks). ' +
      'This does NOT silently skip verification — the verification report will still be generated ' +
      'and will show every step as "skipped" along with your reason, visible to the user. ' +
      'Do not call this to avoid dealing with a failure you already saw — that is a failed check ' +
      'that must be reported, not skipped.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why verification is unnecessary for the change(s) just made. Required and must be specific.',
        },
      },
      required: ['reason'],
    },
  },

  describeCall: (args) => `Skipping verification: ${args.reason ?? '(no reason given)'}…`,

  execute: async (args, _ctx: ToolContext) => {
    if (!args.reason || !args.reason.trim()) {
      return toolErr('`reason` is required and must explain why verification is unnecessary.')
    }

    return toolOk<SkipVerificationResult>({
      acknowledged: true,
      reason: args.reason.trim(),
      message:
        'Skip request recorded. The verification round will still run and will report every ' +
        'step as skipped with this reason attached — it is not hidden from the user.',
    })
  },
}
