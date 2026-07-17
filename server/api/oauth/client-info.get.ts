// Consent-page helper: look up a registered client by client_id and confirm
// whether a given redirect_uri is registered for it. Public (no auth) — only
// returns the display name; no secrets exist for these clients anyway.
import { eq } from 'drizzle-orm'
import { schema, useNeon } from '~~/server/utils/neon'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const clientId = typeof q.client_id === 'string' ? q.client_id : ''
  const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : ''
  if (!clientId) {
    setResponseStatus(event, 400)
    return { error: 'invalid_request', error_description: 'client_id is required.' }
  }

  const db = useNeon()
  const [client] = await db
    .select({ clientId: schema.oauthClients.clientId, name: schema.oauthClients.name, redirectUris: schema.oauthClients.redirectUris })
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId))
    .limit(1)

  if (!client) {
    setResponseStatus(event, 404)
    return { error: 'invalid_client', error_description: 'Unknown client_id.' }
  }

  const uris = Array.isArray(client.redirectUris) ? client.redirectUris as string[] : []
  const redirectValid = redirectUri ? uris.includes(redirectUri) : false

  return {
    client_id: client.clientId,
    client_name: client.name,
    redirect_uri_valid: redirectValid,
  }
})
