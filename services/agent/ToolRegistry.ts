// services/agent/ToolRegistry.ts
// Central registry of all tools available to the agent.
// Adding a new tool: implement AgentTool and add it here — no other changes needed.

import type { AgentTool } from './types'
import type { ProviderFunctionDeclaration } from '../../lib/providers/types'
import { readFileTool } from './tools/readFileTool'
import { readLinesTool } from './tools/readLinesTool'
import { searchCodebaseTool, semanticSearchCodebaseTool } from './tools/searchCodebaseTool'
import { listDirectoryTool } from './tools/listDirectoryTool'
import { diagnosticsTool } from './tools/diagnosticsTool'
import {
  findDependenciesTool,
  findDependentsTool,
  traceImportChainTool,
  findComponentUsageTool,
  findHookUsageTool,
} from './tools/repoGraphTools'
import { proposeEditTool } from './tools/proposeEditTool'
import { batchProposeEditsTool } from './tools/batchProposeEditsTool'
import { createFileTool, renameFileTool, deleteFileTool } from './tools/fileOpTools'
import { copyFileTool, copyFolderTool, moveFolderTool, deleteFolderTool, createFolderTool } from './tools/folderOpTools'
import { terminalTool } from './tools/terminalTool'
import { curlTool } from './tools/curlTool'
import { browserCheckTool } from './tools/browserCheckTool'
import { webTaskTool } from './tools/webTaskTool'
import { webSearchTool } from './tools/webSearchTool'
import { stackOverflowSearchTool } from './tools/stackOverflowSearchTool'
import { packageChangelogTool } from './tools/packageChangelogTool'
import { manageTodosTool } from './tools/todoTool'
import { gitActionTool } from './tools/gitAgentTool'
import { getRepoOverviewTool } from './tools/repoOverviewTool'
import { grepCodebaseTool } from './tools/grepCodebaseTool'
import { skipVerificationTool } from './tools/verificationTools'
import { desktopTaskTool } from './tools/desktopTaskTool'
import { openDefaultBrowserTool } from './tools/openDefaultBrowserTool'
import {
  openInOsExplorerTool,
  openFileTool,
  openAppTool,
  focusAppTool,
  closeAppTool,
  listRunningAppsTool,
  killProcessTool,
  openUrlTool,
  moveWindowTool,
  resizeWindowTool,
  minimizeWindowTool,
  maximizeWindowTool,
  listOpenWindowsTool,
  openProjectFolderTool,
} from './tools/desktopControlTools'
import { takeScreenshotTool } from './tools/screenshotTool'
import { mouseClickTool, mouseDragPathTool, pressKeyTool, pressKeySequenceTool, typeLinkInBrowserTool } from './tools/inputControlTools'
import { addFileToRequestTool } from './tools/addFileToRequestTool'
import { getSystemInfoTool, listFilesTool, searchFilesTool } from './tools/systemResearchTools'

