import '../../store/__tests__/_localStoragePolyfill'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadRecentDesignProjects, rememberDesignProject } from '../recentDesignProjects'

describe('recent design projects', () => {
  beforeEach(() => localStorage.clear())

  it('persists paths newest-first and moves a reopened project to the front', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(10).mockReturnValueOnce(20).mockReturnValueOnce(30)
    rememberDesignProject({ manifestPath: '/one/design.rachna_design', projectRoot: '/one', projectName: 'One' })
    rememberDesignProject({ manifestPath: '/two/design.rachna_design', projectRoot: '/two', projectName: 'Two' })
    rememberDesignProject({ manifestPath: '/one/design.rachna_design', projectRoot: '/one', projectName: 'One renamed' })

    expect(loadRecentDesignProjects()).toEqual([
      { manifestPath: '/one/design.rachna_design', projectRoot: '/one', projectName: 'One renamed', openedAt: 30 },
      { manifestPath: '/two/design.rachna_design', projectRoot: '/two', projectName: 'Two', openedAt: 20 },
    ])
    vi.restoreAllMocks()
  })

  it('ignores corrupt persisted data', () => {
    localStorage.setItem('rachna:recent-design-projects:v1', '{broken')
    expect(loadRecentDesignProjects()).toEqual([])
  })
})
