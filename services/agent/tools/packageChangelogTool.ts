// services/agent/tools/packageChangelogTool.ts
//
// Tool: get_package_changelog
//
// Lets the agent check what actually changed in a dependency — most useful
// when it hits an API that "should" exist per its training data but doesn't
// (or behaves differently), which usually means the installed version is
// newer or older than what the model was trained on.
//
// Two independent lookups, either of which may be skipped depending on
// what's known about the package:
//   - npm registry (registry.npmjs.org/{name}) — latest version, deprecation
//     notices, and the repository URL, for any npm package.
//   - GitHub releases (api.github.com/repos/{owner}/{repo}/releases) — actual
//     changelog/release-notes text, when a GitHub repo is known (passed
//     explicitly as `githubRepo`, or auto-detected from the npm registry's
//     `repository` field).
//
// No auth token is sent to the GitHub API, so this is subject to GitHub's
// unauthenticated rate limit (60 req/hour per IP) — fine for occasional
// agent lookups, not for bulk use.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Types ───────────────────────────────────────────────────────────────────

export interface PackageChangelogArgs {
  /** npm package name, e.g. "zustand" or "@tauri-apps/api". Omit if not an npm package. */
  packageName?: string
  /** "owner/repo" on GitHub, e.g. "pmndrs/zustand". Auto-detected from npm metadata if omitted. */
  githubRepo?: string
  /**
   * Specific version to look up npm dist-tag info for, e.g. "5.0.0".
   * Optional — when omitted only "latest" is reported.
   */
  version?: string
  /** Max GitHub releases to return. Default 5, max 15. */
  maxReleases?: number
}

export interface NpmInfo {
  name: string
  latestVersion: string
  deprecated?: string
  repositoryUrl?: string
  homepage?: string
}

export interface ReleaseEntry {
  tag: string
  name: string
  publishedAt: string
  /** Release notes body, truncated. */
  body: string
}

export interface PackageChangelogResult {
  npm?: NpmInfo
  githubRepo?: string
  releases: ReleaseEntry[]
  note?: string
}

interface TauriHttpResult {
  status: number
  status_text: string
  headers: Record<string, string>
  body: string
  ok: boolean
  duration_ms: number
  timed_out: boolean
}

interface NpmRegistryResponse {
  name: string
  'dist-tags'?: { latest?: string }
  versions?: Record<string, { deprecated?: string }>
  repository?: { url?: string } | string
  homepage?: string
}

interface GithubRelease {
  tag_name: string
  name: string | null
  published_at: string
  body: string | null
  draft: boolean
  prerelease: boolean
}

const DEFAULT_MAX_RELEASES = 5
const HARD_MAX_RELEASES = 15

