import { describe, expect, it } from 'vitest'
import { nextRun, parseSchedule, buildExecutionPrompt, fromAutomationJson } from '../automationScheduler'

describe('automation schedules', () => {
  const now = new Date('2026-08-02T10:00:00Z')
  it('extracts delayed and recurring schedules', () => {
    expect(parseSchedule('do this in 20 minutes', now)).toEqual({ type: 'once', runAt: '2026-08-02T10:20:00.000Z' })
    expect(parseSchedule('check every 2 hours', now)).toEqual({ type: 'interval', everyMs: 7_200_000 })
    expect(parseSchedule('remind me daily at 9am', now)).toMatchObject({ type: 'daily', time: '09:00' })
  })
  it('supports weekly, monthly, cron, and condition monitoring', () => {
    expect(parseSchedule('every monday at 3pm', now)).toMatchObject({ type: 'weekly', weekday: 1, time: '15:00' })
    expect(parseSchedule('monthly on the 4th', now)).toMatchObject({ type: 'monthly', day: 4 })
    expect(parseSchedule('cron: */5 * * * *', now)).toEqual({ type: 'cron', expression: '*/5 * * * *' })
    expect(parseSchedule('monitor the build and run when it becomes green', now).type).toBe('condition')
  })
  it('calculates cron occurrences', () => {
    expect(nextRun({ type: 'cron', expression: '*/15 * * * *' }, now)?.toISOString()).toBe('2026-08-02T10:15:00.000Z')
  })
})

describe('buildExecutionPrompt', () => {
  it('strips scheduling phrasing, leaving a self-contained task description', () => {
    expect(buildExecutionPrompt('remind me daily at 9am to check the CI build')).toBe('remind me to check the CI build')
    expect(buildExecutionPrompt('every monday at 3pm send the weekly report')).toBe('send the report')
    expect(buildExecutionPrompt('restart the dev server, cron: */5 * * * *')).toBe('restart the dev server')
    expect(buildExecutionPrompt('do this in 20 minutes: back up the project')).toBe('do this back up the project')
  })
  it('falls back to the trimmed original request when stripping leaves nothing', () => {
    expect(buildExecutionPrompt('  daily  ')).toBe('daily')
  })
})

describe('automation JSON shape', () => {
  it('round-trips the canonical { name, schedule, enabled, kind, steps } shape', () => {
    const spec = {
      name: 'Morning sync',
      schedule: { type: 'daily', time: '09:00' } as const,
      enabled: true,
      kind: 'no_ai' as const,
      steps: [{ executor: 'terminal' as const, command: 'git pull' }],
    }
    const parsed = fromAutomationJson(spec)
    expect(parsed.steps).toEqual(spec.steps)
    expect(parsed.enabled).toBe(true)
    expect(parsed.kind).toBe('no_ai')
  })
})