export const toolRegistry: Record<string, AgentTool<any, any>> = {
  [getSystemInfoTool.declaration.name]:         getSystemInfoTool,
  [listFilesTool.declaration.name]:             listFilesTool,
  [searchFilesTool.declaration.name]:           searchFilesTool,
  [readFileTool.declaration.name]:             readFileTool,
  [readLinesTool.declaration.name]:            readLinesTool,
  [searchCodebaseTool.declaration.name]:       searchCodebaseTool,
  [semanticSearchCodebaseTool.declaration.name]: semanticSearchCodebaseTool,
  [listDirectoryTool.declaration.name]:        listDirectoryTool,
  [diagnosticsTool.declaration.name]:          diagnosticsTool,
  [findDependenciesTool.declaration.name]:     findDependenciesTool,
  [findDependentsTool.declaration.name]:       findDependentsTool,
  [traceImportChainTool.declaration.name]:     traceImportChainTool,
  [findComponentUsageTool.declaration.name]:   findComponentUsageTool,
  [findHookUsageTool.declaration.name]:        findHookUsageTool,
  [proposeEditTool.declaration.name]:          proposeEditTool,
  [batchProposeEditsTool.declaration.name]:    batchProposeEditsTool,
  [createFileTool.declaration.name]:           createFileTool,
  [renameFileTool.declaration.name]:           renameFileTool,
  [deleteFileTool.declaration.name]:           deleteFileTool,
  [copyFileTool.declaration.name]:             copyFileTool,
  [copyFolderTool.declaration.name]:           copyFolderTool,
  [moveFolderTool.declaration.name]:           moveFolderTool,
  [deleteFolderTool.declaration.name]:         deleteFolderTool,
  [createFolderTool.declaration.name]:         createFolderTool,
  [terminalTool.declaration.name]:             terminalTool,
  [curlTool.declaration.name]:                 curlTool,
  [browserCheckTool.declaration.name]:         browserCheckTool,
  [webTaskTool.declaration.name]:              webTaskTool,
  [webSearchTool.declaration.name]:            webSearchTool,
  [stackOverflowSearchTool.declaration.name]:  stackOverflowSearchTool,
  [packageChangelogTool.declaration.name]:     packageChangelogTool,
  [manageTodosTool.declaration.name]:          manageTodosTool,
  [gitActionTool.declaration.name]:            gitActionTool,
  [getRepoOverviewTool.declaration.name]:      getRepoOverviewTool,
  [grepCodebaseTool.declaration.name]:         grepCodebaseTool,
  [skipVerificationTool.declaration.name]:     skipVerificationTool,
  [desktopTaskTool.declaration.name]:           desktopTaskTool,
  [openDefaultBrowserTool.declaration.name]:   openDefaultBrowserTool,
  [openInOsExplorerTool.declaration.name]:     openInOsExplorerTool,
  [openFileTool.declaration.name]:             openFileTool,
  [openAppTool.declaration.name]:              openAppTool,
  [focusAppTool.declaration.name]:             focusAppTool,
  [closeAppTool.declaration.name]:              closeAppTool,
  [listRunningAppsTool.declaration.name]:      listRunningAppsTool,
  [killProcessTool.declaration.name]:          killProcessTool,
  [openUrlTool.declaration.name]:              openUrlTool,
  [moveWindowTool.declaration.name]:           moveWindowTool,
  [resizeWindowTool.declaration.name]:         resizeWindowTool,
  [minimizeWindowTool.declaration.name]:       minimizeWindowTool,
  [maximizeWindowTool.declaration.name]:       maximizeWindowTool,
  [listOpenWindowsTool.declaration.name]:      listOpenWindowsTool,
  [takeScreenshotTool.declaration.name]:       takeScreenshotTool,
  [mouseClickTool.declaration.name]:           mouseClickTool,
  [mouseDragPathTool.declaration.name]:        mouseDragPathTool,
  [pressKeyTool.declaration.name]:             pressKeyTool,
  [pressKeySequenceTool.declaration.name]:      pressKeySequenceTool,
  [typeLinkInBrowserTool.declaration.name]:     typeLinkInBrowserTool,
  [openProjectFolderTool.declaration.name]:    openProjectFolderTool,
  [addFileToRequestTool.declaration.name]:     addFileToRequestTool,
}

/**
 * Returns tool declarations in the provider-agnostic format.
 *
 * @param names — when provided, restricts the result to just these tool
 * names (unknown names are silently skipped, so a stale/renamed entry in a
 * mapping below never crashes a turn). When omitted, returns everything —
 * this is the fail-open default used whenever intent is unknown/ambiguous.
 */
export function getToolDeclarations(names?: readonly string[]): ProviderFunctionDeclaration[] {
  const source = names ? names.map(n => toolRegistry[n]).filter((t): t is AgentTool => !!t)
                       : Object.values(toolRegistry)
  return source.map(t => t.declaration as ProviderFunctionDeclaration)
}

export function getTool(name: string): AgentTool | undefined {
  return toolRegistry[name]
}


// ── Intent-scoped tool sets ──────────────────────────────────────────────────
//
// The (Intent, SubIntent) → allowed-tool-names mapping itself now lives in
// lib/intentRegistry.ts, paired there with the specialization prompt each
// (Intent, SubIntent) resolves to (see IntentRegistry's file header for why
// the two used to drift and why they're one table now). `getToolNamesForIntent`
// is re-exported here, unchanged in behavior, purely so existing call sites
// (services/agent/AgentLoop.ts, this module's own tests, etc.) don't need to
// import from two different places for tool declarations vs tool names.
export { getToolNamesForIntent } from '../../lib/intentRegistry'
