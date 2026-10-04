// services/oauth/pkce.ts
//
// PKCE (Proof Key for Code Exchange, RFC 7636) helpers used by OAuthManager
// for every provider that supports it (all four built-ins do — see
// OAuthProviderRegistry). Pure Web Crypto, no dependencies: the Tauri
// webview exposes the same `crypto.subtle` / `crypto.getRandomValues` any
// modern browser does.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** A high-entropy, URL-safe random string — used for both the PKCE
 *  `code_verifier` (43–128 chars per RFC 7636 §4.1) and the OAuth `state`
 *  parameter (CSRF protection). 32 random bytes → 43 base64url chars. */
export function generateRandomString(): string {
  return base64UrlEncode(randomBytes(32))
}

/** Derives the S256 `code_challenge` from a `code_verifier` (RFC 7636 §4.2). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}
