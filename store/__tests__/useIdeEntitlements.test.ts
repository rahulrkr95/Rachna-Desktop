// store/__tests__/useIdeEntitlements.test.ts
//
// The harness is open source: local features (AI-call inspector, action and
// permission configuration) must NOT depend on being signed in to a Rachna
// account — an account is only needed for Rachna Cloud AI. This pins that
// down so a signed-out user can never be locked out of a local capability.

import { describe, it, expect } from 'vitest'
import { deriveIdeEntitlements } from '../useIdeEntitlements'
import type { UserInfo } from '../useAuthStore'

describe('deriveIdeEntitlements — no account required', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare response with no capability fields', { email: 'a@b.c' } as UserInfo],
    ['a FREE plan', { email: 'a@b.c', plan: 'FREE', coins: 0 } as UserInfo],
    ['a PRO plan', { email: 'a@b.c', plan: 'PRO', coins: 100 } as UserInfo],
  ])('keeps every local capability available for %s', (_label, data) => {
    const e = deriveIdeEntitlements(data)
    expect(e.canInspectAiCalls).toBe(true)
    expect(e.canConfigureActions).toBe(true)
    expect(e.canConfigurePermissions).toBe(true)
  })
})
