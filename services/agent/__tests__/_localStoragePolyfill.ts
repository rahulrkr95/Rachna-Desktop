// services/agent/__tests__/_localStoragePolyfill.ts
//
// vitest.config.ts runs tests under environment: 'node', which has no
// localStorage global. Several Zustand stores (useApiKeyStore, useMcpStore,
// useGitSettingsStore, ...) read localStorage eagerly at module-load time,
// so any test that transitively imports them needs this polyfilled BEFORE
// that import happens. ES module imports are hoisted and run in source
// order ahead of any other top-level code, so importing this file first
// (as a side effect) guarantees the polyfill is installed before later
// imports in the same test file are evaluated.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem:    (k: string) => store.get(k) ?? null,
    setItem:    (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear:      () => { store.clear() },
    key:        (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
}
