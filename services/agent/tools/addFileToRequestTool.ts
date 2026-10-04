// services/agent/tools/addFileToRequestTool.ts
//
// Tool: add_file_to_request
// Attaches a non-text file (PDF, DOCX, XLSX, PPTX, image, audio, video, ZIP,
// etc.) on disk to the *next* LLM API request. Unlike read_file — which
// reads text content into the tool result for the model to reason over
// inline — this tool doesn't return the file's content to the model at all.
// It queues the file in lib/pendingAttachments.ts's module-level store,
// where AgentLoop.ts picks it up immediately before the next
// agentTurn()/stream() call, hands it to the active provider's
// mapFileAttachment() so it goes out in that provider's native attachment
// format, and clears the store once that request completes. Use this when
// the model needs a provider to natively ingest a binary document (e.g. to
// have Claude read a PDF's layout, or Gemini transcribe audio) rather than
// working from an extracted text summary.

import { readFile } from '../../../lib/tauriFs'
import { pendingAttachmentsStore } from '../../../lib/pendingAttachments'
import { validateFileExists } from '../fileValidation'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

export interface AddFileToRequestArgs {
  fileId: string
  fileName: string
  mimeType: string
  purpose?: string
}

export interface AddFileToRequestResult {
  fileId: string
  fileName: string
  mimeType: string
  size: number
  queued: true
}

/** Cap attachment size so a single huge file can't blow the request payload / memory. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024 // 20 MB

export const addFileToRequestTool: AgentTool<AddFileToRequestArgs, AddFileToRequestResult> = {
  declaration: {
    name: 'add_file_to_request',
    description:
      'Attach a non-text file (PDF, DOCX, XLSX, PPTX, image, audio, video, ZIP, etc.) from the ' +
      'open project to the next AI request, so the model provider can read it natively (rather ' +
      'than needing its content extracted into text first). Do NOT use this for plain text/code ' +
      'files — use read_file for those instead. The file is queued for exactly one upcoming ' +
      'request and is not returned in this tool\'s result. Providers that don\'t support native ' +
      'file attachments will simply ignore it.',
    parameters: {
      type: 'object',
      properties: {
        fileId: {
          type: 'string',
          description:
            'Path identifying the file to attach, e.g. "docs/spec.pdf" (relative to project root) or an absolute path.',
        },
        fileName: {
          type: 'string',
          description: 'Display name for the file, e.g. "spec.pdf".',
        },
        mimeType: {
          type: 'string',
          description: 'MIME type of the file, e.g. "application/pdf", "image/png", "audio/mpeg".',
        },
        purpose: {
          type: 'string',
          description: 'Optional short note on why this file is being attached, e.g. "reference doc for formatting".',
        },
      },
      required: ['fileId', 'fileName', 'mimeType'],
    },
  },

  describeCall: (args) => `Attaching ${args.fileName} to the next request…`,

  execute: async (args, ctx: ToolContext) => {
    const validated = await validateFileExists(args.fileId, ctx.projectRoot)
    if (!validated.ok) return toolErr(validated.error)

    let read: Awaited<ReturnType<typeof readFile>>
    try {
      read = await readFile(validated.path)
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to read file: ${args.fileId}`
      )
    }

    if (read.kind === 'text') {
      return toolErr(
        `"${args.fileName}" is a text file — use read_file to read its content directly instead of attaching it.`
      )
    }

    if (read.kind === 'binary' || !read.content) {
      return toolErr(
        `"${args.fileName}" could not be read for attachment (file too large or unsupported for inline attachment).`
      )
    }

    if (read.size > MAX_ATTACHMENT_BYTES) {
      return toolErr(
        `"${args.fileName}" is ${Math.round(read.size / 1024 / 1024)}MB, which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB attachment limit.`
      )
    }

    pendingAttachmentsStore.add({
      fileId: validated.path,
      fileName: args.fileName,
      mimeType: args.mimeType || read.mime,
      base64: read.content,
      size: read.size,
      purpose: args.purpose,
    })

    return toolOk<AddFileToRequestResult>({
      fileId: validated.path,
      fileName: args.fileName,
      mimeType: args.mimeType || read.mime,
      size: read.size,
      queued: true,
    })
  },
}
