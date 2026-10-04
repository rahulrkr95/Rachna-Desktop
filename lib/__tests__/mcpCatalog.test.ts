import { describe, expect, it } from 'vitest'
import { suggestMcpForRequest } from '../mcpCatalog'

describe('suggestMcpForRequest', () => {
  it.each([
    ['slack', 'Slack'],
    ['notion', 'Notion'],
    ['gdrive', 'Google Drive'],
    ['gmail', 'Gmail'],
    ['calendar', 'Google Calendar'],
    ['figma', 'Figma Remote'],
  ])('maps the %s service hint to its quickstart', (hint, quickstart) => {
    expect(suggestMcpForRequest('use my connected service', hint)?.quickstart).toBe(quickstart)
  })

  it('falls back to matching connector names in the request', () => {
    expect(suggestMcpForRequest('Find the launch brief in Google Drive')?.quickstart).toBe('Google Drive')
  })
})
