// OAuth 2.1 authorization-server helpers for the Snappi MCP connector layer.
// (Extracted from Snappi's server/utils/oauth.ts — the in-app file also carries
// unrelated OAuth-client helpers for Google sign-in, omitted here.)

import { randomToken } from '~~/server/utils/auth'
// ==================================================================
// Snappi-as-authorization-server (MCP connector OAuth 2.1 layer)
//
// The helpers above make Snappi an OAuth *client* (of Google). Everything
// below makes Snappi an OAuth *provider* for MCP connectors (claude.ai /
// ChatGPT): public clients, PKCE S256 only, no client secret.
//
// KV storage (same Postgres-backed KV as sessions/magic links):
//   oauth_code:${sha256Hex(code)}       ttl 600s   single-use auth codes
//   oauth_refresh:${sha256Hex(token)}   ttl 90d    single-use refresh tokens (rotated)
// ==================================================================

import type { H3Event } from 'h3'
import { sha256Hex } from '~~/server/utils/auth'

// Canonical public issuer. Every metadata document must agree on this exact
// string, so we hard-code it and only deviate for localhost dev.
export const BASE = 'https://app.snappi.now'

// Resolve the issuer/base URL for a request. Production is always BASE; on
// localhost (dev) we honour the request host + scheme so metadata points back
// at the dev port the client actually hit.
export function resolveBaseUrl(event: H3Event): string {
  const host = (getRequestHeader(event, 'host') ?? '').toLowerCase()
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    const proto = getRequestHeader(event, 'x-forwarded-proto') || 'http'
    return `${proto}://${host}`
  }
  return BASE
}

// base64url (no padding) of SHA-256 digest of the ASCII verifier — the S256
// code_challenge per RFC 7636.
export async function sha256base64url(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', enc)
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const AUTH_CODE_TTL_SECONDS = 600
const OAUTH_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 90   // 90 days
const AUTH_CODE_BYTES = 32
const OAUTH_REFRESH_BYTES = 32

export type AuthCodePayload = {
  clientId: string
  userId: number
  email: string
  redirectUri: string
  codeChallenge: string
  scope: string
}

export async function createAuthCode(payload: AuthCodePayload): Promise<string> {
  const code = randomToken(AUTH_CODE_BYTES)
  const key = `oauth_code:${await sha256Hex(code)}`
  await useKV().set(key, payload, { ttl: AUTH_CODE_TTL_SECONDS })
  return code
}

export async function consumeAuthCode(code: string): Promise<AuthCodePayload | null> {
  if (!code) return null
  const key = `oauth_code:${await sha256Hex(code)}`
  const data = await useKV().get<AuthCodePayload>(key)
  if (!data) return null
  await useKV().del(key)   // single-use
  return data
}

export type OAuthRefreshPayload = {
  userId: number
  clientId: string
  scope: string
  apiTokenId: number
}

export async function createRefreshToken(payload: OAuthRefreshPayload): Promise<string> {
  const token = randomToken(OAUTH_REFRESH_BYTES)
  const key = `oauth_refresh:${await sha256Hex(token)}`
  await useKV().set(key, payload, { ttl: OAUTH_REFRESH_TTL_SECONDS })
  return token
}

export async function consumeRefreshToken(token: string): Promise<OAuthRefreshPayload | null> {
  if (!token) return null
  const key = `oauth_refresh:${await sha256Hex(token)}`
  const data = await useKV().get<OAuthRefreshPayload>(key)
  if (!data) return null
  await useKV().del(key)   // single-use — rotation on every refresh
  return data
}

export const OAUTH_SCOPES = ['read', 'write'] as const

// Intersect a requested scope string with the scopes we actually grant.
// Falls back to 'read write' when nothing valid was requested.
export function normalizeScope(requested: string | undefined | null): string {
  const parts = (requested ?? '').split(/\s+/).map(s => s.trim()).filter(Boolean)
  const granted = parts.filter(s => (OAUTH_SCOPES as readonly string[]).includes(s))
  return (granted.length ? granted : ['read', 'write']).join(' ')
}

// Refresh-time scope handling: a refresh MUST NOT widen the originally granted
// scope (RFC 6749 §6). If the client requests a scope, it is intersected with
// the previously granted scope (narrow-only). If it requests nothing, the
// previous scope is preserved verbatim. Never falls back to the full scope set.
export function narrowScope(
  requested: string | undefined | null,
  previous: string,
): string {
  const prev = previous.split(/\s+/).map(s => s.trim()).filter(Boolean)
  const prevValid = prev.filter(s => (OAUTH_SCOPES as readonly string[]).includes(s))
  const req = (requested ?? '').split(/\s+/).map(s => s.trim()).filter(Boolean)
  if (!req.length) return prevValid.join(' ')
  // Keep only requested scopes that were already granted — no widening.
  const narrowed = req.filter(s => prevValid.includes(s))
  return (narrowed.length ? narrowed : prevValid).join(' ')
}

// Permissive CORS for public OAuth endpoints (metadata / token / register)
// hit cross-origin by the connector's browser/agent.
export function setOAuthCors(event: H3Event) {
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  setResponseHeader(event, 'Access-Control-Allow-Headers', 'Content-Type, Authorization')
  setResponseHeader(event, 'Access-Control-Max-Age', 86400)
}

// Redirect URI must be a parseable URL, and either https: or a loopback http
// URL (localhost / 127.0.0.1). Everything else is rejected.
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || !uri) return false
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
  return false
}
