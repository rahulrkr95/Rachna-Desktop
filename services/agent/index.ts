// services/agent/index.ts
export { runAgentLoop } from './AgentLoop'
export type { AgentLoopCallbacks, AgentLoopOptions } from './AgentLoop'
export { getToolDeclarations, getTool, toolRegistry } from './ToolRegistry'
export { executeToolCall, executeToolCalls, clearEditQueue } from './ToolExecutor'
export type { ExecutedTool } from './ToolExecutor'
export type {
  AgentTool,
  AgentActivity,
  AgentActivityArtifact,
  ToolContext,
  ToolResult,
  ToolSuccess,
  ToolFailure,
  SystemInfo,
  DetectedOS,
  DetectedShell,
  // manage_todos
  TodoItem,
  TodoStatus,
  ManageTodosArgs,
  // git_action
  GitActionArgs,
  GitToolSettings,
  GitSettingKey,
} from './types'
export { DEFAULT_GIT_TOOL_SETTINGS, GIT_SETTING_LABELS } from './types'
export { manageTodosTool } from './tools/todoTool'
export { gitActionTool } from './tools/gitAgentTool'
export { setDiagnosticsProvider } from './tools/diagnosticsTool'
export type { DiagnosticsProvider, DiagnosticEntry } from './tools/diagnosticsTool'
export { getMcpToolDeclarations, executeMcpTool, getMcpToolsSection, isMcpToolName } from './mcpTools'
export {
  validateFileExists,
  validateFileDoesNotExist,
  validateResolvedFileExists,
} from './fileValidation'
export type { FileValidationResult, ValidatedFile, FileValidationFailure } from './fileValidation'
