// RFC 6749 §4.1.3 (authorization_code) + §6 (refresh_token) token endpoint.
// Accepts application/x-www-form-urlencoded (MCP connectors) and JSON.
// Public clients: PKCE proves possession, no client secret.
import { eq } from 'drizzle-orm'
import { schema, useNeon } from '~~/server/utils/neon'
import { mintApiToken } from '~~/server/utils/api-token'
import {
  consumeAuthCode,
  consumeRefreshToken,
  createRefreshToken,
  narrowScope,
  sha256base64url,
  setOAuthCors,
} from '~~/server/utils/oauth'

const ACCESS_TTL_SECONDS = 60 * 60 * 24 * 90   // 90 days

function oauthError(event: import('h3').H3Event, status: number, error: string, description: string) {
  setResponseStatus(event, status)
  return { error, error_description: description }
}

export default defineEventHandler(async (event) => {
  setOAuthCors(event)

  // readBody transparently parses urlencoded and JSON bodies into an object.
  const body = await readBody<Record<string, string>>(event).catch(() => null) || {}
  const grantType = body.grant_type

  // ----- authorization_code ---------------------------------------
  if (grantType === 'authorization_code') {
    const { code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri } = body
    if (!code || !codeVerifier || !clientId || !redirectUri) {
      return oauthError(event, 400, 'invalid_request', 'code, code_verifier, client_id and redirect_uri are required.')
    }

    const payload = await consumeAuthCode(code)
    if (!payload) {
      return oauthError(event, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.')
    }
    if (payload.clientId !== clientId) {
      return oauthError(event, 400, 'invalid_grant', 'client_id does not match the authorization code.')
    }
    if (payload.redirectUri !== redirectUri) {
      return oauthError(event, 400, 'invalid_grant', 'redirect_uri does not match the authorization code.')
    }

    // PKCE: challenge stored at authorize time must equal S256(verifier).
    const expected = await sha256base64url(codeVerifier)
    if (expected !== payload.codeChallenge) {
      return oauthError(event, 400, 'invalid_grant', 'PKCE verification failed.')
    }

    const db = useNeon()
    const [client] = await db
      .select({ name: schema.oauthClients.name })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId))
      .limit(1)
    const clientName = client?.name ?? 'MCP Client'

    const scope = payload.scope
    const { raw, id } = await mintApiToken({
      userId: payload.userId,
      name: `OAuth: ${clientName}`,
      scopes: scope.split(' ').filter(Boolean),
      clientInfo: { via: 'oauth', clientId, clientName },
      expiresInSeconds: ACCESS_TTL_SECONDS,
    })
    const refreshToken = await createRefreshToken({ userId: payload.userId, clientId, scope, apiTokenId: id })

    return {
      access_token: raw,
      token_type: 'bearer',
      expires_in: ACCESS_TTL_SECONDS,
      scope,
      refresh_token: refreshToken,
    }
  }

  // ----- refresh_token --------------------------------------------
  if (grantType === 'refresh_token') {
    const refreshTokenIn = body.refresh_token
    const clientId = body.client_id
    if (!refreshTokenIn) {
      return oauthError(event, 400, 'invalid_request', 'refresh_token is required.')
    }

    const payload = await consumeRefreshToken(refreshTokenIn)   // rotation: single-use
    if (!payload) {
      return oauthError(event, 400, 'invalid_grant', 'Refresh token is invalid, expired, or already used.')
    }
    if (clientId && clientId !== payload.clientId) {
      return oauthError(event, 400, 'invalid_grant', 'client_id does not match the refresh token.')
    }

    const db = useNeon()
    const [client] = await db
      .select({ name: schema.oauthClients.name })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, payload.clientId))
      .limit(1)
    const clientName = client?.name ?? 'MCP Client'

    // Narrowing only: a refresh must not widen the originally granted scope.
    const scope = narrowScope(body.scope, payload.scope)

    const { raw, id } = await mintApiToken({
      userId: payload.userId,
      name: `OAuth: ${clientName}`,
      scopes: scope.split(' ').filter(Boolean),
      clientInfo: { via: 'oauth', clientId: payload.clientId, clientName },
      expiresInSeconds: ACCESS_TTL_SECONDS,
    })
    const newRefresh = await createRefreshToken({ userId: payload.userId, clientId: payload.clientId, scope, apiTokenId: id })

    // Revoke the access token tied to the previous refresh — rotation should
    // invalidate the old credential pair.
    void db.update(schema.apiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiTokens.id, payload.apiTokenId))
      .catch((err) => { console.error('[oauth/token] failed to revoke rotated token', err) })

    return {
      access_token: raw,
      token_type: 'bearer',
      expires_in: ACCESS_TTL_SECONDS,
      scope,
      refresh_token: newRefresh,
    }
  }

  return oauthError(event, 400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType ?? '(none)'}.`)
})
