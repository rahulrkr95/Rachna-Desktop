// lib/runConfigDetector.ts
//
// "Detect with AI" for run configurations.
//
// Flow:
//   1. List the project root (non-recursive) and pick out well-known
//      manifest/build files (package.json, requirements.txt, Cargo.toml, …).
//   2. Read a capped number of them (capped size each) via the `read_file`
//      Tauri command — the same one the editor uses.
//   3. Send their contents to the user's currently active AI provider/model
//      (same selection as the chat panel — see store/useApiKeyStore.ts) with
//      a single, non-streaming-to-UI prompt asking for strict JSON back.
//   4. Parse + validate the JSON into a DetectedRunConfig.
//
// No new AI plumbing is introduced — this reuses the exact same
// `AIProvider.stream()` contract the chat panel uses, just with one
// throwaway user message and no tools.

import { invoke } from '@tauri-apps/api/core'
import { useApiKeyStore } from '../store/useApiKeyStore'
import { getProvider } from './providers/registry'
import type { EnvVarEntry } from './runConfig'
import { loggedStream } from './llmCallLogger'

export interface DetectedRunConfig {
  name: string
  buildCommand: string
  runCommand: string
  env: EnvVarEntry[]
  cwd: string | null
  /** Short human-readable explanation of what was detected and why. */
  notes: string
}

interface DirEntryInfo {
  name: string
  path: string
  is_dir: boolean
}

// Files worth reading when they're present at the project root — ordered
// roughly by how strongly they signal a runnable project. We stop once
// we've gathered MAX_FILES of these to keep the prompt small.
const CANDIDATE_FILENAMES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'CMakeLists.txt',
  'Makefile',
  'makefile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.env.example',
]

const MAX_FILES = 6
const MAX_CHARS_PER_FILE = 3000

async function gatherProjectFiles(projectRoot: string): Promise<Array<{ name: string; content: string }>> {
  let entries: DirEntryInfo[]
  try {
    entries = await invoke<DirEntryInfo[]>('list_directory', { path: projectRoot })
  } catch (err) {
    throw new Error(`Could not read project folder: ${err instanceof Error ? err.message : String(err)}`)
  }

  const byName = new Map(entries.filter(e => !e.is_dir).map(e => [e.name, e]))
  const matched = CANDIDATE_FILENAMES.map(name => byName.get(name)).filter((e): e is DirEntryInfo => !!e).slice(0, MAX_FILES)

  const files: Array<{ name: string; content: string }> = []
  for (const entry of matched) {
    try {
      const result = await invoke<{ content: string; kind: string }>('read_file', { path: entry.path })
      if (result.kind !== 'text') continue
      files.push({ name: entry.name, content: result.content.slice(0, MAX_CHARS_PER_FILE) })
    } catch {
      // Unreadable file — skip it rather than failing the whole detection.
    }
  }
  return files
}

function buildPrompt(projectFolderName: string, files: Array<{ name: string; content: string }>): string {
  const fileBlocks = files
    .map(f => `--- ${f.name} ---\n${f.content}`)
    .join('\n\n')

  return [
    `You are configuring how to build and run a software project named "${projectFolderName}".`,
    'Below are the contents of key manifest/build files found at the project root.',
    'Infer the correct build command, run command, and any environment variables the project needs.',
    '',
    fileBlocks || '(No recognizable manifest files were found at the project root.)',
    '',
    'Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly this shape:',
    '{',
    '  "name": string,           // short label for this run configuration, e.g. "Dev server"',
    '  "buildCommand": string,   // shell command to build the project, or "" if there is no build step',
    '  "runCommand": string,     // shell command to run/start the project, or "" if you cannot determine one',
    '  "env": [{"key": string, "value": string}],  // env vars the run command likely needs; use placeholder values like "<your-api-key>" for secrets, [] if none',
    '  "cwd": string | null,     // subdirectory (relative to project root) the commands should run from, or null for the project root',
    '  "notes": string           // one or two sentences explaining your reasoning',
    '}',
    'If you are not confident a command is correct, still provide your best guess and lower confidence explanation in "notes" rather than leaving fields empty.',
  ].join('\n')
}

function extractJson(text: string): string {
  const trimmed = text.trim()
  // Strip ```json ... ``` or ``` ... ``` fences if the model added them anyway.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  // Otherwise, take the substring between the first { and the last }.
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

/**
 * Runs AI-based detection of build/run/env config for `projectRoot`.
 * Throws with a user-facing message on any failure (no API key configured,
 * network error, unparsable response, etc).
 */
export async function detectRunConfigWithAI(projectRoot: string): Promise<DetectedRunConfig> {
  const keyStore = useApiKeyStore.getState()
  const providerId = keyStore.activeProviderId
  const provider = getProvider(providerId)
  if (!provider) {
    throw new Error('No AI provider is selected. Pick one in Settings first.')
  }

  const apiKey = keyStore.getActiveKey(providerId)?.value ?? ''
  if (!apiKey && providerId !== 'ollama' && providerId !== 'lmstudio') {
    throw new Error(`No API key configured for ${provider.displayName}. Add one in Settings first.`)
  }

  const model = keyStore.getSelectedModel(providerId) || keyStore.getModels(providerId)[0]?.id

  const projectFolderName = projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || projectRoot
  const files = await gatherProjectFiles(projectRoot)
  const prompt = buildPrompt(projectFolderName, files)

  let fullText = ''
  let streamError: Error | null = null
  await loggedStream(
    'run_config_detection',
    provider,
    apiKey,
    [{ role: 'user', content: prompt }],
    {
      onChunk: chunk => { fullText += chunk },
      onDone: text => { fullText = text },
      onError: err => { streamError = err },
    },
    { model, temperature: 0.1, maxOutputTokens: 800 },
  )

  if (streamError) {
    throw new Error(`AI request failed: ${(streamError as Error).message}`)
  }

  if (!fullText.trim()) {
    throw new Error('The AI model returned an empty response. Try again, or check your API key/model selection.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(fullText))
  } catch {
    throw new Error('Could not parse the AI response as JSON. Try again, or fill in the run configuration manually.')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The AI response was not a valid run configuration object.')
  }

  const p = parsed as Record<string, unknown>
  const env: EnvVarEntry[] = Array.isArray(p.env)
    ? p.env
        .filter((e): e is { key: unknown; value: unknown } => !!e && typeof e === 'object')
        .map(e => ({ key: String((e as any).key ?? ''), value: String((e as any).value ?? '') }))
        .filter(e => e.key.trim().length > 0)
    : []

  return {
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Detected config',
    buildCommand: typeof p.buildCommand === 'string' ? p.buildCommand.trim() : '',
    runCommand: typeof p.runCommand === 'string' ? p.runCommand.trim() : '',
    env,
    cwd: typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : null,
    notes: typeof p.notes === 'string' ? p.notes.trim() : '',
  }
}
