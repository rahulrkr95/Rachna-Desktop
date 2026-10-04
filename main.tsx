import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
// Must run before any <MonacoEditor>/<Editor> mounts — configures Monaco to
// load from the local bundle instead of a CDN (see lib/monacoSetup.ts for
// why the CDN loader hangs forever under this app's CSP).
import './lib/monacoSetup'
import { bootstrapKeyValidation, hydrateKeyValuesFromKeychain } from './store/useApiKeyStore'

// On startup: pull secret values out of the OS keychain into memory, then
// validate any stored keys and fetch their model lists.
hydrateKeyValuesFromKeychain().finally(() => bootstrapKeyValidation())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
