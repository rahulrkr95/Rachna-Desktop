import { invoke } from '@tauri-apps/api/core'
import { listDirectory, type DirEntryInfo } from '../../../lib/tauriFs'
import { resolveSystemPath } from '../pathUtils'
import { toolErr, toolOk, type AgentTool, type ToolContext } from '../types'

export interface SystemInformation {
  os: { family: string; label: string; version: string | null; architecture: string }
  shell: { id: string; label: string }
  cpu: { brand: string; logicalCores: number; physicalCores: number | null }
  memory: { totalBytes: number; availableBytes: number }
  disks: Array<{ name: string; mountPoint: string; totalBytes: number; availableBytes: number; fileSystem: string }>
  network: Array<{ name: string; receivedBytes: number; transmittedBytes: number }>
  displays: unknown[]
  battery: unknown | null
  installedApplications: unknown[]
  unsupportedSections: string[]
}

export const getSystemInfoTool: AgentTool<Record<string, never>, SystemInformation> = {
  declaration: {
    name: 'get_system_info',
    description:
      'Get structured local OS and hardware information. Prefer this over terminal commands for OS, CPU, RAM, disks, displays, battery, network, and installed-application questions. Unsupported platform sections are reported explicitly.',
    parameters: { type: 'object', properties: {} },
  },
  describeCall: () => 'Inspecting system information…',
  execute: async () => {
    try {
      const raw = await invoke<Omit<SystemInformation, 'os' | 'shell'> & {
        os: string; shell: string; osInfo: SystemInformation['os']; shellInfo: SystemInformation['shell']
      }>('get_system_info')
      return toolOk({ ...raw, os: raw.osInfo, shell: raw.shellInfo })
    }
    catch (error) { return toolErr(error instanceof Error ? error.message : 'Failed to get system information.') }
  },
}

export interface ListFilesResult { path: string; entries: DirEntryInfo[] }
export const listFilesTool: AgentTool<{ path: string }, ListFilesResult> = {
  declaration: {
    name: 'list_files',
    description: 'List files and directories immediately inside a specified local path. Use search_files for recursive discovery.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path, or a path relative to the project/home directory.' } }, required: ['path'] },
  },
  describeCall: ({ path }) => `Listing ${path}…`,
  execute: async ({ path }, ctx: ToolContext) => {
    const resolved = await resolveSystemPath(path, ctx.projectRoot)
    if (!resolved.ok) return toolErr(resolved.error)
    try { return toolOk({ path: resolved.path, entries: await listDirectory(resolved.path) }) }
    catch (error) { return toolErr(error instanceof Error ? error.message : `Failed to list ${path}.`) }
  },
}

export interface SearchFilesResult { root: string; matches: Array<{ path: string; kind: 'file' | 'directory'; line?: number; excerpt?: string }>; truncated: boolean }
export const searchFilesTool: AgentTool<{ path: string; name?: string; content?: string; maxResults?: number }, SearchFilesResult> = {
  declaration: {
    name: 'search_files',
    description: 'Recursively search a specified directory by file/directory name and/or text-file content. At least one of name or content is required.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search.' },
        name: { type: 'string', description: 'Case-insensitive substring to match in names.' },
        content: { type: 'string', description: 'Case-insensitive text to find in file contents.' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default 100, maximum 500).' },
      },
      required: ['path'],
    },
  },
  describeCall: ({ path }) => `Searching files in ${path}…`,
  execute: async (args, ctx: ToolContext) => {
    if (!args.name?.trim() && !args.content?.trim()) return toolErr('Provide a name and/or content query.')
    const resolved = await resolveSystemPath(args.path, ctx.projectRoot)
    if (!resolved.ok) return toolErr(resolved.error)
    try {
      return toolOk(await invoke<SearchFilesResult>('search_files', {
        path: resolved.path, name: args.name?.trim() || null, content: args.content?.trim() || null,
        maxResults: Math.min(500, Math.max(1, args.maxResults ?? 100)),
      }))
    } catch (error) { return toolErr(error instanceof Error ? error.message : `Failed to search ${args.path}.`) }
  },
}
