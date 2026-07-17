// RFC 7591 — OAuth 2.0 Dynamic Client Registration. No auth required.
// MCP connectors register themselves here before starting the authorize flow.
// We only ever mint public clients (PKCE, token_endpoint_auth_method: none).
import { randomToken } from '~~/server/utils/auth'
import { schema, useNeon } from '~~/server/utils/neon'
import { isAllowedRedirectUri, setOAuthCors } from '~~/server/utils/oauth'
import { rateLimit, getClientIp } from '~~/server/utils/ratelimit'

export default defineEventHandler(async (event) => {
  setOAuthCors(event)

  // Light anti-abuse: 10 registrations/hour/IP.
  const ip = getClientIp(event)
  const rl = await rateLimit({ key: `oauth:register:ip:${ip}`, limit: 10, windowSeconds: 3600 })
  if (!rl.ok) {
    setResponseStatus(event, 429)
    setResponseHeader(event, 'Retry-After', rl.retryAfter)
    return { error: 'temporarily_unavailable', error_description: 'Too many registrations, slow down.' }
  }

  const body = await readBody<{ client_name?: string, redirect_uris?: unknown }>(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    setResponseStatus(event, 400)
    return { error: 'invalid_client_metadata', error_description: 'Missing or invalid JSON body.' }
  }

  const redirectUris = body.redirect_uris
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    setResponseStatus(event, 400)
    return { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array.' }
  }
  if (redirectUris.length > 10) {
    setResponseStatus(event, 400)
    return { error: 'invalid_redirect_uri', error_description: 'Too many redirect_uris.' }
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      setResponseStatus(event, 400)
      return {
        error: 'invalid_redirect_uri',
        error_description: 'Each redirect_uri must be https, or http on localhost/127.0.0.1.',
      }
    }
  }

  const clientName = typeof body.client_name === 'string' && body.client_name.trim()
    ? body.client_name.trim().slice(0, 200)
    : 'MCP Client'
  const clientId = 'snappi_client_' + randomToken(16)

  const db = useNeon()
  await db.insert(schema.oauthClients).values({
    clientId,
    clientSecretHash: null,   // public client — PKCE only
    name: clientName,
    redirectUris: redirectUris as string[],
  })

  setResponseStatus(event, 201)
  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }
})
