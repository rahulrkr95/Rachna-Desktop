// store/useIdeEntitlements.ts
//
// Centralized IDE capability derivation.
//
// This is the single place the UI and execution layers ask "is this harness
// feature available?". Components and services must consume
// `useIdeEntitlements()` / `selectIdeEntitlements()` / `deriveIdeEntitlements()`
// rather than implementing local access rules, so there is still exactly one
// switch to flip if a feature ever needs gating again.
//
// OPEN-SOURCE HARNESS: these capabilities run entirely on the user's own
// machine (AI-call inspector, action/permission configuration). They no
// longer depend on a Rachna account or plan — a Rachna account is only
// needed for Rachna Cloud AI itself (see store/useAuthStore.ts). So every
// capability is available, signed in or not. The account argument is kept in
// the signature so call sites don't change and server-driven gating can be
// reintroduced here, in one place, without touching any component.

import { useAuthStore, type UserInfo } from './useAuthStore'

export interface IdeEntitlements {
  canInspectAiCalls: boolean
  canConfigureActions: boolean
  canConfigurePermissions: boolean
}

const ALL_AVAILABLE: IdeEntitlements = {
  canInspectAiCalls: true,
  canConfigureActions: true,
  canConfigurePermissions: true,
}

/**
 * Pure derivation — no store dependency, so it's easy to unit test and to
 * reuse from non-React code paths (e.g. services/agent/AgentLoop.ts).
 */
export function deriveIdeEntitlements(_data?: UserInfo | null): IdeEntitlements {
  return ALL_AVAILABLE
}

/** Zustand selector form, for `useAuthStore(selectIdeEntitlements)`. */
export function selectIdeEntitlements(state: { userInfo: UserInfo | null }): IdeEntitlements {
  return deriveIdeEntitlements(state.userInfo)
}

/** Convenience hook — the entry point components should use. */
export function useIdeEntitlements(): IdeEntitlements {
  return useAuthStore(selectIdeEntitlements)
}