async function getJson<T>(
  url: string,
  headers?: Record<string, string>
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  let raw: TauriHttpResult
  try {
    raw = await invoke<TauriHttpResult>('run_http_request', {
      args: { url, method: 'GET', headers, timeout_seconds: 20 },
    })
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
  if (!raw.ok) {
    return { ok: false, status: raw.status, error: `${raw.status} ${raw.status_text}` }
  }
  try {
    return { ok: true, data: JSON.parse(raw.body) as T }
  } catch {
    return { ok: false, status: raw.status, error: 'Non-JSON response.' }
  }
}

/** Extracts "owner/repo" from npm's various `repository` field shapes. */
function parseGithubRepoFromNpm(repo: NpmRegistryResponse['repository']): string | undefined {
  const url = typeof repo === 'string' ? repo : repo?.url
  if (!url) return undefined
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?(?:[/?#]|$)/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

// ── Tool definition ─────────────────────────────────────────────────────────

export const packageChangelogTool: AgentTool<PackageChangelogArgs, PackageChangelogResult> = {
  declaration: {
    name: 'get_package_changelog',
    description:
      'Look up what changed in a dependency: latest npm version, deprecation status, and ' +
      'GitHub release notes/changelog. Use this when an API call to a third-party library ' +
      'doesn\'t match what you expect — the installed version is likely newer or older than ' +
      'your training data, and the changelog will show the actual breaking change or new ' +
      'API surface. Provide at least one of packageName (npm) or githubRepo ("owner/repo"); ' +
      'if only packageName is given, the GitHub repo is auto-detected from npm metadata when possible.',
    parameters: {
      type: 'object',
      properties: {
        packageName: {
          type: 'string',
          description: 'npm package name, e.g. "zustand" or "@tauri-apps/api".',
        },
        githubRepo: {
          type: 'string',
          description: 'GitHub repo as "owner/repo", e.g. "pmndrs/zustand". Optional.',
        },
        version: {
          type: 'string',
          description: 'Specific version of interest, e.g. "5.0.0". Optional, informational only.',
        },
        maxReleases: {
          type: 'number',
          description: `Max GitHub releases to return. Default ${DEFAULT_MAX_RELEASES}, max ${HARD_MAX_RELEASES}.`,
        },
      },
      required: [],
    },
  },

  describeCall: (args) =>
    `Checking changelog: ${args.packageName ?? args.githubRepo ?? '…'}`,

  execute: async (args, _ctx: ToolContext) => {
    const packageName = (args.packageName ?? '').trim()
    let githubRepo = (args.githubRepo ?? '').trim()

    if (!packageName && !githubRepo) {
      return toolErr('Provide at least one of packageName or githubRepo.')
    }

    const rawMax = typeof args.maxReleases === 'number' ? args.maxReleases : DEFAULT_MAX_RELEASES
    const maxReleases = Math.min(Math.max(1, rawMax), HARD_MAX_RELEASES)

    let npmInfo: NpmInfo | undefined
    const notes: string[] = []

    if (packageName) {
      const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}`
      const npmRes = await getJson<NpmRegistryResponse>(npmUrl)
      if (npmRes.ok) {
        const latest = npmRes.data['dist-tags']?.latest ?? 'unknown'
        const deprecated = latest && npmRes.data.versions?.[latest]?.deprecated
        npmInfo = {
          name: npmRes.data.name,
          latestVersion: latest,
          deprecated: deprecated || undefined,
          repositoryUrl:
            typeof npmRes.data.repository === 'string'
              ? npmRes.data.repository
              : npmRes.data.repository?.url,
          homepage: npmRes.data.homepage,
        }
        if (!githubRepo) {
          githubRepo = parseGithubRepoFromNpm(npmRes.data.repository) ?? ''
        }
      } else if (npmRes.status === 404) {
        notes.push(`"${packageName}" was not found on the npm registry.`)
      } else {
        notes.push(`npm registry lookup failed: ${npmRes.error}`)
      }
    }

    let releases: ReleaseEntry[] = []
    if (githubRepo) {
      const releasesUrl =
        `https://api.github.com/repos/${githubRepo}/releases?per_page=${maxReleases}`
      const relRes = await getJson<GithubRelease[]>(releasesUrl, {
        Accept: 'application/vnd.github+json',
      })
      if (relRes.ok) {
        releases = relRes.data
          .filter(r => !r.draft)
          .slice(0, maxReleases)
          .map(r => ({
            tag: r.tag_name,
            name: r.name ?? r.tag_name,
            publishedAt: r.published_at,
            body: (r.body ?? '(no release notes provided)').slice(0, 2000),
          }))
        if (releases.length === 0) {
          notes.push(`No published releases found for ${githubRepo} (repo may use tags without GitHub Releases).`)
        }
      } else {
        notes.push(`GitHub releases lookup for ${githubRepo} failed: ${relRes.error}`)
      }
    }

    if (!npmInfo && releases.length === 0 && notes.length > 0) {
      return toolErr(notes.join(' '))
    }

    return toolOk<PackageChangelogResult>({
      npm: npmInfo,
      githubRepo: githubRepo || undefined,
      releases,
      note: notes.length > 0 ? notes.join(' ') : undefined,
    })
  },
}
