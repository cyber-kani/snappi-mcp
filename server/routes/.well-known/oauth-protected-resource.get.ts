// RFC 9728 — OAuth 2.0 Protected Resource Metadata for the MCP endpoint.
import { resolveBaseUrl, setOAuthCors } from '~~/server/utils/oauth'

export default defineEventHandler((event) => {
  setOAuthCors(event)
  const base = resolveBaseUrl(event)
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
  }
})
