// RFC 8414 — OAuth 2.0 Authorization Server Metadata.
// Fetched by MCP connectors (claude.ai / ChatGPT) to discover our endpoints.
import { resolveBaseUrl, setOAuthCors } from '~~/server/utils/oauth'

export default defineEventHandler((event) => {
  setOAuthCors(event)
  const base = resolveBaseUrl(event)
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['read', 'write'],
  }
})
