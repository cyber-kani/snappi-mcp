// Path-suffixed variant of the protected-resource metadata. Some MCP clients
// request /.well-known/oauth-protected-resource/mcp (resource path appended)
// rather than the bare document. Returns the same JSON.
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
