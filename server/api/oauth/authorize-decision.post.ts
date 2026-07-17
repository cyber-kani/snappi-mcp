// The consent page POSTs here when the user clicks "Authorize". Requires a
// live Snappi session. Re-validates the client + redirect_uri + PKCE challenge
// server-side (never trust the page), mints a single-use auth code, and returns
// the redirect URL for the browser to follow back to the connector.
import { eq } from 'drizzle-orm'
import { readSession, SESSION_COOKIE } from '~~/server/utils/auth'
import { schema, useNeon } from '~~/server/utils/neon'
import { createAuthCode, normalizeScope } from '~~/server/utils/oauth'

export default defineEventHandler(async (event) => {
  const session = await readSession(getCookie(event, SESSION_COOKIE))
  if (!session) {
    setResponseStatus(event, 401)
    return { error: 'login_required', error_description: 'No active Snappi session.' }
  }

  const body = await readBody<{
    client_id?: string
    redirect_uri?: string
    state?: string
    code_challenge?: string
    code_challenge_method?: string
    scope?: string
  }>(event).catch(() => null)

  const clientId = body?.client_id
  const redirectUri = body?.redirect_uri
  const codeChallenge = body?.code_challenge
  const state = body?.state ?? ''

  if (!clientId || !redirectUri) {
    setResponseStatus(event, 400)
    return { error: 'invalid_request', error_description: 'client_id and redirect_uri are required.' }
  }
  if (!codeChallenge) {
    setResponseStatus(event, 400)
    return { error: 'invalid_request', error_description: 'code_challenge is required (PKCE S256).' }
  }
  if (body?.code_challenge_method && body.code_challenge_method !== 'S256') {
    setResponseStatus(event, 400)
    return { error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported.' }
  }

  const db = useNeon()
  const [client] = await db
    .select({ clientId: schema.oauthClients.clientId, name: schema.oauthClients.name, redirectUris: schema.oauthClients.redirectUris })
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId))
    .limit(1)

  if (!client) {
    setResponseStatus(event, 400)
    return { error: 'invalid_client', error_description: 'Unknown client_id.' }
  }

  const uris = Array.isArray(client.redirectUris) ? client.redirectUris as string[] : []
  if (!uris.includes(redirectUri)) {
    setResponseStatus(event, 400)
    return { error: 'invalid_request', error_description: 'redirect_uri does not match a registered URI.' }
  }

  const scope = normalizeScope(body?.scope)
  const code = await createAuthCode({
    clientId,
    userId: session.userId,
    email: session.email,
    redirectUri,
    codeChallenge,
    scope,
  })

  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  if (state) url.searchParams.set('state', state)

  return { redirect: url.toString() }
})
