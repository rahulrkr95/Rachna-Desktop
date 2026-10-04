export interface RecentDesignProject {
  manifestPath: string
  projectRoot: string
  projectName: string
  openedAt: number
}

const STORAGE_KEY = 'rachna:recent-design-projects:v1'
const MAX_RECENT_DESIGNS = 12

export function loadRecentDesignProjects(): RecentDesignProject[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is RecentDesignProject =>
      !!item && typeof item.manifestPath === 'string' &&
      typeof item.projectRoot === 'string' && typeof item.projectName === 'string' &&
      typeof item.openedAt === 'number',
    ).slice(0, MAX_RECENT_DESIGNS)
  } catch {
    return []
  }
}

export function rememberDesignProject(project: Omit<RecentDesignProject, 'openedAt'>): RecentDesignProject[] {
  const entry = { ...project, openedAt: Date.now() }
  const next = [entry, ...loadRecentDesignProjects().filter(item => item.manifestPath !== entry.manifestPath)]
    .slice(0, MAX_RECENT_DESIGNS)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Recent projects are a convenience; opening/saving must still work if
    // browser storage is unavailable or full.
  }
  return next
}
